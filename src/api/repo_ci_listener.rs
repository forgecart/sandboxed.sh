//! Repo CI listener.
//!
//! Replaces the older bash-stream-intercepting `pr_ci_watcher`.
//! Architecture:
//!
//! 1. Backend startup spawns one `run_loop` task per process.
//! 2. Every `REPO_CI_LISTENER_INTERVAL_SECS` (default 30 s), the
//!    loop calls `poll_once`.
//! 3. `poll_once` iterates every `MissionStatus::Active` mission
//!    running on a K8sPod workspace, and for each:
//!    a) `kubectl exec`s `ls -1d /workspaces/repos/*/` to find
//!    cloned repos.
//!    b) For each repo dir, runs `git remote get-url origin`,
//!    parses the URL into `(owner, repo)`.
//!    c) `gh run list -R owner/repo --json … --limit 10` enumerates
//!    the latest workflow runs for that repo.
//!    d) On the **first** poll for a given `(mission, owner, repo)`
//!    tuple, the cursor is initialised to the maximum
//!    `databaseId` returned and **no** reminders are emitted —
//!    this prevents flooding the agent with historical completions
//!    when a mission first comes online.
//!    e) For every later poll, any run with
//!    `status == "completed"` and `databaseId > cursor` is
//!    (1) broadcast as `AgentEvent::MissionPrCiUpdate` so the
//!    dashboard's panel can show it, and (2) injected into the
//!    mission's queue via `ControlCommand::InjectSystemReminder`
//!    so the agent's next turn sees the verdict.
//!
//! ## Why not webhook?
//!
//! Polling is dead simple: no public ingress, no secret rotation,
//! no replay handling. The latency cost (≤ 30 s) is acceptable for
//! the "got my CI verdict" use case and matches what
//! `gh run watch` polls at internally.
//!
//! ## Auth
//!
//! `gh` is already installed in the workspace-base image
//! (`docker/workspace-base/Dockerfile`) and inherits its token
//! from the workspace's env_vars (`GH_TOKEN` / `GITHUB_TOKEN`). If
//! neither is set, `gh run list` exits non-zero and the listener
//! simply skips the repo for that cycle (debug-logged, no
//! reminder).
//!
//! ## Why not store cursors in sqlite?
//!
//! Cursors are recoverable: on backend restart, the first poll
//! per repo just re-initialises from the live `gh run list`
//! result, dropping at most the (rare) history within that
//! restart window. Persisting them would add a schema migration
//! and a per-tick write for marginal benefit.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, Result};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::api::control::{AgentEvent, ControlCommand, MissionStatus};
use crate::api::mission_store::{Mission, MissionStore};
use crate::workspace::{SharedWorkspaceStore, WorkspaceType};
use crate::workspace_exec::WorkspaceExec;

/// Poll cadence default (env override: `REPO_CI_LISTENER_INTERVAL_SECS`).
const DEFAULT_POLL_INTERVAL_SECS: u64 = 30;
/// How many latest runs to inspect per repo per cycle.
const RUNS_PER_POLL: u32 = 10;
/// Cap on the failed-job log tail included in the system-reminder.
const FAILED_LOG_CAP: usize = 8 * 1024;
/// Cap on missions scanned per cycle (defensive against
/// pathological cases — every active mission gets one
/// `kubectl exec` per cycle).
const MAX_MISSIONS_PER_CYCLE: usize = 256;

#[derive(Clone)]
pub struct RepoCiListenerDeps {
    pub cmd_tx: mpsc::Sender<ControlCommand>,
    pub events_tx: broadcast::Sender<AgentEvent>,
    pub mission_store: Arc<dyn MissionStore>,
    pub workspaces: SharedWorkspaceStore,
}

/// Spawn the listener loop as a detached tokio task. Returns
/// immediately; the loop lives for the process's lifetime.
pub fn spawn(deps: RepoCiListenerDeps) {
    let interval = std::env::var("REPO_CI_LISTENER_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECS);
    tokio::spawn(run_loop(deps, interval));
    tracing::info!(interval_secs = interval, "repo_ci_listener: spawned");
}

#[derive(Default)]
struct ListenerState {
    /// Highest completed `databaseId` we've already emitted a
    /// reminder for, per `(mission_id, owner, repo)`.
    cursors: HashMap<(Uuid, String, String), i64>,
    /// Marks which `(mission_id, owner, repo)` tuples have been
    /// seen at least once — used to suppress the first-poll
    /// historical-flood (the first observation seeds the cursor
    /// without emitting).
    initialised: HashSet<(Uuid, String, String)>,
}

async fn run_loop(deps: RepoCiListenerDeps, interval_secs: u64) {
    let mut state = ListenerState::default();
    let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Skip the first immediate fire so the backend has a chance
    // to finish boot (mission store hydrate, workspace store
    // load) before the first scan.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if let Err(err) = poll_once(&deps, &mut state).await {
            tracing::warn!(error = %err, "repo_ci_listener: poll cycle failed");
        }
    }
}

async fn poll_once(deps: &RepoCiListenerDeps, state: &mut ListenerState) -> Result<()> {
    let missions = deps
        .mission_store
        .list_missions(MAX_MISSIONS_PER_CYCLE, 0)
        .await
        .map_err(|e| anyhow::anyhow!("mission_store.list_missions: {e}"))?;
    let total = missions.len();
    let mut active = 0usize;
    let mut k8s_pod = 0usize;
    for mission in missions {
        if mission.status != MissionStatus::Active {
            continue;
        }
        active += 1;
        // Skip non-K8sPod workspaces — `/workspaces/repos` only
        // exists in K8sPod pods.
        let Some(workspace) = deps.workspaces.get(mission.workspace_id).await else {
            tracing::debug!(
                mid = %mission.id,
                wid = %mission.workspace_id,
                "repo_ci_listener: workspace lookup miss"
            );
            continue;
        };
        if workspace.workspace_type != WorkspaceType::K8sPod {
            tracing::debug!(
                mid = %mission.id,
                wid = %mission.workspace_id,
                wtype = ?workspace.workspace_type,
                "repo_ci_listener: skip non-K8sPod workspace"
            );
            continue;
        }
        k8s_pod += 1;
        if let Err(err) = poll_mission(deps, state, &mission, workspace).await {
            tracing::debug!(
                mid = %mission.id,
                error = %err,
                "repo_ci_listener: mission poll failed (will retry next cycle)"
            );
        }
    }
    tracing::debug!(total, active, k8s_pod, "repo_ci_listener: poll cycle done");
    Ok(())
}

async fn poll_mission(
    deps: &RepoCiListenerDeps,
    state: &mut ListenerState,
    mission: &Mission,
    workspace: crate::workspace::Workspace,
) -> Result<()> {
    let exec = WorkspaceExec::for_mission(workspace, mission.id);
    let repos = list_workspace_repos(&exec).await?;
    tracing::debug!(
        mid = %mission.id,
        repos_count = repos.len(),
        repos = ?repos,
        "repo_ci_listener: poll mission"
    );
    if repos.is_empty() {
        return Ok(());
    }
    for (owner, repo) in repos {
        if let Err(err) = poll_repo(deps, state, mission.id, &exec, &owner, &repo).await {
            tracing::debug!(
                mid = %mission.id,
                repo = %format!("{owner}/{repo}"),
                error = %err,
                "repo_ci_listener: repo poll failed"
            );
        }
    }
    Ok(())
}

async fn poll_repo(
    deps: &RepoCiListenerDeps,
    state: &mut ListenerState,
    mission_id: Uuid,
    exec: &WorkspaceExec,
    owner: &str,
    repo: &str,
) -> Result<()> {
    let runs = gh_run_list(exec, owner, repo).await?;
    let key = (mission_id, owner.to_string(), repo.to_string());
    let completed: Vec<&RunSummary> = runs.iter().filter(|r| r.status == "completed").collect();
    tracing::debug!(
        mid = %mission_id,
        repo = %format!("{owner}/{repo}"),
        runs = runs.len(),
        completed = completed.len(),
        "repo_ci_listener: poll repo"
    );
    if completed.is_empty() {
        return Ok(());
    }
    let max_id = completed.iter().map(|r| r.database_id).max().unwrap_or(0);
    if !state.initialised.contains(&key) {
        state.cursors.insert(key.clone(), max_id);
        state.initialised.insert(key);
        tracing::info!(
            mid = %mission_id,
            repo = %format!("{owner}/{repo}"),
            cursor = max_id,
            "repo_ci_listener: initialised cursor (no historical reminders)"
        );
        return Ok(());
    }
    let cursor = *state.cursors.get(&key).unwrap_or(&0);
    let mut new_runs: Vec<&RunSummary> = completed
        .into_iter()
        .filter(|r| r.database_id > cursor)
        .collect();
    new_runs.sort_by_key(|r| r.database_id);
    for run in new_runs {
        emit_completion(deps, exec, mission_id, owner, repo, run).await;
        state.cursors.insert(
            key.clone(),
            run.database_id.max(*state.cursors.get(&key).unwrap_or(&0)),
        );
    }
    Ok(())
}

async fn emit_completion(
    deps: &RepoCiListenerDeps,
    exec: &WorkspaceExec,
    mission_id: Uuid,
    owner: &str,
    repo: &str,
    run: &RunSummary,
) {
    let target_key = format!("{owner}/{repo}#{}", run.database_id);
    let target_human = if run.head_branch.is_empty() {
        format!("run {} in {owner}/{repo}", run.database_id)
    } else {
        format!(
            "run {} in {owner}/{repo} ({})",
            run.database_id, run.head_branch
        )
    };
    // Pull job-level rollup for the UI panel + reminder. Best
    // effort — empty Vec on failure.
    let jobs = gh_run_view_jobs(exec, owner, repo, run.database_id)
        .await
        .unwrap_or_default();
    let _ = deps.events_tx.send(AgentEvent::MissionPrCiUpdate {
        mission_id,
        tool_use_id: target_key.clone(),
        target: target_human.clone(),
        status: "completed".into(),
        checks: jobs.clone(),
        url: Some(run.url.clone()),
    });
    let reminder = format_reminder(exec, owner, repo, run, &jobs).await;
    if let Err(err) = deps
        .cmd_tx
        .send(ControlCommand::InjectSystemReminder {
            mission_id,
            content: reminder,
        })
        .await
    {
        tracing::warn!(
            mid = %mission_id,
            error = %err,
            "repo_ci_listener: InjectSystemReminder send failed"
        );
    }
    // Tell the dashboard panel to drop the row once the verdict
    // has been delivered.
    let _ = deps.events_tx.send(AgentEvent::MissionPrCiUpdate {
        mission_id,
        tool_use_id: target_key,
        target: target_human,
        status: "removed".into(),
        checks: jobs,
        url: Some(run.url.clone()),
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Workspace probes
// ─────────────────────────────────────────────────────────────────────────

/// List `(owner, repo)` for every git repo cloned at
/// `/workspaces/repos/<name>/` whose `origin` remote points to
/// GitHub. Non-GitHub remotes are silently skipped — only
/// `github.com`-hosted repos can be polled by `gh run list`.
async fn list_workspace_repos(exec: &WorkspaceExec) -> Result<Vec<(String, String)>> {
    // Single bash invocation that prints one `owner<TAB>repo` per
    // line. Robust against repos with no origin or with non-GitHub
    // remotes (those are filtered out via `||true`).
    let script = r#"
        set +e
        for d in /workspaces/repos/*/; do
          [ -d "$d/.git" ] || continue
          url=$(git -C "$d" config --get remote.origin.url 2>/dev/null) || continue
          [ -n "$url" ] || continue
          echo "$url"
        done
    "#;
    let out = exec
        .output(
            Path::new("/tmp"),
            "bash",
            &["-c".to_string(), script.into()],
            std::collections::HashMap::new(),
        )
        .await
        .context("list_workspace_repos exec failed")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut repos = Vec::new();
    for line in stdout.lines() {
        if let Some((owner, repo)) = parse_github_origin(line.trim()) {
            repos.push((owner, repo));
        }
    }
    // De-dupe (in case two repos share an origin — rare but
    // possible with forks side by side).
    repos.sort();
    repos.dedup();
    Ok(repos)
}

/// Parse a git remote URL into `(owner, repo)` if and only if the
/// host is `github.com`. Accepts:
/// - `git@github.com:owner/repo[.git]`
/// - `https://github.com/owner/repo[.git]`
/// - `ssh://git@github.com/owner/repo[.git]`
fn parse_github_origin(url: &str) -> Option<(String, String)> {
    let s = url.trim();
    let path_part = if let Some(rest) = s.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = s.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = s.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = s.strip_prefix("http://github.com/") {
        rest
    } else {
        // Not a github.com remote in any accepted form → `?`
        // short-circuits the whole fn to None (clippy: question_mark).
        s.strip_prefix("github.com:")?
    };
    let stripped = path_part
        .strip_suffix(".git")
        .unwrap_or(path_part)
        .trim_end_matches('/');
    let mut parts = stripped.splitn(3, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

// ─────────────────────────────────────────────────────────────────────────
// gh CLI probes
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RunSummary {
    database_id: i64,
    status: String,
    conclusion: String,
    head_branch: String,
    head_sha: String,
    workflow_name: String,
    url: String,
    display_title: String,
    event: String,
}

async fn gh_run_list(exec: &WorkspaceExec, owner: &str, repo: &str) -> Result<Vec<RunSummary>> {
    let cmd = format!(
        "gh run list -R {owner}/{repo} --limit {RUNS_PER_POLL} --json databaseId,status,conclusion,headBranch,headSha,workflowName,url,displayTitle,event 2>&1"
    );
    let out = exec
        .output(
            Path::new("/tmp"),
            "bash",
            &["-c".to_string(), cmd],
            std::collections::HashMap::new(),
        )
        .await
        .context("gh run list exec failed")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stdout);
        anyhow::bail!("gh run list exit {:?}: {stderr}", out.status.code());
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    parse_run_list(&stdout)
}

fn parse_run_list(stdout: &str) -> Result<Vec<RunSummary>> {
    let v: Value = serde_json::from_str(stdout.trim()).context("parse gh run list json")?;
    let arr = v
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("gh run list: expected JSON array"))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let database_id = item.get("databaseId").and_then(|v| v.as_i64()).unwrap_or(0);
        if database_id == 0 {
            continue;
        }
        out.push(RunSummary {
            database_id,
            status: item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            conclusion: item
                .get("conclusion")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            head_branch: item
                .get("headBranch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            head_sha: item
                .get("headSha")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            workflow_name: item
                .get("workflowName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url: item
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            display_title: item
                .get("displayTitle")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            event: item
                .get("event")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

async fn gh_run_view_jobs(
    exec: &WorkspaceExec,
    owner: &str,
    repo: &str,
    run_id: i64,
) -> Result<Vec<Value>> {
    let cmd = format!("gh run view {run_id} -R {owner}/{repo} --json jobs 2>&1");
    let out = exec
        .output(
            Path::new("/tmp"),
            "bash",
            &["-c".to_string(), cmd],
            std::collections::HashMap::new(),
        )
        .await
        .context("gh run view exec failed")?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
    Ok(v.get("jobs")
        .and_then(|j| j.as_array())
        .cloned()
        .unwrap_or_default())
}

async fn gh_run_failed_log_tail(
    exec: &WorkspaceExec,
    owner: &str,
    repo: &str,
    run_id: i64,
) -> Option<String> {
    let cmd = format!(
        "gh run view {run_id} -R {owner}/{repo} --log-failed 2>&1 | tail -c {FAILED_LOG_CAP}"
    );
    let out = exec
        .output(
            Path::new("/tmp"),
            "bash",
            &["-c".to_string(), cmd],
            std::collections::HashMap::new(),
        )
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Reminder formatting
// ─────────────────────────────────────────────────────────────────────────

async fn format_reminder(
    exec: &WorkspaceExec,
    owner: &str,
    repo: &str,
    run: &RunSummary,
    jobs: &[Value],
) -> String {
    let success = matches!(run.conclusion.as_str(), "success" | "neutral" | "skipped");
    let verdict_label = if success {
        "PASSED"
    } else if run.conclusion.is_empty() {
        "FINISHED (no conclusion)"
    } else {
        "FAILED"
    };
    let branch = if run.head_branch.is_empty() {
        ""
    } else {
        run.head_branch.as_str()
    };
    let mut out = String::new();
    out.push_str("<system-reminder>\n");
    out.push_str(&format!(
        "GitHub Actions run {verdict_label}: {workflow} on {owner}/{repo}",
        workflow = if run.workflow_name.is_empty() {
            "workflow".to_string()
        } else {
            run.workflow_name.clone()
        }
    ));
    if !branch.is_empty() {
        out.push_str(&format!(" ({branch})"));
    }
    out.push('\n');
    if !run.display_title.is_empty() {
        out.push_str(&format!("Title: {}\n", run.display_title));
    }
    if !run.head_sha.is_empty() {
        let short = &run.head_sha[..run.head_sha.len().min(8)];
        out.push_str(&format!("Commit: {short}\n"));
    }
    if !run.event.is_empty() {
        out.push_str(&format!("Event: {}\n", run.event));
    }
    out.push_str(&format!("URL: {}\n", run.url));
    if !jobs.is_empty() {
        out.push_str("\nJobs:\n");
        for job in jobs.iter().take(20) {
            let name = job
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("(unnamed)");
            let conclusion = job.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
            let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let label = if conclusion.is_empty() {
                status
            } else {
                conclusion
            };
            out.push_str(&format!("  • {name} — {label}\n"));
        }
    }
    if !success {
        if let Some(tail) = gh_run_failed_log_tail(exec, owner, repo, run.database_id).await {
            out.push_str("\nFailed-job log tail (truncated):\n");
            out.push_str("```\n");
            out.push_str(&tail);
            if !tail.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("```\n");
        }
    }
    out.push_str("\nThis reminder was emitted by the repo-ci-listener.\n");
    out.push_str("</system-reminder>");
    out
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_origin() {
        assert_eq!(
            parse_github_origin("git@github.com:forgecart/sandboxed.sh.git"),
            Some(("forgecart".into(), "sandboxed.sh".into()))
        );
    }

    #[test]
    fn parses_https_origin() {
        assert_eq!(
            parse_github_origin("https://github.com/forgecart/cloud.git"),
            Some(("forgecart".into(), "cloud".into()))
        );
    }

    #[test]
    fn parses_origin_without_git_suffix() {
        assert_eq!(
            parse_github_origin("https://github.com/owner/repo"),
            Some(("owner".into(), "repo".into()))
        );
    }

    #[test]
    fn rejects_non_github_origin() {
        assert_eq!(parse_github_origin("git@gitlab.com:foo/bar.git"), None);
        assert_eq!(
            parse_github_origin("https://bitbucket.org/foo/bar.git"),
            None
        );
        assert_eq!(parse_github_origin(""), None);
        assert_eq!(parse_github_origin("not-a-url"), None);
    }

    #[test]
    fn parses_run_list_json() {
        let json = r#"[
            {"databaseId": 42, "status": "completed", "conclusion": "success",
             "headBranch": "main", "headSha": "abc123",
             "workflowName": "CI", "url": "https://github.com/x/y/actions/runs/42",
             "displayTitle": "fix tests", "event": "push"},
            {"databaseId": 41, "status": "in_progress", "conclusion": "",
             "headBranch": "feat", "headSha": "def456",
             "workflowName": "CI", "url": "https://github.com/x/y/actions/runs/41",
             "displayTitle": "wip", "event": "push"}
        ]"#;
        let runs = parse_run_list(json).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].database_id, 42);
        assert_eq!(runs[0].status, "completed");
        assert_eq!(runs[1].status, "in_progress");
    }

    #[test]
    fn parse_run_list_handles_empty_array() {
        assert_eq!(parse_run_list("[]").unwrap().len(), 0);
    }

    #[test]
    fn parse_run_list_rejects_non_array() {
        assert!(parse_run_list("{}").is_err());
    }
}
