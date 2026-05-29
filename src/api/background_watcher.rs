//! Background bash watcher.
//!
//! ## Why this module exists
//!
//! Claude Code's `Bash(run_in_background: true)` promises "you will be
//! notified when it completes". In interactive TUI mode the runtime
//! injects a completion notification at the start of the next assistant
//! turn. Our `claudecode` backend runs the CLI in `--print` (`-p`)
//! headless mode — one assistant turn per user message — and the
//! runtime has no slot to inject the callback mid-stream. The
//! documented contract is structurally undeliverable in our setup, and
//! the agent's rational response (panic-retry the same command) creates
//! lock contention that stalls conversations.
//!
//! This watcher drives the missing callback. Every 10 minutes, for
//! each pending background bash in each mission, we:
//!
//!   1. Read the task's state from sidecar files written by the
//!      pod-side `bg-watchd` daemon (`<id>.ts`, `<id>.pid`,
//!      `<id>.complete`) plus a fresh `ps` of the recorded PID and
//!      a head+tail of the output file.
//!   2. Ask a sub-agent on the same model the main mission is using
//!      to classify the task as `STUCK / PROGRESSING / DONE`.
//!   3. On `DONE`: inject a `<system-reminder>` with the truncated
//!      output into the mission's existing FIFO queue via
//!      `ControlCommand::InjectSystemReminder`, drop the registration.
//!   4. On `STUCK`: inject a stall report; the main agent decides
//!      whether to `KillShell`. Watcher does NOT kill.
//!   5. On `PROGRESSING`: no-op, next tick in 10 min.
//!
//! No persistence — state lives in `Arc<RwLock<HashMap<...>>>` and is
//! lost on backend restart. The existing
//! `stuck_mission_watchdog_loop` has the same property; the agent's
//! next turn will see the dangling `.output` file naturally and the
//! daemon's sidecars will still be valid even if the in-memory
//! registration is gone.
//!
//! Disable with env `SANDBOXED_SH_DISABLE_BG_WATCHER=1` (the tick
//! loop never spawns; registrations still happen but go unused).
//! Retune cadence with `BG_WATCHER_INTERVAL_SECS=600`.

use anyhow::{Context as _, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::workspace::{SharedWorkspaceStore, Workspace};
use crate::workspace_exec::WorkspaceExec;

/// Caps for the output capture sent to the classifier and emitted on
/// `DONE`. 8 KB head + 8 KB tail = 16 KB total, plus a one-line marker
/// for the omitted middle. Enough for compile/install logs where the
/// classifier only cares about errors or the final summary; a 200 KB
/// `pnpm install` log can otherwise eat half the context window.
const OUTPUT_CAP_EACH: usize = 8 * 1024;

/// Tighter cap for the STUCK notification (only the tail matters).
const STUCK_TAIL_CAP: usize = 4 * 1024;

/// Per-mission classifier interval. Operator picked uniform 10 min.
const DEFAULT_INTERVAL_SECS: u64 = 600;

/// Sub-agent subprocess timeout — classifier replies are short; if a
/// single `claude --print` takes more than 60 s, something is wrong
/// and we'd rather skip the tick than block the whole watcher.
const CLASSIFIER_TIMEOUT_SECS: u64 = 60;

/// State recorded the moment Claude Code returns
/// `"Command running in background with ID: <id>"`.
#[derive(Debug, Clone)]
pub struct BgTask {
    pub shell_id: String,
    pub command: String,
    pub description: Option<String>,
    pub output_path: String,
    pub tool_use_id: String,
    pub started_at: DateTime<Utc>,
}

/// What the sub-agent classifier returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Done,
    Stuck,
    /// Healthy and still working — leave the agent alone.
    Progressing,
}

/// Mission-keyed in-memory registry of pending background tasks.
/// Clone-cheap (`Arc` inside).
#[derive(Debug, Clone, Default)]
pub struct SharedBackgroundWatcher {
    state: Arc<RwLock<HashMap<Uuid, Vec<BgTask>>>>,
}

/// Process-global handle to the live watcher. Set once at startup
/// (`install_global_watcher`); read by the claudecode stream interceptor
/// in `mission_runner::run_mission_turn` so registrations don't need to
/// be threaded through every per-turn argument. Cleared on backend
/// shutdown via `Drop` semantics is not implemented — the actor task
/// holding the watcher state outlives the lib.
static GLOBAL_WATCHER: tokio::sync::OnceCell<SharedBackgroundWatcher> =
    tokio::sync::OnceCell::const_new();

/// Install the process-global watcher handle. Idempotent — second
/// callers see the first watcher returned. Designed for the
/// once-per-process bootstrap path in `src/api/control.rs`.
pub fn install_global_watcher(watcher: SharedBackgroundWatcher) {
    if let Err(_existing) = GLOBAL_WATCHER.set(watcher) {
        tracing::debug!("bg-watcher global already installed; ignoring");
    }
}

/// Read the process-global watcher, if installed.
pub fn global_watcher() -> Option<SharedBackgroundWatcher> {
    GLOBAL_WATCHER.get().cloned()
}

impl SharedBackgroundWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, mission_id: Uuid, task: BgTask) {
        let mut guard = self.state.write().await;
        let entries = guard.entry(mission_id).or_default();
        // Idempotent: a duplicate ToolUse → ToolResult sequence (e.g.
        // from a re-played stream) shouldn't create a phantom task.
        if !entries.iter().any(|t| t.shell_id == task.shell_id) {
            entries.push(task);
        }
    }

    pub async fn remove(&self, mission_id: Uuid, shell_id: &str) {
        let mut guard = self.state.write().await;
        if let Some(entries) = guard.get_mut(&mission_id) {
            entries.retain(|t| t.shell_id != shell_id);
            if entries.is_empty() {
                guard.remove(&mission_id);
            }
        }
    }

    pub async fn list_for_mission(&self, mission_id: Uuid) -> Vec<BgTask> {
        self.state
            .read()
            .await
            .get(&mission_id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn snapshot(&self) -> HashMap<Uuid, Vec<BgTask>> {
        self.state.read().await.clone()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tool-use stream interception helpers (called from mission_runner)
// ─────────────────────────────────────────────────────────────────────────

/// Extract the shell ID from Claude Code's standard bg-bash result
/// string. Returns `None` if the content doesn't match the documented
/// format. The format is stable across 2.0.x and 2.1.x:
///
///   "Command running in background with ID: <id>. Output is being
///    written to: <path>. You will be notified when it completes."
pub fn parse_bg_tool_result(content: &str) -> Option<(String, String)> {
    let id_marker = "ID: ";
    let path_marker = "Output is being written to: ";
    let id_start = content.find(id_marker)? + id_marker.len();
    let id_rest = &content[id_start..];
    let id_end = id_rest
        .find('.')
        .or_else(|| id_rest.find(char::is_whitespace))?;
    let shell_id = id_rest[..id_end].trim().to_string();

    let path_start = content.find(path_marker)? + path_marker.len();
    let path_rest = &content[path_start..];
    let path_end = path_rest
        .find(".output")
        .map(|i| i + ".output".len())
        .or_else(|| path_rest.find('.'))?;
    let output_path = path_rest[..path_end].trim().to_string();

    if shell_id.is_empty() || output_path.is_empty() {
        return None;
    }
    Some((shell_id, output_path))
}

/// Is this a `Bash(run_in_background: true)` invocation? Robust to the
/// flag being a JSON bool, an int (some clients), or a "true" string.
pub fn is_run_in_background(input: &Value) -> bool {
    match input.get("run_in_background") {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(Value::String(s)) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1"),
        _ => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Truncation + formatting
// ─────────────────────────────────────────────────────────────────────────

/// Truncate `body` to `head_cap` + `tail_cap` bytes with a marker
/// describing the omitted middle. Returns `(rendered, omitted_bytes)`.
///
/// Cuts on a UTF-8 char boundary so the resulting `String` doesn't
/// panic when sliced; biases toward more head than tail when the cut
/// lands inside a multi-byte sequence.
pub fn truncate_head_tail(body: &str, head_cap: usize, tail_cap: usize) -> (String, usize) {
    if body.len() <= head_cap + tail_cap {
        return (body.to_string(), 0);
    }
    let head_end = floor_char_boundary(body, head_cap);
    let tail_start_target = body.len().saturating_sub(tail_cap);
    let tail_start = ceil_char_boundary(body, tail_start_target);
    let omitted = tail_start.saturating_sub(head_end);
    let mut out = String::with_capacity(head_end + tail_cap + 64);
    out.push_str(&body[..head_end]);
    out.push_str(&format!("\n<<< … omitted {omitted} bytes … >>>\n"));
    out.push_str(&body[tail_start..]);
    (out, omitted)
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Build the classifier prompt fed to the sub-agent.
#[allow(clippy::too_many_arguments)]
pub fn format_classifier_prompt(
    task: &BgTask,
    now: DateTime<Utc>,
    last_output_at: Option<DateTime<Utc>>,
    pid_stats: Option<&str>,
    is_complete: bool,
    output_head: &str,
    output_tail: &str,
    omitted: usize,
) -> String {
    let elapsed = format_duration(now - task.started_at);
    let last_output_age = last_output_at
        .map(|t| format_duration(now - t))
        .unwrap_or_else(|| "(no output yet)".to_string());
    let description = task.description.as_deref().unwrap_or("(no description)");
    let command_trimmed = truncate_head_tail(&task.command, 400, 0).0;
    let pid_block = pid_stats.unwrap_or("(no live ps stats — process may have exited)");
    let log_block = if omitted == 0 {
        output_head.to_string()
    } else {
        format!("{output_head}\n<<< … omitted {omitted} bytes … >>>\n{output_tail}")
    };

    format!(
        "You are a CI process classifier. Given the state of a single background \
         shell task, answer with EXACTLY one of these tokens (no prose):\n\
         \n\
           DONE         — the task has finished (with or without errors); the \
                          main agent should integrate its output now.\n\
           STUCK        — the task appears blocked (no output for many minutes, \
                          0%% CPU, in 'D' or 'S' wait state, or the same line \
                          repeated); the main agent should be told to inspect.\n\
           PROGRESSING  — the task is healthy and still working; do not \
                          interrupt the main agent.\n\
         \n\
         Respond with the single token only.\n\
         \n\
         --- Task ---\n\
         Description: {description}\n\
         Command: {command_trimmed}\n\
         Started: {started}\n\
         Now: {now}\n\
         Elapsed: {elapsed}\n\
         Last output: {last_output_age} ago\n\
         File <id>.complete present: {is_complete}\n\
         \n\
         --- Process ---\n\
         {pid_block}\n\
         \n\
         --- Output (head {head_kb} KB + tail {tail_kb} KB) ---\n\
         {log_block}\n",
        started = task.started_at.to_rfc3339(),
        now = now.to_rfc3339(),
        head_kb = OUTPUT_CAP_EACH / 1024,
        tail_kb = OUTPUT_CAP_EACH / 1024,
    )
}

/// Parse the classifier's reply. Anything we can't recognise is
/// conservatively treated as PROGRESSING — the watcher never acts on
/// noise.
pub fn parse_verdict(reply: &str) -> Verdict {
    let token = reply
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_alphabetic())
        .to_ascii_uppercase();
    match token.as_str() {
        "DONE" => Verdict::Done,
        "STUCK" => Verdict::Stuck,
        _ => Verdict::Progressing,
    }
}

/// Compose the `<system-reminder>` for a DONE verdict.
pub fn format_done_message(
    task: &BgTask,
    body: &str,
    omitted: usize,
    now: DateTime<Utc>,
) -> String {
    let (output, _) = truncate_head_tail(body, OUTPUT_CAP_EACH, OUTPUT_CAP_EACH);
    let description = task.description.as_deref().unwrap_or("(no description)");
    let duration = format_duration(now - task.started_at);
    let command = truncate_head_tail(&task.command, 200, 0).0;
    format!(
        "<system-reminder>\n\
         [bg-watcher] Background bash task '{description}' (shell id {sid}) finished.\n\
         \n\
         Command:\n  {command}\n\
         \n\
         Status: DONE\n\
         Started: {started}\n\
         Duration: {duration}\n\
         \n\
         Output ({total} bytes total; {omitted} bytes omitted in the middle):\n\
         {output}\n\
         </system-reminder>",
        sid = task.shell_id,
        started = task.started_at.to_rfc3339(),
        total = body.len(),
    )
}

/// Compose the `<system-reminder>` for a STUCK verdict.
pub fn format_stuck_message(
    task: &BgTask,
    output_tail: &str,
    pid_stats: Option<&str>,
    last_output_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> String {
    let description = task.description.as_deref().unwrap_or("(no description)");
    let command = truncate_head_tail(&task.command, 200, 0).0;
    let last_output_age = last_output_at
        .map(|t| format_duration(now - t))
        .unwrap_or_else(|| "(no output ever)".to_string());
    let (tail, _) = truncate_head_tail(output_tail, 0, STUCK_TAIL_CAP);
    let pid_block = pid_stats.unwrap_or("(no live ps stats — process may have exited)");
    format!(
        "<system-reminder>\n\
         [bg-watcher] Background bash task '{description}' (shell id {sid}) appears stuck.\n\
         \n\
         Command:\n  {command}\n\
         \n\
         Last output: {last_output_age} ago\n\
         {pid_block}\n\
         \n\
         Most-recent tail ({stuck_kb} KB):\n{tail}\n\
         \n\
         You should decide whether to KillShell on this task or let it run. \
         The watcher will not act on its own.\n\
         </system-reminder>",
        sid = task.shell_id,
        stuck_kb = STUCK_TAIL_CAP / 1024,
    )
}

fn format_duration(d: chrono::Duration) -> String {
    let secs = d.num_seconds().max(0);
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h {m}m {s}s")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tick loop + sub-agent invocation (entry point spawned at startup)
// ─────────────────────────────────────────────────────────────────────────

/// Bundle of context one tick needs: how to reach the actor (for
/// injection) and how to reach each mission's pod (for state reads +
/// sub-agent spawn).
#[derive(Clone)]
pub struct WatcherDeps {
    pub watcher: SharedBackgroundWatcher,
    pub cmd_tx: mpsc::Sender<crate::api::control::ControlCommand>,
    pub mission_store: Arc<dyn crate::api::mission_store::MissionStore>,
    pub workspaces: SharedWorkspaceStore,
}

/// Run the 10-minute classifier loop forever. Spawn from
/// `src/api/control.rs` startup, next to `stuck_mission_watchdog_loop`.
pub async fn tick_loop(deps: WatcherDeps) {
    if std::env::var("SANDBOXED_SH_DISABLE_BG_WATCHER").as_deref() == Ok("1") {
        tracing::info!("bg-watcher disabled by env (SANDBOXED_SH_DISABLE_BG_WATCHER=1)");
        return;
    }
    let interval_secs = std::env::var("BG_WATCHER_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_INTERVAL_SECS);
    tracing::info!(interval_secs, "bg-watcher tick loop started");

    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    // Skip the immediate first tick — most missions will have zero
    // pending tasks on startup and we don't want a useless burst.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        ticker.tick().await;
        run_one_tick(&deps).await;
    }
}

async fn run_one_tick(deps: &WatcherDeps) {
    let snapshot = deps.watcher.snapshot().await;
    if snapshot.is_empty() {
        tracing::debug!("bg-watcher tick: no pending tasks");
        return;
    }
    tracing::info!(
        missions = snapshot.len(),
        total_tasks = snapshot.values().map(|v| v.len()).sum::<usize>(),
        "bg-watcher tick start"
    );
    for (mission_id, tasks) in snapshot {
        for task in tasks {
            let deps = deps.clone();
            tokio::spawn(async move {
                if let Err(e) = process_one_task(&deps, mission_id, &task).await {
                    tracing::warn!(
                        mission_id = %mission_id,
                        shell_id = %task.shell_id,
                        error = %e,
                        "bg-watcher task processing failed"
                    );
                }
            });
        }
    }
}

async fn process_one_task(deps: &WatcherDeps, mission_id: Uuid, task: &BgTask) -> Result<()> {
    let mission = deps
        .mission_store
        .get_mission(mission_id)
        .await
        .map_err(|e| anyhow::anyhow!("mission_store.get_mission failed: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("mission no longer exists; dropping registration"))?;

    let workspace_id = mission.workspace_id;
    let workspace = deps
        .workspaces
        .get(workspace_id)
        .await
        .ok_or_else(|| anyhow::anyhow!("workspace {workspace_id} not in store"))?;

    let exec = WorkspaceExec::for_mission(workspace.clone(), mission_id);

    // Gather everything in a single shell so we pay one round-trip per task.
    let state = fetch_task_state(&exec, &workspace, task).await?;
    let now = Utc::now();

    let prompt = format_classifier_prompt(
        task,
        now,
        state.last_output_at,
        state.pid_stats.as_deref(),
        state.is_complete,
        &state.output_head,
        &state.output_tail,
        state.omitted_bytes,
    );

    let model = mission.model_override.clone().unwrap_or_default();
    let raw_reply = invoke_classifier(&exec, &workspace, &prompt, &model).await?;
    let verdict = parse_verdict(&raw_reply);
    tracing::info!(
        mission_id = %mission_id,
        shell_id = %task.shell_id,
        verdict = ?verdict,
        raw_reply_len = raw_reply.len(),
        "bg-watcher classifier verdict"
    );

    match verdict {
        Verdict::Done => {
            let full_body = format!("{}\n{}", state.output_head, state.output_tail);
            let msg = format_done_message(task, &full_body, state.omitted_bytes, now);
            send_inject(deps, mission_id, msg).await;
            deps.watcher.remove(mission_id, &task.shell_id).await;
        }
        Verdict::Stuck => {
            let msg = format_stuck_message(
                task,
                &state.output_tail,
                state.pid_stats.as_deref(),
                state.last_output_at,
                now,
            );
            send_inject(deps, mission_id, msg).await;
        }
        Verdict::Progressing => {}
    }
    Ok(())
}

/// What `fetch_task_state` returns.
struct TaskState {
    output_head: String,
    output_tail: String,
    omitted_bytes: usize,
    pid_stats: Option<String>,
    last_output_at: Option<DateTime<Utc>>,
    is_complete: bool,
}

async fn fetch_task_state(
    exec: &WorkspaceExec,
    _workspace: &Workspace,
    task: &BgTask,
) -> Result<TaskState> {
    let base = task.output_path.trim_end_matches(".output");
    let ts_path = format!("{base}.ts");
    let complete_path = format!("{base}.complete");
    let pid_path = format!("{base}.pid");
    // One heredoc bundles four reads + a stat; the magic markers let us
    // demux the outputs in Rust without piping each through its own
    // exec round-trip.
    let script = format!(
        r#"
set -u
echo "===HEAD==="
head -c {cap} {out} 2>/dev/null || true
echo
echo "===TAIL==="
tail -c {cap} {out} 2>/dev/null || true
echo
echo "===SIZE==="
stat -c %s {out} 2>/dev/null || echo 0
echo "===TS==="
tail -n 32 {ts} 2>/dev/null || true
echo "===COMPLETE==="
test -f {complete} && echo YES || echo NO
echo "===PS==="
pid=$(cat {pid} 2>/dev/null | head -n 1 | tr -d '[:space:]')
if [ -n "${{pid}}" ]; then
  ps -o pid,%cpu,%mem,rss,stat,etime -p "${{pid}}" 2>/dev/null || echo "(pid $pid no longer present)"
else
  echo "(no pid sidecar)"
fi
echo "===END==="
"#,
        cap = OUTPUT_CAP_EACH,
        out = task.output_path,
        ts = ts_path,
        complete = complete_path,
        pid = pid_path,
    );

    let cwd = std::path::Path::new("/tmp");
    let out = exec
        .output(cwd, "bash", &["-lc".into(), script], Default::default())
        .await
        .context("workspace_exec for fetch_task_state failed")?;
    let combined = String::from_utf8_lossy(&out.stdout).to_string();
    parse_state_blob(&combined, task)
}

fn parse_state_blob(blob: &str, task: &BgTask) -> Result<TaskState> {
    let head = extract_section(blob, "===HEAD===", "===TAIL===").unwrap_or_default();
    let tail = extract_section(blob, "===TAIL===", "===SIZE===").unwrap_or_default();
    let size_str = extract_section(blob, "===SIZE===", "===TS===").unwrap_or_default();
    let ts_section = extract_section(blob, "===TS===", "===COMPLETE===").unwrap_or_default();
    let complete_str = extract_section(blob, "===COMPLETE===", "===PS===").unwrap_or_default();
    let ps_section = extract_section(blob, "===PS===", "===END===").unwrap_or_default();

    let size: usize = size_str.trim().parse().unwrap_or(0);
    let last_output_at = ts_section
        .lines()
        .rev()
        .find_map(|l| {
            l.split_once('\t')
                .and_then(|(_, ts)| DateTime::parse_from_rfc3339(ts.trim()).ok())
        })
        .map(|dt| dt.with_timezone(&Utc));
    let is_complete = complete_str.trim().eq_ignore_ascii_case("YES");
    let pid_stats = {
        let trimmed = ps_section.trim();
        if trimmed.is_empty() || trimmed.starts_with('(') {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    let omitted_bytes = size.saturating_sub(head.len() + tail.len());
    let _ = task; // future: include description in trace
    Ok(TaskState {
        output_head: head,
        output_tail: tail,
        omitted_bytes,
        pid_stats,
        last_output_at,
        is_complete,
    })
}

fn extract_section(blob: &str, start_marker: &str, end_marker: &str) -> Option<String> {
    let start = blob.find(start_marker)? + start_marker.len();
    let end = blob[start..].find(end_marker)?;
    Some(blob[start..start + end].trim_matches('\n').to_string())
}

async fn invoke_classifier(
    exec: &WorkspaceExec,
    _workspace: &Workspace,
    prompt: &str,
    model: &str,
) -> Result<String> {
    let mut args: Vec<String> = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "text".to_string(),
        "-p".to_string(),
        prompt.to_string(),
    ];
    if !model.is_empty() {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    let cwd = std::path::Path::new("/tmp");
    let fut = exec.output(cwd, "claude", &args, Default::default());
    let out = tokio::time::timeout(Duration::from_secs(CLASSIFIER_TIMEOUT_SECS), fut)
        .await
        .map_err(|_| anyhow::anyhow!("classifier subprocess timed out"))?
        .context("classifier subprocess failed")?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn send_inject(deps: &WatcherDeps, mission_id: Uuid, content: String) {
    if let Err(e) = deps
        .cmd_tx
        .send(crate::api::control::ControlCommand::InjectSystemReminder {
            mission_id,
            content,
        })
        .await
    {
        tracing::warn!(mission_id = %mission_id, error = %e, "bg-watcher inject send failed");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_bg_tool_result() {
        let content = "Command running in background with ID: b34zlqmjb. \
                       Output is being written to: \
                       /tmp/claude-0/-workspaces/c74c8269/tasks/b34zlqmjb.output. \
                       You will be notified when it completes.";
        let (id, path) = parse_bg_tool_result(content).expect("should parse");
        assert_eq!(id, "b34zlqmjb");
        assert_eq!(
            path,
            "/tmp/claude-0/-workspaces/c74c8269/tasks/b34zlqmjb.output"
        );
    }

    #[test]
    fn parses_truthy_run_in_background_flag() {
        assert!(is_run_in_background(
            &serde_json::json!({"run_in_background": true})
        ));
        assert!(is_run_in_background(
            &serde_json::json!({"run_in_background": 1})
        ));
        assert!(is_run_in_background(
            &serde_json::json!({"run_in_background": "true"})
        ));
        assert!(!is_run_in_background(
            &serde_json::json!({"run_in_background": false})
        ));
        assert!(!is_run_in_background(&serde_json::json!({})));
    }

    #[test]
    fn parses_verdict_case_insensitively_with_noise() {
        assert_eq!(parse_verdict("DONE"), Verdict::Done);
        assert_eq!(parse_verdict("  stuck "), Verdict::Stuck);
        assert_eq!(parse_verdict("PROGRESSING\n"), Verdict::Progressing);
        assert_eq!(parse_verdict("**Done**"), Verdict::Done);
        assert_eq!(
            parse_verdict("I think the task is DONE"),
            Verdict::Progressing
        );
        assert_eq!(parse_verdict(""), Verdict::Progressing);
        assert_eq!(parse_verdict("garbage"), Verdict::Progressing);
    }

    #[test]
    fn truncates_with_marker_when_oversized() {
        let body = "a".repeat(100) + &"b".repeat(100);
        let (out, omitted) = truncate_head_tail(&body, 30, 30);
        assert!(out.starts_with(&"a".repeat(30)));
        assert!(out.ends_with(&"b".repeat(30)));
        assert!(out.contains("omitted"));
        assert_eq!(omitted, 140);
    }

    #[test]
    fn truncate_passthrough_when_within_cap() {
        let body = "short body";
        let (out, omitted) = truncate_head_tail(body, 100, 100);
        assert_eq!(out, body);
        assert_eq!(omitted, 0);
    }
}
