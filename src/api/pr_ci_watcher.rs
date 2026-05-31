//! PR-CI watcher.
//!
//! ## Why this module exists
//!
//! Same structural gap that motivated `background_watcher.rs`:
//! Claude Code's `--print` mode never gets the chance to deliver a
//! delayed completion notification to the agent. When a mission's
//! Bash invocation triggers a GitHub Actions run — via `gh pr
//! create`, `gh pr merge`, `gh run rerun`, `gh workflow run`, or a
//! plain `git push` — the bash returns in seconds, but CI keeps
//! churning for minutes. The agent either:
//!
//! - moves on and misses failures, or
//! - blocks the foreground turn on `gh run watch`, wasting context
//!   and minutes.
//!
//! ## What this watcher does
//!
//! - The claudecode stream interceptor in `mission_runner` parses
//!   each Bash ToolUse/ToolResult pair and, on a recognized CI
//!   trigger command, calls `spawn_watch_task` once the result
//!   has resolved a target (PR / Run / Commit).
//! - `spawn_watch_task` starts a single `tokio::spawn`'d worker per
//!   registration. That worker calls the same blocking
//!   `gh ... --watch` command the agent would have used (e.g.
//!   `gh run watch <id> --exit-status` or `gh pr checks <num>
//!   --watch`) inside the mission pod via `WorkspaceExec`, awaits
//!   its exit (capped at 2 h), composes a `<system-reminder>` with
//!   the verdict + check list + (on failure) failed-job log tail,
//!   and injects it into the mission's queue via the existing
//!   `ControlCommand::InjectSystemReminder` path.
//!
//! No tick loop. No polling. One backend-owned `gh ... --watch`
//! subprocess per registered CI task — the agent's shell is
//! prevented from running watch commands itself (see
//! `docker/workspace-base/bashenv.sh`'s `gh()` wrapper), so the
//! backend has the only watch in flight.
//!
//! ## Auth
//!
//! `gh` is already installed in the workspace-base image
//! (`docker/workspace-base/Dockerfile:70`) and inherits auth from
//! workspace env_vars (`GH_TOKEN` / `GITHUB_TOKEN`). If neither is
//! set, the watch task detects "not authenticated" on the first
//! invocation and injects a one-line reminder pointing at the env
//! var instead of looping silently.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::api::control::{AgentEvent, ControlCommand, MissionStatus};
use crate::api::mission_store::MissionStore;
use crate::workspace::{SharedWorkspaceStore, WorkspaceType};
use crate::workspace_exec::WorkspaceExec;

/// Hard cap on any single watch (default 2 h). Configurable via the
/// `PR_CI_WATCHER_MAX_SECS` env var.
const DEFAULT_MAX_WATCH_SECS: u64 = 2 * 60 * 60;

/// How many times to retry the run-id lookup when a `Commit` target
/// needs to be upgraded to a `Run` (GH Actions can take several
/// seconds after `git push` to schedule the workflow).
const COMMIT_RESOLVE_RETRIES: u32 = 12;
const COMMIT_RESOLVE_INTERVAL: Duration = Duration::from_secs(5);

/// Cap on the failed-job log tail we pull into the system-reminder.
const FAILED_LOG_CAP: usize = 8 * 1024;

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/// What command kicked off this CI registration. Used to drive
/// behaviour at registration time (parsing logic, target choice)
/// and labelled in the verdict reminder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiKind {
    PrCreate,
    PrMerge,
    RunDirect,
    Push,
}

impl CiKind {
    fn label(&self) -> &'static str {
        match self {
            Self::PrCreate => "gh pr create",
            Self::PrMerge => "gh pr merge",
            Self::RunDirect => "gh run rerun / gh workflow run",
            Self::Push => "git push",
        }
    }
}

/// What the watcher should poll. `Commit` is the only kind that
/// must be upgraded to `Run` before `gh run watch` can be invoked.
#[derive(Debug, Clone)]
pub enum CiTarget {
    Pr {
        owner: String,
        repo: String,
        number: u32,
    },
    Run {
        owner: String,
        repo: String,
        run_id: u64,
    },
    Commit {
        owner: String,
        repo: String,
        branch: String,
        sha: String,
    },
}

impl CiTarget {
    fn repo_owner(&self) -> (&str, &str) {
        match self {
            Self::Pr { owner, repo, .. }
            | Self::Run { owner, repo, .. }
            | Self::Commit { owner, repo, .. } => (owner, repo),
        }
    }

    fn human(&self) -> String {
        match self {
            Self::Pr {
                owner,
                repo,
                number,
            } => format!("PR #{number} in {owner}/{repo}"),
            Self::Run {
                owner,
                repo,
                run_id,
            } => format!("run {run_id} in {owner}/{repo}"),
            Self::Commit {
                owner,
                repo,
                branch,
                sha,
            } => {
                format!("{owner}/{repo}@{branch} ({})", &sha[..sha.len().min(8)])
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct CiTask {
    pub kind: CiKind,
    pub target: CiTarget,
    pub command: String,
    pub started_at: DateTime<Utc>,
    /// Tool-use id from the originating Bash tool call. Used as the
    /// registration key so duplicate replays don't double-register.
    pub tool_use_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct SharedPrCiWatcher {
    state: Arc<RwLock<HashMap<Uuid, Vec<CiTask>>>>,
}

impl SharedPrCiWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, mission_id: Uuid, task: CiTask) {
        let mut guard = self.state.write().await;
        let entries = guard.entry(mission_id).or_default();
        // Idempotent: dropping a duplicate ToolResult replay.
        if !entries.iter().any(|t| t.tool_use_id == task.tool_use_id) {
            entries.push(task);
        }
    }

    pub async fn remove(&self, mission_id: Uuid, tool_use_id: &str) {
        let mut guard = self.state.write().await;
        if let Some(entries) = guard.get_mut(&mission_id) {
            entries.retain(|t| t.tool_use_id != tool_use_id);
            if entries.is_empty() {
                guard.remove(&mission_id);
            }
        }
    }

    pub async fn snapshot(&self) -> HashMap<Uuid, Vec<CiTask>> {
        self.state.read().await.clone()
    }
}

#[derive(Clone)]
pub struct CiWatcherDeps {
    pub watcher: SharedPrCiWatcher,
    pub cmd_tx: mpsc::Sender<ControlCommand>,
    /// SSE broadcaster for live `MissionPrCiUpdate` events so the
    /// dashboard's pending-CI panel can render real-time progress
    /// while the `gh ... --watch` subprocess is still in flight.
    pub events_tx: broadcast::Sender<AgentEvent>,
    pub mission_store: Arc<dyn MissionStore>,
    pub workspaces: SharedWorkspaceStore,
}

// ─────────────────────────────────────────────────────────────────────────
// Process-global handle (set once at startup; read from mission_runner)
// ─────────────────────────────────────────────────────────────────────────

static GLOBAL_DEPS: tokio::sync::OnceCell<CiWatcherDeps> = tokio::sync::OnceCell::const_new();

/// Install the global deps. Called once from `control.rs` startup.
pub fn install_global_deps(deps: CiWatcherDeps) {
    if GLOBAL_DEPS.set(deps).is_err() {
        tracing::debug!("pr-ci-watcher global deps already installed; ignoring");
    }
}

/// Read the global deps, if installed. The mission_runner stream
/// interceptor uses this to register CI tasks without threading the
/// deps through its already-massive arg list.
pub fn global_deps() -> Option<CiWatcherDeps> {
    GLOBAL_DEPS.get().cloned()
}

// ─────────────────────────────────────────────────────────────────────────
// Detection / parsing (called from mission_runner)
// ─────────────────────────────────────────────────────────────────────────

/// Is the watcher enabled at all? Set
/// `SANDBOXED_SH_DISABLE_PR_CI_WATCHER=1` to turn it off. Read by
/// the mission_runner stream interceptor *before* calling
/// `detect_ci_invocation` so `detect_ci_invocation` stays pure
/// (no env reads, deterministic, unit-testable without env mutex).
pub fn watcher_enabled() -> bool {
    std::env::var("SANDBOXED_SH_DISABLE_PR_CI_WATCHER").as_deref() != Ok("1")
}

/// Is this command line a CI-trigger we should watch?
///
/// The detection splits the command on `;`, `&&`, `||`, and newline
/// (the bash sub-command separators) and checks each segment's
/// leading-trimmed prefix. That way a chained command like
/// `cd /tmp && git clone … && git push origin HEAD` still fires
/// the Push detection — the agent commonly emits chained one-shots,
/// and the previous "prefix-only" check missed every one of them.
///
/// We deliberately do NOT detect agent-side watch commands
/// (`gh run watch`, `gh pr checks --watch`, `gh actions watch`) —
/// those are hard-blocked by the bashenv `gh()` wrapper in the
/// workspace pod.
pub fn detect_ci_invocation(command: &str) -> Option<CiKind> {
    for segment in split_subcommands(command) {
        let trimmed = segment.trim_start();
        let starts_with_word = |hay: &str, prefix: &str| -> bool {
            if !hay.starts_with(prefix) {
                return false;
            }
            match hay.as_bytes().get(prefix.len()) {
                None => true,
                Some(b) => b.is_ascii_whitespace(),
            }
        };
        if starts_with_word(trimmed, "gh pr create") {
            return Some(CiKind::PrCreate);
        }
        if starts_with_word(trimmed, "gh pr merge") {
            return Some(CiKind::PrMerge);
        }
        if starts_with_word(trimmed, "gh run rerun") {
            return Some(CiKind::RunDirect);
        }
        if starts_with_word(trimmed, "gh workflow run") {
            return Some(CiKind::RunDirect);
        }
        if starts_with_word(trimmed, "git push") {
            // `git push --dry-run` doesn't trigger CI.
            if trimmed.contains("--dry-run") {
                continue;
            }
            return Some(CiKind::Push);
        }
    }
    None
}

/// Split a bash command line into segments on the shell operators
/// that separate independent commands (`;`, `&&`, `||`, newline).
/// Pipes (`|`) are NOT treated as separators — `something | grep …`
/// is one logical invocation.
///
/// Quoting is not respected: an `echo "git && push"` would be split
/// inside the quotes. Acceptable because the resulting segments
/// would still be examined against the strict prefix rule, and an
/// echo-prefixed segment never matches.
fn split_subcommands(command: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = command.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b';' || c == b'\n' {
            out.push(&command[start..i]);
            i += 1;
            start = i;
        } else if (c == b'&' || c == b'|') && bytes.get(i + 1) == Some(&c) {
            out.push(&command[start..i]);
            i += 2;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < bytes.len() {
        out.push(&command[start..]);
    }
    out
}

/// Extract a CI target from the Bash tool result for a given kind.
///
/// `PrMerge` and `Push` cannot be fully resolved from the tool
/// result alone (they need a follow-up `gh` lookup inside the pod
/// to derive owner/repo + merge commit / run id). For those we
/// return a partial target with the best info we have and let
/// `spawn_watch_task` finish the resolution at registration time.
pub fn parse_ci_target(kind: CiKind, content: &str) -> Option<CiTarget> {
    match kind {
        CiKind::PrCreate => parse_pr_url(content).map(|(owner, repo, number)| CiTarget::Pr {
            owner,
            repo,
            number,
        }),
        CiKind::PrMerge => {
            // Sometimes `gh pr merge` is invoked with just `<num>` —
            // no URL in the result. We can't synthesize a target
            // without the owner/repo lookup; defer until
            // spawn_watch_task does the `gh repo view` resolve.
            parse_pr_url(content).map(|(owner, repo, number)| CiTarget::Pr {
                owner,
                repo,
                number,
            })
        }
        CiKind::RunDirect => {
            parse_run_id_from_command_or_result(content).map(|(owner, repo, run_id)| {
                CiTarget::Run {
                    owner,
                    repo,
                    run_id,
                }
            })
        }
        CiKind::Push => parse_push_commit(content).map(|(branch, sha)| CiTarget::Commit {
            owner: String::new(),
            repo: String::new(),
            branch,
            sha,
        }),
    }
}

fn parse_pr_url(content: &str) -> Option<(String, String, u32)> {
    // Look for https://github.com/<owner>/<repo>/pull/<number>
    let needle = "https://github.com/";
    let idx = content.find(needle)?;
    let rest = &content[idx + needle.len()..];
    let mut parts = rest.split('/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if parts.next()? != "pull" {
        return None;
    }
    let num_str = parts.next()?;
    // Trim trailing punctuation / whitespace.
    let num_str = num_str
        .trim_end_matches(|c: char| !c.is_ascii_digit())
        .trim();
    let number: u32 = num_str.parse().ok()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo, number))
}

fn parse_run_id_from_command_or_result(content: &str) -> Option<(String, String, u64)> {
    // For `gh run rerun 1234567` the result body is usually short; for
    // `gh workflow run my-wf.yml` it doesn't print the run id at all.
    // We bias toward scraping the run id from a URL if present.
    let needle = "https://github.com/";
    if let Some(idx) = content.find(needle) {
        let rest = &content[idx + needle.len()..];
        let mut parts = rest.split('/');
        let owner = parts.next()?.to_string();
        let repo = parts.next()?.to_string();
        if parts.next()? == "actions" && parts.next()? == "runs" {
            let id_str = parts.next()?;
            let id_str = id_str
                .trim_end_matches(|c: char| !c.is_ascii_digit())
                .trim();
            let run_id: u64 = id_str.parse().ok()?;
            if !owner.is_empty() && !repo.is_empty() {
                return Some((owner, repo, run_id));
            }
        }
    }
    None
}

fn parse_push_commit(content: &str) -> Option<(String, String)> {
    // Look for `git push` summary lines. Several shapes appear in
    // the wild — handle all three:
    //   `   abc1234..def5678  main -> main`       (fast-forward)
    //   ` + def5678...abc1234 main -> main (forced update)`  (forced)
    //   ` * [new branch]      foo -> foo`         (first push)
    //   ` * [new tag]         v1.0.0 -> v1.0.0`   (tag push)
    //
    // For a fast-forward / forced push, the leading token gives the
    // new SHA after `..` / `...`. For a `[new branch]` push there's
    // no SHA in the line — we return the branch with sentinel SHA
    // `HEAD` and let `resolve_target` look up the latest run for
    // the branch (no commit filter).
    for line in content.lines() {
        let l = line.trim_start();
        if l.is_empty() {
            continue;
        }
        let arrow_idx = match l.split_whitespace().position(|p| p == "->") {
            Some(i) => i,
            None => continue,
        };
        let parts: Vec<&str> = l.split_whitespace().collect();
        let branch = match parts.get(arrow_idx + 1) {
            Some(b) => b.to_string(),
            None => continue,
        };
        if branch.is_empty() {
            continue;
        }
        // Skip tag pushes — CI only fires on branch refs in the
        // overwhelming majority of GH Actions workflows. (The
        // operator can still `gh run watch` directly.)
        if l.contains("[new tag]") {
            continue;
        }
        let range = parts[0];
        let sha = if let Some(idx) = range.rfind("...") {
            range[idx + 3..].to_string()
        } else if let Some(idx) = range.rfind("..") {
            range[idx + 2..].to_string()
        } else if l.contains("[new branch]") {
            // First push to a branch has no SHA in the summary
            // line — use HEAD as a sentinel. `resolve_target`
            // treats sha=="HEAD" as "drop the --commit filter and
            // look up the latest run for the branch".
            "HEAD".to_string()
        } else {
            continue;
        };
        if (sha != "HEAD" && sha.len() < 7) || branch.is_empty() {
            continue;
        }
        return Some((branch, sha));
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────
// Spawn a watch task (one per CI invocation)
// ─────────────────────────────────────────────────────────────────────────

/// Spawn a backend-owned `gh ... --watch` for `task`. Registers the
/// task in the watcher, runs the watch (capped at
/// `PR_CI_WATCHER_MAX_SECS`), injects a `<system-reminder>` with the
/// verdict, then drops the registration.
pub fn spawn_watch_task(deps: CiWatcherDeps, mission_id: Uuid, task: CiTask) {
    tokio::spawn(async move {
        let watcher = deps.watcher.clone();
        watcher.register(mission_id, task.clone()).await;
        let cap_secs = std::env::var("PR_CI_WATCHER_MAX_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(DEFAULT_MAX_WATCH_SECS);

        // Side-poll: a sibling task that polls the CI check rollup
        // every ~10 s and broadcasts a `MissionPrCiUpdate` SSE event
        // so the dashboard's pending-CI panel can render live
        // status while the main watch subprocess is still in
        // flight. CancellationToken is signalled when the main
        // watch returns so the poll loop exits in step.
        let poll_cancel = CancellationToken::new();
        let poll_handle = {
            let deps = deps.clone();
            let task = task.clone();
            let cancel = poll_cancel.clone();
            tokio::spawn(async move {
                run_status_poll_loop(deps, mission_id, task, cancel).await;
            })
        };

        let watch_outcome = tokio::time::timeout(
            Duration::from_secs(cap_secs),
            run_watch(&deps, mission_id, &task),
        )
        .await;
        // Cancel the side-poll once the main watch is done. The
        // poll loop's tokio::select! awaits cancel.cancelled() so
        // this is immediate.
        poll_cancel.cancel();
        let _ = poll_handle.await;

        let content = match &watch_outcome {
            Ok(Ok(report)) => format_completion(&task, report),
            Ok(Err(e)) => format_watcher_error(&task, &format!("{e:#}")),
            Err(_) => format_timeout(&task, cap_secs),
        };

        // Final SSE update — tell the dashboard panel to drop this
        // task. Status is `completed` for happy-path success,
        // `failed` for non-zero exit, `removed` for any other
        // terminal state (timeout, watcher error). The system-
        // reminder injection below carries the full body.
        let final_status = match &watch_outcome {
            Ok(Ok(rep)) if rep.exit_code == 0 => "completed",
            Ok(Ok(_)) => "failed",
            _ => "removed",
        };
        let _ = deps.events_tx.send(AgentEvent::MissionPrCiUpdate {
            mission_id,
            tool_use_id: task.tool_use_id.clone(),
            target: task.target.human(),
            status: final_status.to_string(),
            checks: vec![],
            url: None,
        });

        if let Err(e) = deps
            .cmd_tx
            .send(ControlCommand::InjectSystemReminder {
                mission_id,
                content,
            })
            .await
        {
            tracing::warn!(
                mission_id = %mission_id,
                tool_use_id = %task.tool_use_id,
                error = %e,
                "pr-ci-watcher: inject send failed"
            );
        }
        watcher.remove(mission_id, &task.tool_use_id).await;
    });
}

/// Sibling poll loop spawned alongside the main `gh ... --watch`
/// subprocess in `spawn_watch_task`. Fires every 10 s while the
/// watch is in flight, broadcasting `MissionPrCiUpdate` SSE events
/// with the current check rollup so the dashboard's pending-CI
/// panel renders live. Stops when the parent signals `cancel`.
async fn run_status_poll_loop(
    deps: CiWatcherDeps,
    mission_id: Uuid,
    task: CiTask,
    cancel: CancellationToken,
) {
    const POLL_INTERVAL: Duration = Duration::from_secs(10);
    // Emit an immediate "watching" event so the panel shows the row
    // as soon as the watch is spawned (before the first 10 s poll).
    let _ = deps.events_tx.send(AgentEvent::MissionPrCiUpdate {
        mission_id,
        tool_use_id: task.tool_use_id.clone(),
        target: task.target.human(),
        status: "watching".to_string(),
        checks: vec![],
        url: None,
    });
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
        // Skip the poll until the mission's workspace is still
        // active. `fetch_check_rollup` itself is resilient to a
        // missing pod / target — it just returns empty checks.
        let (checks, url) = fetch_check_rollup(&deps, mission_id, &task)
            .await
            .unwrap_or_else(|_| (vec![], None));
        let _ = deps.events_tx.send(AgentEvent::MissionPrCiUpdate {
            mission_id,
            tool_use_id: task.tool_use_id.clone(),
            target: task.target.human(),
            status: "watching".to_string(),
            checks,
            url,
        });
    }
}

/// One-shot `gh pr view --json statusCheckRollup,url` or
/// `gh run view --json jobs,conclusion,url` inside the mission
/// pod. Returns the parsed checks + the run URL. Used by the
/// poll loop above to feed the dashboard's live status panel.
async fn fetch_check_rollup(
    deps: &CiWatcherDeps,
    mission_id: Uuid,
    task: &CiTask,
) -> Result<(Vec<serde_json::Value>, Option<String>)> {
    let mission = deps
        .mission_store
        .get_mission(mission_id)
        .await
        .map_err(|e| anyhow!("mission_store.get_mission failed: {e}"))?
        .ok_or_else(|| anyhow!("mission not found"))?;
    let workspace = deps
        .workspaces
        .get(mission.workspace_id)
        .await
        .ok_or_else(|| anyhow!("workspace not in store"))?;
    if workspace.workspace_type != WorkspaceType::K8sPod {
        return Ok((vec![], None));
    }
    let exec = WorkspaceExec::for_mission(workspace, mission_id);
    type Parser = fn(&str) -> (Vec<serde_json::Value>, Option<String>);
    let (cmd, parser): (String, Parser) = match &task.target {
            CiTarget::Pr {
                owner,
                repo,
                number,
            } => (
                format!("gh pr view {number} --json statusCheckRollup,url -R {owner}/{repo} 2>&1"),
                parse_pr_rollup,
            ),
            CiTarget::Run {
                owner,
                repo,
                run_id,
            } => (
                format!(
                    "gh run view {run_id} --json jobs,conclusion,status,url -R {owner}/{repo} 2>&1"
                ),
                parse_run_jobs,
            ),
            CiTarget::Commit { .. } => {
                // Commit hasn't been resolved to a Run yet; the
                // panel just shows "watching" with no detail.
                return Ok((vec![], None));
            }
        };
    let out = exec
        .output(
            std::path::Path::new("/tmp"),
            "bash",
            &["-lc".to_string(), cmd],
            HashMap::new(),
        )
        .await
        .context("status poll exec failed")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parser(&stdout))
}

fn parse_pr_rollup(stdout: &str) -> (Vec<serde_json::Value>, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return (vec![], None);
    };
    let url = v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string());
    let rollup = v
        .get("statusCheckRollup")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    (rollup, url)
}

fn parse_run_jobs(stdout: &str) -> (Vec<serde_json::Value>, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return (vec![], None);
    };
    let url = v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string());
    let jobs = v
        .get("jobs")
        .and_then(|j| j.as_array())
        .cloned()
        .unwrap_or_default();
    (jobs, url)
}

#[derive(Debug)]
struct WatchReport {
    /// `gh ... --watch` exit code (0 = success, non-zero = failure).
    exit_code: i32,
    /// stdout from the watch — typically the check list as gh
    /// renders it for `gh pr checks --watch` or the run summary for
    /// `gh run watch --exit-status`.
    stdout: String,
    /// Truncated failed-job log (only populated on failure).
    failed_log_tail: Option<String>,
    /// Run id we actually watched (post-resolution).
    run_id: Option<u64>,
}

async fn run_watch(deps: &CiWatcherDeps, mission_id: Uuid, task: &CiTask) -> Result<WatchReport> {
    // Pre-flight: skip + drop if mission has left active.
    if !mission_active(deps.mission_store.as_ref(), mission_id).await {
        return Err(anyhow!("mission not in active state; dropping watch"));
    }

    let mission = deps
        .mission_store
        .get_mission(mission_id)
        .await
        .map_err(|e| anyhow!("mission_store.get_mission failed: {e}"))?
        .ok_or_else(|| anyhow!("mission not found"))?;

    let workspace = deps
        .workspaces
        .get(mission.workspace_id)
        .await
        .ok_or_else(|| anyhow!("workspace {} not in store", mission.workspace_id))?;

    // Only K8sPod missions have the `gh` workspace exec path used
    // here. nspawn / Host missions can fork a `gh` subprocess
    // locally, but this watcher's design assumes the per-mission
    // pod isolation.
    if workspace.workspace_type != WorkspaceType::K8sPod {
        return Err(anyhow!(
            "pr-ci-watcher only supports k8s_pod workspaces; got {:?}",
            workspace.workspace_type
        ));
    }

    let exec = WorkspaceExec::for_mission(workspace.clone(), mission_id);

    // 1. Resolve Push commit → Run (or owner/repo for the Push case).
    let resolved_target = resolve_target(&exec, &task.target).await?;

    // 2. Build the `gh ... --watch` command + pick a run id for
    //    the post-failure log pull.
    let (cmd, run_id_for_log) = match &resolved_target {
        CiTarget::Pr {
            owner,
            repo,
            number,
        } => {
            // `gh pr checks --watch` polls until all checks finish.
            // We pipe through `cat` to ensure non-tty buffering
            // doesn't stall.
            let c = format!(
                "gh pr checks {number} --watch -R {owner}/{repo} 2>&1; echo \"__EXIT__=$?\"",
            );
            (c, None)
        }
        CiTarget::Run {
            owner,
            repo,
            run_id,
        } => {
            let c = format!(
                "gh run watch {run_id} --exit-status -R {owner}/{repo} 2>&1; echo \"__EXIT__=$?\"",
            );
            (c, Some(*run_id))
        }
        CiTarget::Commit { .. } => {
            // resolve_target should have upgraded this to Run. If
            // we still see Commit it's an unresolvable target.
            return Err(anyhow!("commit target did not resolve to a run id"));
        }
    };

    let out = exec
        .output(
            std::path::Path::new("/tmp"),
            "bash",
            &["-lc".to_string(), cmd],
            HashMap::new(),
        )
        .await
        .context("workspace_exec for gh ... --watch failed")?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let exit_code = parse_exit_marker(&stdout).unwrap_or_else(|| out.status.code().unwrap_or(1));

    // 3. On failure, fetch the failed-job log tail.
    let failed_log_tail = if exit_code != 0 {
        if let Some(run_id) = run_id_for_log.or_else(|| {
            // For PR-checks failures gh exits non-zero but doesn't
            // give us a run id directly; scrape one from stdout.
            extract_run_id_from_text(&stdout)
        }) {
            let (owner, repo) = resolved_target.repo_owner();
            fetch_failed_log_tail(&exec, owner, repo, run_id).await.ok()
        } else {
            None
        }
    } else {
        None
    };

    let run_id = run_id_for_log.or_else(|| extract_run_id_from_text(&stdout));
    Ok(WatchReport {
        exit_code,
        stdout,
        failed_log_tail,
        run_id,
    })
}

async fn resolve_target(exec: &WorkspaceExec, target: &CiTarget) -> Result<CiTarget> {
    match target {
        CiTarget::Pr { .. } | CiTarget::Run { .. } => Ok(target.clone()),
        CiTarget::Commit {
            owner,
            repo,
            branch,
            sha,
        } => {
            // 1. If owner/repo are empty, look them up via gh repo view
            //    (Push case).
            let (owner, repo) = if owner.is_empty() || repo.is_empty() {
                let nwo = gh_repo_nwo(exec).await?;
                let mut parts = nwo.splitn(2, '/');
                let o = parts.next().unwrap_or("").to_string();
                let r = parts.next().unwrap_or("").to_string();
                if o.is_empty() || r.is_empty() {
                    return Err(anyhow!("gh repo view returned malformed name: {nwo}"));
                }
                (o, r)
            } else {
                (owner.clone(), repo.clone())
            };

            // 2. Poll `gh run list` until we find a databaseId, then
            //    upgrade to Run. For a `[new branch]` push,
            //    `parse_push_commit` returns sha="HEAD" as a
            //    sentinel — that case drops the --commit filter and
            //    just picks the latest run for the branch.
            for attempt in 0..COMMIT_RESOLVE_RETRIES {
                let cmd = if sha == "HEAD" {
                    format!(
                        "gh run list --branch {branch} --limit 1 \
                         --json databaseId -R {owner}/{repo} 2>&1",
                    )
                } else {
                    format!(
                        "gh run list --branch {branch} --commit {sha} --limit 1 \
                         --json databaseId -R {owner}/{repo} 2>&1",
                    )
                };
                let out = exec
                    .output(
                        std::path::Path::new("/tmp"),
                        "bash",
                        &["-lc".to_string(), cmd],
                        HashMap::new(),
                    )
                    .await;
                if let Ok(out) = out {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let parsed: Result<Value, _> = serde_json::from_str(stdout.trim());
                    if let Ok(Value::Array(arr)) = parsed {
                        if let Some(first) = arr.first() {
                            if let Some(run_id) = first.get("databaseId").and_then(|v| v.as_u64()) {
                                return Ok(CiTarget::Run {
                                    owner,
                                    repo,
                                    run_id,
                                });
                            }
                        }
                    }
                }
                if attempt + 1 < COMMIT_RESOLVE_RETRIES {
                    tokio::time::sleep(COMMIT_RESOLVE_INTERVAL).await;
                }
            }
            Err(anyhow!(
                "no run found for {owner}/{repo}@{branch} ({sha}) after {} retries",
                COMMIT_RESOLVE_RETRIES
            ))
        }
    }
}

async fn gh_repo_nwo(exec: &WorkspaceExec) -> Result<String> {
    let cmd = "gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1";
    let out = exec
        .output(
            std::path::Path::new("/tmp"),
            "bash",
            &["-lc".to_string(), cmd.to_string()],
            HashMap::new(),
        )
        .await
        .context("workspace_exec for gh repo view failed")?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.contains('/') {
        Ok(s)
    } else {
        Err(anyhow!("gh repo view returned: {s}"))
    }
}

async fn fetch_failed_log_tail(
    exec: &WorkspaceExec,
    owner: &str,
    repo: &str,
    run_id: u64,
) -> Result<String> {
    let cmd = format!(
        "gh run view {run_id} --log-failed -R {owner}/{repo} 2>&1 \
         | head -c {cap}",
        cap = FAILED_LOG_CAP,
    );
    let out = exec
        .output(
            std::path::Path::new("/tmp"),
            "bash",
            &["-lc".to_string(), cmd],
            HashMap::new(),
        )
        .await
        .context("workspace_exec for gh run view --log-failed failed")?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    if s.trim().is_empty() {
        Err(anyhow!("no failed-log output"))
    } else {
        Ok(s)
    }
}

async fn mission_active(store: &dyn MissionStore, mission_id: Uuid) -> bool {
    match store.get_mission(mission_id).await {
        Ok(Some(m)) => matches!(
            m.status,
            MissionStatus::Active | MissionStatus::AwaitingUser
        ),
        _ => false,
    }
}

fn parse_exit_marker(stdout: &str) -> Option<i32> {
    for line in stdout.lines().rev().take(8) {
        if let Some(rest) = line.trim().strip_prefix("__EXIT__=") {
            return rest.parse().ok();
        }
    }
    None
}

fn extract_run_id_from_text(s: &str) -> Option<u64> {
    // Best-effort scrape: look for `actions/runs/<digits>` anywhere.
    let needle = "/actions/runs/";
    let idx = s.find(needle)?;
    let rest = &s[idx + needle.len()..];
    let id_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if id_str.is_empty() {
        None
    } else {
        id_str.parse().ok()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// <system-reminder> bodies
// ─────────────────────────────────────────────────────────────────────────

fn format_completion(task: &CiTask, report: &WatchReport) -> String {
    let verdict = if report.exit_code == 0 {
        "SUCCESS"
    } else {
        "FAILURE"
    };
    let now = Utc::now();
    let elapsed = (now - task.started_at).num_seconds().max(0);
    let elapsed_str = format_elapsed(elapsed as u64);
    let target = task.target.human();
    let run_link = report.run_id.map(|id| {
        let (o, r) = task.target.repo_owner();
        format!("https://github.com/{o}/{r}/actions/runs/{id}")
    });

    let mut body = String::new();
    body.push_str("<system-reminder>\n");
    body.push_str(&format!(
        "[pr-ci-watcher] CI {verdict} for {target} (kicked off by `{cmd}`, elapsed {elapsed_str}).\n",
        cmd = task.kind.label(),
    ));
    if let Some(link) = run_link.as_ref() {
        body.push_str(&format!("Run: {link}\n"));
    }
    body.push('\n');
    let stdout_trimmed = trim_to(&report.stdout, 4096);
    if !stdout_trimmed.is_empty() {
        body.push_str("Check summary (from `gh ... --watch`):\n");
        body.push_str(&stdout_trimmed);
        if !stdout_trimmed.ends_with('\n') {
            body.push('\n');
        }
    }
    if report.exit_code != 0 {
        if let Some(log) = report.failed_log_tail.as_ref() {
            body.push_str("\nFailed-job log tail (truncated):\n");
            body.push_str(log);
            if !log.ends_with('\n') {
                body.push('\n');
            }
        }
        body.push_str(
            "\nAddress the failing job before merging. You don't need to \
             watch it again — fix and push, and the watcher will report the \
             next run.\n",
        );
    } else {
        body.push_str("\nAll checks passed.\n");
    }
    body.push_str("</system-reminder>");
    body
}

fn format_watcher_error(task: &CiTask, err: &str) -> String {
    let target = task.target.human();
    format!(
        "<system-reminder>\n\
         [pr-ci-watcher] could not watch {target} (kicked off by `{cmd}`).\n\
         Error: {err}\n\
         You may need to check the run manually (`gh run view <id>`). \
         GH_TOKEN / GITHUB_TOKEN must be set in the workspace env for \
         `gh` to authenticate.\n\
         </system-reminder>",
        cmd = task.kind.label(),
    )
}

fn format_timeout(task: &CiTask, cap_secs: u64) -> String {
    let target = task.target.human();
    let cap_str = format_elapsed(cap_secs);
    format!(
        "<system-reminder>\n\
         [pr-ci-watcher] watch on {target} (kicked off by `{cmd}`) hit the \
         {cap_str} cap and was abandoned. The CI run is still in flight or \
         was cancelled while we waited. Check `gh run view <id>` once \
         you've done other work.\n\
         </system-reminder>",
        cmd = task.kind.label(),
    )
}

fn trim_to(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let cut = floor_char_boundary(s, cap);
    let mut out = String::with_capacity(cut + 32);
    out.push_str(&s[..cut]);
    out.push_str("\n<<< … truncated … >>>\n");
    out
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn format_elapsed(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h {m:02}m {s:02}s")
    } else if m > 0 {
        format!("{m}m {s:02}s")
    } else {
        format!("{s}s")
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_gh_pr_create_word_boundary() {
        assert_eq!(
            detect_ci_invocation("gh pr create --draft"),
            Some(CiKind::PrCreate)
        );
        assert_eq!(
            detect_ci_invocation("  gh pr create"),
            Some(CiKind::PrCreate)
        );
        // Word-boundary: "gh pr created" must NOT match.
        assert_eq!(detect_ci_invocation("gh pr creator"), None);
        assert_eq!(detect_ci_invocation("gh pr create2"), None);
        // echo / wrappers around the literal don't match.
        assert_eq!(detect_ci_invocation("echo 'gh pr create'"), None);
    }

    #[test]
    fn detect_git_push_skips_dry_run() {
        assert_eq!(detect_ci_invocation("git push"), Some(CiKind::Push));
        assert_eq!(
            detect_ci_invocation("git push origin main"),
            Some(CiKind::Push)
        );
        assert_eq!(detect_ci_invocation("git push --dry-run"), None);
    }

    #[test]
    fn detect_chained_commands() {
        // The agent commonly emits chained one-shots — those must
        // still fire detection on the embedded trigger.
        assert_eq!(
            detect_ci_invocation("cd /tmp && git push origin HEAD"),
            Some(CiKind::Push)
        );
        assert_eq!(
            detect_ci_invocation(
                "cd /tmp && rm -rf sb && gh repo clone o/r sb && cd sb && git push -u origin HEAD"
            ),
            Some(CiKind::Push)
        );
        assert_eq!(
            detect_ci_invocation("git status; gh pr create --draft"),
            Some(CiKind::PrCreate)
        );
        // newline separator
        assert_eq!(
            detect_ci_invocation("git status\ngh workflow run my-wf.yml"),
            Some(CiKind::RunDirect)
        );
        // pipes are NOT separators — they're one logical command
        assert_eq!(
            detect_ci_invocation("echo foo | git push"),
            None,
            "pipes shouldn't be treated as sub-command boundaries"
        );
    }

    #[test]
    fn parses_pr_url_from_tool_result() {
        let content =
            "https://github.com/forgecart/sandboxed.sh/pull/123\nDraft pull request created.";
        let (o, r, n) = parse_pr_url(content).unwrap();
        assert_eq!(o, "forgecart");
        assert_eq!(r, "sandboxed.sh");
        assert_eq!(n, 123);
    }

    #[test]
    fn parses_git_push_summary() {
        // Real `git push` stderr shape:
        let content =
            "To github.com:forgecart/sandboxed.sh.git\n   abc1234..def5678  main -> main\n";
        let (branch, sha) = parse_push_commit(content).unwrap();
        assert_eq!(branch, "main");
        assert_eq!(sha, "def5678");
    }

    #[test]
    fn parses_git_push_forced() {
        let content = "   def5678...abc1234 main -> main (forced update)";
        let (branch, sha) = parse_push_commit(content).unwrap();
        assert_eq!(branch, "main");
        assert_eq!(sha, "abc1234");
    }

    #[test]
    fn parses_git_push_new_branch() {
        // First push to a brand-new branch: no SHA range, just
        // `[new branch]`. We return HEAD as a sentinel so
        // resolve_target falls back to branch-only lookup.
        let content = "To github.com:owner/repo.git\n * [new branch]      feat/foo -> feat/foo\n";
        let (branch, sha) = parse_push_commit(content).unwrap();
        assert_eq!(branch, "feat/foo");
        assert_eq!(sha, "HEAD");
    }

    #[test]
    fn skips_git_push_new_tag() {
        // Tag pushes don't trigger PR CI in practice — bypass.
        let content = "To github.com:owner/repo.git\n * [new tag]         v1.0.0 -> v1.0.0\n";
        assert_eq!(parse_push_commit(content), None);
    }

    #[test]
    fn extract_run_id_from_actions_url() {
        let s = "Run started: https://github.com/foo/bar/actions/runs/9876543210 (workflow.yml)";
        assert_eq!(extract_run_id_from_text(s), Some(9876543210));
    }

    #[test]
    fn parse_exit_marker_finds_trailing_marker() {
        let s = "watching...\nrun completed\n__EXIT__=0\n";
        assert_eq!(parse_exit_marker(s), Some(0));
        let s_fail = "watching...\nfailure\n__EXIT__=1\n";
        assert_eq!(parse_exit_marker(s_fail), Some(1));
    }
}
