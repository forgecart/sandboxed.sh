//! `/api/control/missions/:id/changes` — per-mission git status + diff.
//!
//! Walks every cloned repo under `/workspaces/repos/<name>/` inside
//! the per-mission pod, runs `git status --porcelain=v1 -z` to list
//! touched paths, then `git diff <path>` (or full content for
//! untracked) for each. Returns a JSON tree the dashboard renders
//! as a file-tree + unified diff viewer.
//!
//! K8sPod-only — the host workspace and Container workspace don't
//! have a per-mission "scratch repo" concept yet. Other workspace
//! types return an empty list.
use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Serialize;
use uuid::Uuid;

use super::auth::AuthUser;
use super::routes::AppState;

#[derive(Debug, Serialize)]
pub struct MissionChangedFile {
    /// Path relative to the repo root (e.g. `src/foo.ts`).
    pub path: String,
    /// Git porcelain status code: `M`, `A`, `D`, `R`, `C`, `??` (untracked), etc.
    pub status: String,
    /// Unified diff for tracked changes; full file content (as an
    /// "added" diff) for untracked files. Truncated to 256KB to
    /// protect the dashboard from multi-MB pathological cases.
    pub diff: String,
    /// `true` when the diff was truncated. Bytes are then a head
    /// slice; full diff is still available via the agent's
    /// in-pod tools if needed.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct MissionChangedRepo {
    /// Repo directory name under `/workspaces/repos/`.
    pub name: String,
    pub files: Vec<MissionChangedFile>,
}

#[derive(Debug, Serialize)]
pub struct MissionChangesResponse {
    pub mission_id: Uuid,
    pub repos: Vec<MissionChangedRepo>,
    /// `true` when the per-mission pod isn't reachable (e.g. mission
    /// is on the host workspace, or the pod was deleted). Dashboard
    /// hides the Changes tab in that case.
    pub unavailable: bool,
}

/// Max diff bytes per file before truncation.
const MAX_DIFF_BYTES: usize = 256 * 1024;

pub async fn list_mission_changes(
    State(_state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
    Path(mission_id): Path<Uuid>,
) -> Result<Json<MissionChangesResponse>, (StatusCode, String)> {
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => {
            return Ok(Json(MissionChangesResponse {
                mission_id,
                repos: vec![],
                unavailable: true,
            }));
        }
    };

    // Step 1: enumerate /workspaces/repos/* dirs that have .git.
    let list_script = r#"
for d in /workspaces/repos/*; do
  [ -d "$d/.git" ] || continue
  basename "$d"
done
"#;
    let list_out = match k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), list_script.to_string()],
            &HashMap::new(),
        )
        .await
    {
        Ok(o) => o,
        Err(_) => {
            return Ok(Json(MissionChangesResponse {
                mission_id,
                repos: vec![],
                unavailable: true,
            }));
        }
    };
    let repos: Vec<String> = String::from_utf8_lossy(&list_out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut out_repos: Vec<MissionChangedRepo> = Vec::with_capacity(repos.len());
    for repo in repos {
        let files = collect_changed_files(&k8s, mission_id, &repo).await;
        if !files.is_empty() {
            out_repos.push(MissionChangedRepo { name: repo, files });
        }
    }

    Ok(Json(MissionChangesResponse {
        mission_id,
        repos: out_repos,
        unavailable: false,
    }))
}

async fn collect_changed_files(
    k8s: &Arc<crate::k8s_pod::K8sPodClient>,
    mission_id: Uuid,
    repo: &str,
) -> Vec<MissionChangedFile> {
    let repo_dir = format!("/workspaces/repos/{}", repo);

    // `git status --porcelain=v1` — two-char status + path, with a
    // single space separator (or `\t` for renames). `--no-renames`
    // simplifies parsing; rename detection isn't critical for the UI.
    let status_script = format!(
        "cd {} && git status --porcelain=v1 --no-renames -uall",
        shell_quote(&repo_dir)
    );
    let status_out = match k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), status_script],
            &HashMap::new(),
        )
        .await
    {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    if !status_out.status.success() {
        return vec![];
    }
    let status_stdout = String::from_utf8_lossy(&status_out.stdout).to_string();

    let mut files: Vec<MissionChangedFile> = vec![];
    for line in status_stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        // porcelain v1: "XY path" where X = index status, Y = worktree status.
        let xy = &line[..2];
        let rest = line[3..].trim();
        if rest.is_empty() {
            continue;
        }
        let status = xy.trim().to_string();
        let path = rest.to_string();
        let (diff, truncated) = if xy == "??" {
            fetch_untracked_as_diff(k8s, mission_id, &repo_dir, &path).await
        } else {
            fetch_tracked_diff(k8s, mission_id, &repo_dir, &path).await
        };
        files.push(MissionChangedFile {
            path,
            status,
            diff,
            truncated,
        });
    }
    files
}

async fn fetch_tracked_diff(
    k8s: &Arc<crate::k8s_pod::K8sPodClient>,
    mission_id: Uuid,
    repo_dir: &str,
    path: &str,
) -> (String, bool) {
    // Combined index + worktree diff: HEAD..worktree. Captures both
    // staged and unstaged changes in one unified hunk set.
    let script = format!(
        "cd {} && git diff HEAD -- {}",
        shell_quote(repo_dir),
        shell_quote(path)
    );
    let out = match k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), script],
            &HashMap::new(),
        )
        .await
    {
        Ok(o) => o,
        Err(_) => return (String::new(), false),
    };
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    truncate_diff(raw)
}

async fn fetch_untracked_as_diff(
    k8s: &Arc<crate::k8s_pod::K8sPodClient>,
    mission_id: Uuid,
    repo_dir: &str,
    path: &str,
) -> (String, bool) {
    // Synthesise a unified "all-added" diff so the frontend's
    // unified-diff renderer can show the file content the same way
    // it shows tracked changes.
    //
    //   diff --git a/<path> b/<path>
    //   new file mode 100644
    //   --- /dev/null
    //   +++ b/<path>
    //   @@ -0,0 +1,N @@
    //   +<line1>
    //   +<line2>
    //
    // For binary files (cat fails to produce text), we emit a stub.
    let script = format!(
        "cd {} && cat -- {}",
        shell_quote(repo_dir),
        shell_quote(path)
    );
    let out = match k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), script],
            &HashMap::new(),
        )
        .await
    {
        Ok(o) => o,
        Err(_) => {
            return (format!("(unreadable: {})", path), false);
        }
    };
    let content = String::from_utf8_lossy(&out.stdout).to_string();
    let line_count = content.lines().count();
    let mut diff = String::new();
    diff.push_str(&format!("diff --git a/{0} b/{0}\n", path));
    diff.push_str("new file mode 100644\n");
    diff.push_str("--- /dev/null\n");
    diff.push_str(&format!("+++ b/{}\n", path));
    diff.push_str(&format!("@@ -0,0 +1,{} @@\n", line_count));
    for line in content.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    truncate_diff(diff)
}

fn truncate_diff(s: String) -> (String, bool) {
    if s.len() <= MAX_DIFF_BYTES {
        (s, false)
    } else {
        let mut truncated = s;
        truncated.truncate(MAX_DIFF_BYTES);
        truncated.push_str("\n\n[... diff truncated, file too large ...]");
        (truncated, true)
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
