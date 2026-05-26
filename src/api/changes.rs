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
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
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
    /// File content at `HEAD` (the "before" side of the side-by-side
    /// diff). `None` for untracked files. Truncated to MAX_DIFF_BYTES.
    pub head_content: Option<String>,
    /// File content in the worktree (the "after" side). `None` for
    /// fully-deleted files. Truncated to MAX_DIFF_BYTES.
    pub worktree_content: Option<String>,
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
        let untracked = xy == "??";
        let deleted = xy.contains('D');
        let (diff, truncated) = if untracked {
            fetch_untracked_as_diff(k8s, mission_id, &repo_dir, &path).await
        } else {
            fetch_tracked_diff(k8s, mission_id, &repo_dir, &path).await
        };
        // Side-by-side content. `head_content` = `git show HEAD:<path>`
        // for tracked files (None for untracked). `worktree_content`
        // = current file content (None for fully-deleted files).
        let head_content = if untracked {
            None
        } else {
            fetch_head_content(k8s, mission_id, &repo_dir, &path).await
        };
        let worktree_content = if deleted {
            None
        } else {
            fetch_worktree_content(k8s, mission_id, &repo_dir, &path).await
        };
        files.push(MissionChangedFile {
            path,
            status,
            diff,
            head_content,
            worktree_content,
            truncated,
        });
    }
    files
}

async fn fetch_head_content(
    k8s: &Arc<crate::k8s_pod::K8sPodClient>,
    mission_id: Uuid,
    repo_dir: &str,
    path: &str,
) -> Option<String> {
    let script = format!(
        "cd {} && git show HEAD:{} 2>/dev/null",
        shell_quote(repo_dir),
        shell_quote(path)
    );
    let out = k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), script],
            &HashMap::new(),
        )
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    if s.len() > MAX_DIFF_BYTES {
        s.truncate(MAX_DIFF_BYTES);
        s.push_str("\n\n[... truncated ...]\n");
    }
    Some(s)
}

async fn fetch_worktree_content(
    k8s: &Arc<crate::k8s_pod::K8sPodClient>,
    mission_id: Uuid,
    repo_dir: &str,
    path: &str,
) -> Option<String> {
    let script = format!(
        "cd {} && cat -- {} 2>/dev/null",
        shell_quote(repo_dir),
        shell_quote(path)
    );
    let out = k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), script],
            &HashMap::new(),
        )
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    if s.len() > MAX_DIFF_BYTES {
        s.truncate(MAX_DIFF_BYTES);
        s.push_str("\n\n[... truncated ...]\n");
    }
    Some(s)
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

#[derive(Debug, Deserialize)]
pub struct RepoTreeQuery {
    /// Repository directory name under `/workspaces/repos/`.
    pub repo: String,
    /// Subpath relative to the repo root. Empty = list the repo
    /// root itself.
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct RepoTreeEntry {
    pub name: String,
    /// Path relative to the repo root (always with `/` separators).
    pub path: String,
    /// `"dir"` or `"file"` — symlinks are reported as whatever they
    /// resolve to (we do not follow chains).
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct RepoTreeResponse {
    pub entries: Vec<RepoTreeEntry>,
    /// `true` when the per-mission pod isn't reachable.
    pub unavailable: bool,
}

/// `/api/control/missions/:id/repo-tree?repo=<name>&path=<rel>`
///
/// Lists immediate children of a directory inside a cloned repo,
/// for the dashboard's file-browser pane. Directories first, then
/// files; alpha-sorted within each group. Hidden entries
/// (starting with `.`) are included — they're useful to the user
/// (e.g. `.github/`, `.env.example`). `.git/` is excluded — the
/// dashboard does not need to walk Git's internal storage.
///
/// Path-traversal: we strictly reject `..` and absolute components
/// so a malicious caller can't escape `/workspaces/repos/<repo>/`.
pub async fn list_mission_repo_tree(
    State(_state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
    Path(mission_id): Path<Uuid>,
    Query(q): Query<RepoTreeQuery>,
) -> Result<Json<RepoTreeResponse>, (StatusCode, String)> {
    // Reject path traversal + absolute paths. `repo` is a single
    // directory name (slashes not allowed). `path` is relative; we
    // split on `/` and disallow `..` / empty / absolute segments.
    if q.repo.contains('/') || q.repo.contains("..") || q.repo.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "invalid repo".into()));
    }
    for seg in q.path.split('/') {
        if seg == ".." {
            return Err((StatusCode::BAD_REQUEST, "invalid path".into()));
        }
    }

    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => {
            return Ok(Json(RepoTreeResponse {
                entries: vec![],
                unavailable: true,
            }));
        }
    };

    let full = if q.path.is_empty() {
        format!("/workspaces/repos/{}", q.repo)
    } else {
        format!("/workspaces/repos/{}/{}", q.repo, q.path.trim_matches('/'))
    };

    // `find -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'` gives us
    // type + name in one cheap call. We sort client-side. `%y`
    // returns `d` for dir, `f` for file, `l` for symlink, etc.
    // We exclude `.git` at the source level so the user never sees
    // it in the browser pane.
    let script = format!(
        "cd {} 2>/dev/null && find . -mindepth 1 -maxdepth 1 \\( -name .git -prune \\) -o -printf '%y\\t%f\\n'",
        shell_quote(&full),
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
            return Ok(Json(RepoTreeResponse {
                entries: vec![],
                unavailable: true,
            }));
        }
    };
    if !out.status.success() {
        return Ok(Json(RepoTreeResponse {
            entries: vec![],
            unavailable: false,
        }));
    }

    let mut entries: Vec<RepoTreeEntry> = Vec::new();
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '\t');
        let t = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let kind = match t {
            "d" => "dir",
            "f" => "file",
            // Symlinks resolve to their target type via -L on a
            // separate stat; cheaper to just label as "file" since
            // the browser is a read-only view and we don't follow.
            "l" => "file",
            _ => continue,
        };
        let rel = if q.path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", q.path.trim_matches('/'), name)
        };
        entries.push(RepoTreeEntry {
            name,
            path: rel,
            kind: kind.to_string(),
        });
    }
    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.name.cmp(&b.name)
    });
    Ok(Json(RepoTreeResponse {
        entries,
        unavailable: false,
    }))
}
