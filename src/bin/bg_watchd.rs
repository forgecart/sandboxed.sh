//! `bg-watchd` — pod-side daemon that produces sidecar files for the
//! backend's background-bash watcher.
//!
//! ## Why this exists
//!
//! Claude Code's `Bash(run_in_background: true)` tool writes its output
//! to `~/.claude/projects/<...>/tasks/<id>.output` (or the equivalent
//! tasks dir inside the mission pod). In interactive TUI mode the runtime
//! injects a completion notification at the start of the next assistant
//! turn. In our backend's `--print` / `-p` headless mode that injection
//! point doesn't exist, so the agent never learns the task finished.
//!
//! This daemon doesn't try to fix that directly. It just enriches the
//! tasks dir with sidecar files the backend's per-mission tick loop
//! can read to ask its sub-agent classifier `STUCK / PROGRESSING /
//! DONE?`:
//!
//! - `<id>.ts`        — per-modify log: `"<file_size>\t<ISO8601>\n"`
//!                       appended each time the output file grows. Gives
//!                       the classifier our observed arrival timestamps
//!                       (we can't get the program's own wall-clock
//!                       timestamps without wrapping the command).
//! - `<id>.pid`       — single line: the Linux PID that owns the
//!                       output-file FD (via lsof on first create).
//!                       Backend uses this for `ps -o ...`.
//! - `<id>.complete`  — empty marker, touched on IN_CLOSE_WRITE of the
//!                       output file. Tells the classifier the process
//!                       has exited.
//!
//! The daemon holds no critical state — every observation is persisted
//! to disk immediately, so a crash + respawn loses at most one chunk's
//! arrival timestamp.
//!
//! ## Tasks-dir discovery
//!
//! Claude Code chooses its own tasks-dir path based on its working
//! directory (we saw e.g. `/tmp/claude-0/-workspaces/<wsid>/tasks/` in
//! the wild). Rather than hard-code that, the daemon globs every
//! configured search root for `**/tasks/` and attaches inotify
//! recursively. Roots default to `/tmp/claude-0` and `${HOME}/.claude`
//! but can be overridden by `BG_WATCHD_ROOTS` (colon-separated).
//!
//! When a tasks/ directory doesn't yet exist at startup, the daemon
//! also watches each root for IN_CREATE so it can attach as soon as
//! Claude Code creates the dir on the first background bash.

use anyhow::{Context as _, Result};
use chrono::Utc;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::channel;
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// Files we treat as "the output stream" — sidecars are written next to them.
const OUTPUT_SUFFIX: &str = ".output";

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("BG_WATCHD_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,bg_watchd=debug")),
        )
        .with_writer(std::io::stderr)
        .init();

    let roots = resolve_roots();
    info!(?roots, "bg-watchd starting");

    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(tx, Config::default().with_poll_interval(Duration::from_secs(2)))
        .context("Failed to construct inotify watcher")?;

    // Best-effort: ensure each root exists and is watched. Roots may not
    // exist yet on a freshly-booted pod (Claude Code creates them on
    // first run); we mkdir -p so the recursive watch attaches and any
    // future tasks/<id>.output writes get reported.
    let mut attached_roots = HashSet::new();
    for root in &roots {
        if let Err(e) = std::fs::create_dir_all(root) {
            warn!(root = %root.display(), error = %e, "cannot create root, skipping");
            continue;
        }
        match watcher.watch(root, RecursiveMode::Recursive) {
            Ok(()) => {
                attached_roots.insert(root.clone());
                info!(root = %root.display(), "watching");
            }
            Err(e) => warn!(root = %root.display(), error = %e, "failed to attach"),
        }
    }

    if attached_roots.is_empty() {
        warn!("no roots could be attached; daemon will idle. Crash so supervisord retries.");
        std::thread::sleep(Duration::from_secs(30));
        anyhow::bail!("no roots attached");
    }

    // Hot loop: forward filesystem events to the sidecar writer.
    loop {
        match rx.recv() {
            Ok(Ok(event)) => {
                if let Err(e) = handle_event(&event) {
                    debug!(error = %e, "sidecar write failed for event {:?}", event);
                }
            }
            Ok(Err(e)) => warn!(error = %e, "watcher emitted error"),
            Err(e) => {
                error!(error = %e, "watcher channel closed; exiting");
                return Err(e.into());
            }
        }
    }
}

fn resolve_roots() -> Vec<PathBuf> {
    if let Ok(env) = std::env::var("BG_WATCHD_ROOTS") {
        return env
            .split(':')
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
    }
    let mut out = vec![PathBuf::from("/tmp/claude-0")];
    if let Ok(home) = std::env::var("HOME") {
        out.push(PathBuf::from(home).join(".claude"));
    }
    out
}

fn handle_event(event: &Event) -> Result<()> {
    use EventKind::*;
    // Only files that look like background-task output streams matter.
    // Inside a tasks/ subdir, Claude Code writes <id>.output as the
    // canonical stream; everything else (skills/, plans/, etc.) is
    // out of scope.
    for path in &event.paths {
        let Some(stem) = output_stem(path) else { continue };
        let parent = match path.parent() {
            Some(p) => p,
            None => continue,
        };
        match event.kind {
            Create(_) => {
                on_create(parent, &stem, path);
            }
            Modify(_) | Access(_) => {
                on_modify(parent, &stem, path);
            }
            Remove(_) => {
                on_complete(parent, &stem);
            }
            _ => {}
        }
    }
    Ok(())
}

/// Returns the shell id (filename without `.output`) iff `path`
/// resolves to `<dir>/tasks/<id>.output`.
fn output_stem(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(OUTPUT_SUFFIX) {
        return None;
    }
    // Path must be inside a `tasks` directory (defensive: we attach
    // inotify recursively, so spurious paths under other subdirs would
    // otherwise leak sidecars where they don't belong).
    let in_tasks = path
        .components()
        .any(|c| c.as_os_str() == std::ffi::OsStr::new("tasks"));
    if !in_tasks {
        return None;
    }
    Some(name[..name.len() - OUTPUT_SUFFIX.len()].to_string())
}

fn on_create(parent: &Path, stem: &str, output_path: &Path) {
    let pid_path = parent.join(format!("{stem}.pid"));
    if pid_path.exists() {
        // Race / duplicate event; nothing to do.
        return;
    }
    match lsof_writer_pid(output_path) {
        Ok(Some(pid)) => {
            let _ = write_file(&pid_path, format!("{}\n", pid).as_bytes());
            info!(stem = %stem, pid = pid, "tracking new background task");
        }
        Ok(None) => {
            // The writer's already closed or lsof can't see it. Still
            // record an empty pid file so the backend knows we noticed
            // the task at all.
            let _ = write_file(&pid_path, b"");
            debug!(stem = %stem, "no writer pid found at create time");
        }
        Err(e) => warn!(stem = %stem, error = %e, "lsof failed"),
    }
    // Seed the timestamp log with an initial chunk-zero entry so the
    // classifier can compute elapsed-since-first-write.
    append_ts(parent, stem, 0);
}

fn on_modify(parent: &Path, stem: &str, output_path: &Path) {
    let size = match std::fs::metadata(output_path) {
        Ok(m) => m.len(),
        Err(e) => {
            debug!(stem = %stem, error = %e, "stat failed after modify");
            return;
        }
    };
    append_ts(parent, stem, size);
}

fn on_complete(parent: &Path, stem: &str) {
    let marker = parent.join(format!("{stem}.complete"));
    if marker.exists() {
        return;
    }
    let _ = write_file(&marker, b"");
    info!(stem = %stem, "background task complete");
}

fn append_ts(parent: &Path, stem: &str, size: u64) {
    let ts_path = parent.join(format!("{stem}.ts"));
    let now = Utc::now().to_rfc3339();
    let line = format!("{size}\t{now}\n");
    if let Err(e) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ts_path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
    {
        debug!(stem = %stem, error = %e, "ts append failed");
    }
}

fn write_file(path: &Path, contents: &[u8]) -> Result<()> {
    let mut f = File::create(path)?;
    f.write_all(contents)?;
    Ok(())
}

/// Use `lsof -t -- <path>` to find a process holding the file open
/// for write. Returns `Ok(None)` when no writer is currently attached.
fn lsof_writer_pid(path: &Path) -> Result<Option<u32>> {
    let out = Command::new("lsof")
        .args(["-t", "--"])
        .arg(path)
        .output();
    let out = match out {
        Ok(o) => o,
        // lsof may not be installed on minimal images; degrade gracefully.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !out.status.success() {
        return Ok(None);
    }
    let pid = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .and_then(|l| l.trim().parse::<u32>().ok());
    Ok(pid)
}
