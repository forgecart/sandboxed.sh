//! `/api/control/missions/:id/workspace-stream` — multiplexed
//! WebSocket for every per-mission workspace operation
//! (read/write file, list directory, list changes, search,
//! file-system subscription).
//!
//! Why one socket: each operation hits the same kubectl-exec
//! plumbing; doing them as separate HTTPS GETs paid the TLS
//! handshake + kubectl-exec setup cost on every call and gave
//! no path for streaming progress. The big offender was
//! `/changes`, which ran ~3 kubectl-execs per changed file
//! sequentially before returning anything to the dashboard —
//! the "fake progress bar" lived there.
//!
//! Protocol:
//!
//! Client → server (request):
//!   { "id": "<uuid>", "type": "<verb>", "params": {...} }
//!
//!   Verbs:
//!     - list_dir        params: { repo, path }
//!     - read_file       params: { repo, path }
//!     - write_file      params: { repo, path, content }
//!     - list_changes    params: {}    (streams progressively)
//!     - search          params: { repo, q, path?, limit? }  (streams hits)
//!     - subscribe_fs    params: {}    (long-lived; one per session)
//!     - cancel          params: { request_id }  (aborts a streaming verb)
//!
//! Server → client (response, correlated by `id`):
//!   { "id": "<uuid>", "type": "ready" | "chunk" | "progress"
//!                          | "done" | "error", "data": ... }
//!
//! Unsolicited (no `id`):
//!   { "type": "fs_change", "data": { repo, path, event } }
//!
//! Per-request tasks are tracked in a HashMap by id and aborted
//! either when the client sends `cancel`, when the WS dies, or
//! when the task finishes naturally.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
    Extension,
};
use base64::Engine;
use futures::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::auth::AuthUser;
use super::routes::AppState;

type WsTx = Arc<Mutex<SplitSink<WebSocket, Message>>>;

/// Max bytes returned by `read_file` and per side of `list_changes`.
const MAX_FILE_BYTES: usize = 256 * 1024;
/// Cap on `write_file` payload.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
/// Streaming-changes per-file fetch concurrency. Higher = faster
/// for repos with lots of dirty files; bounded so a 500-file
/// status doesn't spin up 500 kubectl-execs in parallel.
const CHANGES_PARALLELISM: usize = 6;
/// Per-search hit cap (so a runaway regex can't flood the WS).
const SEARCH_HARD_CAP: usize = 1_000;

#[derive(Deserialize)]
struct ClientMsg {
    #[serde(default)]
    id: Option<String>,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    params: Value,
}

pub async fn workspace_stream(
    State(_state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
    Path(mission_id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = run(socket, mission_id).await {
            tracing::warn!(mission_id = %mission_id, error = %e, "workspace-stream ended");
        }
    })
}

async fn run(socket: WebSocket, mission_id: Uuid) -> anyhow::Result<()> {
    let (tx, mut rx) = socket.split();
    let tx: WsTx = Arc::new(Mutex::new(tx));
    let tasks: Arc<Mutex<HashMap<String, JoinHandle<()>>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some(msg) = rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "ws recv failed");
                break;
            }
        };
        let body = match msg {
            Message::Text(t) => t,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => break,
        };
        let req: ClientMsg = match serde_json::from_str(&body) {
            Ok(r) => r,
            Err(e) => {
                send_error(&tx, None, &format!("bad request: {e}")).await;
                continue;
            }
        };
        let id = req.id.clone().unwrap_or_default();
        let ty = req.ty.as_str();
        if id.is_empty() && ty != "cancel" {
            send_error(&tx, None, "missing request id").await;
            continue;
        }

        // Per-task spawn. Tasks own a clone of `tx` + know their
        // own id. They register themselves with `tasks`, then
        // unregister on completion.
        let tx_t = tx.clone();
        let tasks_t = tasks.clone();
        let id_t = id.clone();
        let params = req.params;
        let mid = mission_id;

        match ty {
            "list_dir" => {
                let h = tokio::spawn(async move {
                    list_dir(&tx_t, &id_t, mid, params).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "read_file" => {
                let h = tokio::spawn(async move {
                    read_file(&tx_t, &id_t, mid, params).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "write_file" => {
                let h = tokio::spawn(async move {
                    write_file(&tx_t, &id_t, mid, params).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "list_changes" => {
                let h = tokio::spawn(async move {
                    list_changes(&tx_t, &id_t, mid).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "search" => {
                let h = tokio::spawn(async move {
                    search(&tx_t, &id_t, mid, params).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "subscribe_fs" => {
                let h = tokio::spawn(async move {
                    subscribe_fs(&tx_t, &id_t, mid).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "list_repos" => {
                let h = tokio::spawn(async move {
                    list_repos(&tx_t, &id_t, mid).await;
                    tasks_t.lock().await.remove(&id_t);
                });
                tasks.lock().await.insert(id, h);
            }
            "cancel" => {
                if let Some(target) = params.get("request_id").and_then(|v| v.as_str()) {
                    if let Some(h) = tasks.lock().await.remove(target) {
                        h.abort();
                        send_done(&tx, target, json!({ "cancelled": true })).await;
                    }
                }
            }
            other => {
                send_error(&tx, Some(&id), &format!("unknown verb: {other}")).await;
            }
        }
    }

    // Abort any pending tasks on disconnect.
    let mut guard = tasks.lock().await;
    for (_, h) in guard.drain() {
        h.abort();
    }
    Ok(())
}

// ── send helpers ────────────────────────────────────────────

async fn send_text(tx: &WsTx, body: String) {
    let mut guard = tx.lock().await;
    let _ = guard.send(Message::Text(body)).await;
}

async fn send_chunk(tx: &WsTx, id: &str, data: Value) {
    let v = json!({ "id": id, "type": "chunk", "data": data });
    send_text(tx, v.to_string()).await;
}

async fn send_ready(tx: &WsTx, id: &str, data: Value) {
    let v = json!({ "id": id, "type": "ready", "data": data });
    send_text(tx, v.to_string()).await;
}

async fn send_progress(tx: &WsTx, id: &str, loaded: usize, total: usize) {
    let v = json!({
        "id": id, "type": "progress",
        "data": { "loaded": loaded, "total": total }
    });
    send_text(tx, v.to_string()).await;
}

async fn send_done(tx: &WsTx, id: &str, data: Value) {
    let v = json!({ "id": id, "type": "done", "data": data });
    send_text(tx, v.to_string()).await;
}

async fn send_error(tx: &WsTx, id: Option<&str>, msg: &str) {
    let v = json!({
        "id": id.unwrap_or(""),
        "type": "error",
        "error": msg
    });
    send_text(tx, v.to_string()).await;
}

// ── path / validation helpers ───────────────────────────────

fn validate_repo_path(repo: &str, path: &str) -> Result<(), String> {
    if repo.is_empty() || repo.contains('/') || repo.contains("..") {
        return Err("invalid repo".into());
    }
    if path.starts_with('/') {
        return Err("absolute path".into());
    }
    for seg in path.split('/') {
        if seg == ".." {
            return Err("invalid path segment".into());
        }
    }
    Ok(())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Deserialize, Default)]
struct PathParams {
    repo: String,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct WriteParams {
    repo: String,
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct SearchParams {
    repo: String,
    q: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    limit: Option<usize>,
}

// ── verbs ───────────────────────────────────────────────────

async fn list_dir(tx: &WsTx, id: &str, mission_id: Uuid, params: Value) {
    let p: PathParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(tx, Some(id), &format!("bad params: {e}")).await,
    };
    if let Err(e) = validate_repo_path(&p.repo, &p.path) {
        return send_error(tx, Some(id), &e).await;
    }
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };
    let full = if p.path.is_empty() {
        format!("/workspaces/repos/{}", p.repo)
    } else {
        format!("/workspaces/repos/{}/{}", p.repo, p.path.trim_matches('/'))
    };
    let script = format!(
        "cd {} 2>/dev/null && find . -mindepth 1 -maxdepth 1 \\( -name .git -prune \\) \
         -o -printf '%y\\t%f\\n'",
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
        Err(e) => return send_error(tx, Some(id), &format!("exec: {e}")).await,
    };
    if !out.status.success() {
        return send_done(tx, id, json!({ "entries": [] })).await;
    }
    let mut entries: Vec<Value> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.splitn(2, '\t');
        let t = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let kind = match t {
            "d" => "dir",
            "f" | "l" => "file",
            _ => continue,
        };
        let rel = if p.path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", p.path.trim_matches('/'), name)
        };
        entries.push(json!({ "name": name, "path": rel, "kind": kind }));
    }
    entries.sort_by(|a, b| {
        let ad = a["kind"] == "dir";
        let bd = b["kind"] == "dir";
        if ad != bd {
            return if ad {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    send_done(tx, id, json!({ "entries": entries })).await;
}

async fn read_file(tx: &WsTx, id: &str, mission_id: Uuid, params: Value) {
    let p: PathParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(tx, Some(id), &format!("bad params: {e}")).await,
    };
    if let Err(e) = validate_repo_path(&p.repo, &p.path) {
        return send_error(tx, Some(id), &e).await;
    }
    if p.path.is_empty() {
        return send_error(tx, Some(id), "empty path").await;
    }
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };
    let full = format!("/workspaces/repos/{}/{}", p.repo, p.path);
    let script = format!(
        "set -e; f={}; [ -f \"$f\" ] || {{ echo __NOT_A_FILE__; exit 0; }}; \
         head -c 8192 \"$f\" | od -An -c | grep -q '\\\\0' && echo __BINARY__ && exit 0; \
         head -c {} \"$f\"",
        shell_quote(&full),
        MAX_FILE_BYTES,
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
        Err(e) => return send_error(tx, Some(id), &format!("exec: {e}")).await,
    };
    if !out.status.success() {
        return send_error(
            tx,
            Some(id),
            &format!(
                "read failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        )
        .await;
    }
    let content = String::from_utf8_lossy(&out.stdout).to_string();
    if content.starts_with("__NOT_A_FILE__") {
        return send_error(tx, Some(id), "not a file").await;
    }
    let binary = content.starts_with("__BINARY__");
    send_done(
        tx,
        id,
        json!({
            "content": if binary { String::new() } else { content.clone() },
            "binary": binary,
            "truncated": !binary && content.len() >= MAX_FILE_BYTES,
        }),
    )
    .await;
}

async fn write_file(tx: &WsTx, id: &str, mission_id: Uuid, params: Value) {
    let p: WriteParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(tx, Some(id), &format!("bad params: {e}")).await,
    };
    if let Err(e) = validate_repo_path(&p.repo, &p.path) {
        return send_error(tx, Some(id), &e).await;
    }
    if p.path.is_empty() {
        return send_error(tx, Some(id), "empty path").await;
    }
    if p.content.len() > MAX_WRITE_BYTES {
        return send_error(tx, Some(id), "content > 1 MiB").await;
    }
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };
    let full = format!("/workspaces/repos/{}/{}", p.repo, p.path);
    let b64 = base64::engine::general_purpose::STANDARD.encode(p.content.as_bytes());
    let script = format!(
        "set -e; dst={}; dir=$(dirname \"$dst\"); \
         [ -d \"$dir\" ] || {{ echo \"dir missing: $dir\" 1>&2; exit 1; }}; \
         tmp=$(mktemp -p \"$dir\" .write.XXXXXX); \
         printf '%s' {} | base64 -d > \"$tmp\"; \
         mv -f \"$tmp\" \"$dst\";",
        shell_quote(&full),
        shell_quote(&b64),
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
        Err(e) => return send_error(tx, Some(id), &format!("exec: {e}")).await,
    };
    if !out.status.success() {
        return send_error(
            tx,
            Some(id),
            &format!(
                "write failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        )
        .await;
    }
    send_done(tx, id, json!({ "ok": true })).await;
}

/// Streamed `list_changes`:
///  1. Send `ready` with the file list (per repo) the moment
///     `git status` returns. Dashboard renders the tree.
///  2. Fetch each file's diff/head/worktree in parallel batches,
///     emit `chunk` per file as it lands. Emit `progress` after
///     each batch.
///  3. Final `done`.
async fn list_changes(tx: &WsTx, id: &str, mission_id: Uuid) {
    list_changes_impl(tx, id, mission_id).await;
}

/// Repo enumeration verb — returns every directory under
/// `/workspaces/repos/` that has a `.git`, regardless of whether
/// the worktree is clean. Used by the Repos pane in the editor
/// so the user can browse + open files even when nothing's been
/// modified. The previous behaviour fell back to the
/// `list_changes` response, which filters out clean repos, so a
/// freshly-checked-out mission looked empty.
async fn list_repos(tx: &WsTx, id: &str, mission_id: Uuid) {
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };
    let script = r#"
for d in /workspaces/repos/*; do
  [ -d "$d/.git" ] || continue
  basename "$d"
done
"#;
    let out = match k8s
        .exec_command(
            mission_id,
            None,
            "/bin/bash",
            &["-lc".to_string(), script.to_string()],
            &HashMap::new(),
        )
        .await
    {
        Ok(o) => o,
        Err(e) => return send_error(tx, Some(id), &format!("repo enum: {e}")).await,
    };
    let repos: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    send_done(tx, id, json!({ "repos": repos })).await;
}

async fn list_changes_impl(tx: &WsTx, id: &str, mission_id: Uuid) {
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };

    // Step 1: enumerate repos.
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
        Err(e) => return send_error(tx, Some(id), &format!("repo enum: {e}")).await,
    };
    let repos: Vec<String> = String::from_utf8_lossy(&list_out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Step 2: porcelain status per repo. We send `ready` as soon
    // as the full file list is known (dashboard renders tree).
    struct PendingFile {
        repo: String,
        repo_dir: String,
        path: String,
        status: String,
        untracked: bool,
        deleted: bool,
    }
    let mut pending: Vec<PendingFile> = Vec::new();
    let mut ready_repos: Vec<Value> = Vec::new();
    for repo in &repos {
        let repo_dir = format!("/workspaces/repos/{}", repo);
        let status_script = format!(
            "cd {} && git status --porcelain=v1 --no-renames -uall",
            shell_quote(&repo_dir)
        );
        let out = match k8s
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
            Err(_) => continue,
        };
        if !out.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let mut files: Vec<Value> = Vec::new();
        for line in stdout.lines() {
            if line.len() < 4 {
                continue;
            }
            let xy = &line[..2];
            let rest = line[3..].trim();
            if rest.is_empty() {
                continue;
            }
            let status = xy.trim().to_string();
            let untracked = xy == "??";
            let deleted = xy.contains('D');
            let path = rest.to_string();
            files.push(json!({ "path": path, "status": status }));
            pending.push(PendingFile {
                repo: repo.clone(),
                repo_dir: repo_dir.clone(),
                path,
                status,
                untracked,
                deleted,
            });
        }
        if !files.is_empty() {
            ready_repos.push(json!({ "name": repo, "files": files }));
        }
    }

    let total = pending.len();
    send_ready(tx, id, json!({ "repos": ready_repos, "total": total })).await;
    send_progress(tx, id, 0, total).await;

    if total == 0 {
        return send_done(tx, id, json!({ "total": 0 })).await;
    }

    // Step 3: parallel per-file fetch. Use a bounded set of
    // tokio tasks so we don't hammer the pod with hundreds of
    // simultaneous kubectl-execs.
    let mut loaded = 0usize;
    let mut iter = pending.into_iter();
    let mut in_flight: futures::stream::FuturesUnordered<_> =
        futures::stream::FuturesUnordered::new();

    let fetch_one = |pf: PendingFile, k8s: Arc<crate::k8s_pod::K8sPodClient>| async move {
        let head = if pf.untracked {
            None
        } else {
            fetch_head(&k8s, mission_id, &pf.repo_dir, &pf.path).await
        };
        let wt = if pf.deleted {
            None
        } else {
            fetch_worktree(&k8s, mission_id, &pf.repo_dir, &pf.path).await
        };
        let truncated = head
            .as_ref()
            .map(|s| s.len() >= MAX_FILE_BYTES)
            .unwrap_or(false)
            || wt
                .as_ref()
                .map(|s| s.len() >= MAX_FILE_BYTES)
                .unwrap_or(false);
        json!({
            "repo": pf.repo,
            "path": pf.path,
            "status": pf.status,
            "head_content": head,
            "worktree_content": wt,
            "truncated": truncated,
        })
    };

    // Prime the pipeline.
    for _ in 0..CHANGES_PARALLELISM {
        if let Some(pf) = iter.next() {
            in_flight.push(fetch_one(pf, k8s.clone()));
        }
    }
    while let Some(file_chunk) = in_flight.next().await {
        send_chunk(tx, id, json!({ "file": file_chunk })).await;
        loaded += 1;
        send_progress(tx, id, loaded, total).await;
        if let Some(pf) = iter.next() {
            in_flight.push(fetch_one(pf, k8s.clone()));
        }
    }
    send_done(tx, id, json!({ "total": total })).await;
}

async fn fetch_head(
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
    if s.len() > MAX_FILE_BYTES {
        s.truncate(MAX_FILE_BYTES);
        s.push_str("\n\n[... truncated ...]\n");
    }
    Some(s)
}

async fn fetch_worktree(
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
    if s.len() > MAX_FILE_BYTES {
        s.truncate(MAX_FILE_BYTES);
        s.push_str("\n\n[... truncated ...]\n");
    }
    Some(s)
}

/// Streamed `search`. Pipes grep's stdout line-by-line, emits a
/// `chunk` per hit. Client can `cancel` mid-stream.
async fn search(tx: &WsTx, id: &str, mission_id: Uuid, params: Value) {
    let p: SearchParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return send_error(tx, Some(id), &format!("bad params: {e}")).await,
    };
    if p.repo.contains('/') || p.repo.contains("..") || p.repo.is_empty() {
        return send_error(tx, Some(id), "invalid repo").await;
    }
    if p.q.is_empty() {
        return send_done(tx, id, json!({ "total": 0 })).await;
    }
    let limit = p.limit.unwrap_or(200).clamp(1, SEARCH_HARD_CAP);
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };
    let scope = if p.path.is_empty() {
        format!("/workspaces/repos/{}", p.repo)
    } else {
        format!("/workspaces/repos/{}/{}", p.repo, p.path.trim_matches('/'))
    };
    // Use `git grep` so the search respects each repo's
    // .gitignore automatically. On an NX-style monorepo with
    // node_modules / dist / .turbo / etc. listed in .gitignore,
    // this is the difference between scanning ~1k tracked
    // source files and ~50k generated/dep files (which would
    // peg the pod and stream MBs to the browser).
    //
    // Flags:
    //  - `-I` skip binary files
    //  - `-n` line numbers
    //  - `-E` extended regex
    //  - `--no-color` plain output
    //  - `--untracked` also search files not yet committed
    //    (still ignored by .gitignore, so safe)
    //  - `--max-count=50` per-file cap so a runaway match in
    //    one big file doesn't dominate
    //  - `--no-index` falls back to filesystem walk for non-git
    //    paths (subdir of a repo, or a repo without git yet)
    //  - `--recurse-submodules` searches submodules too
    //
    // The first `cd` makes git's discovery walk land on the
    // right repo root; if `p.path` points deep into the tree we
    // still want git's index-aware behaviour.
    let cmd = format!(
        "cd {} 2>/dev/null && \
         git grep -InE --no-color --untracked --max-count=50 \
         --recurse-submodules -e {} -- . ':!*.min.*' ':!*.map' ':!*.bundle.js' \
         2>/dev/null | head -n {} || true",
        shell_quote(&scope),
        shell_quote(&p.q),
        limit
    );
    let mut child = match k8s
        .spawn_streaming_exec(mission_id, "/bin/bash", &["-lc", &cmd])
        .await
    {
        Ok(c) => c,
        Err(e) => return send_error(tx, Some(id), &format!("spawn: {e}")).await,
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return send_error(tx, Some(id), "no stdout").await,
    };
    let mut lines = BufReader::new(stdout).lines();
    let mut hits = 0usize;
    // Batch hits before flushing to the WS. One JSON frame per
    // hit melts the browser when matches are dense; batches
    // collapse ~25 hits into one envelope. We also flush every
    // ~50 ms regardless so the user sees the first results fast
    // even on sparse matches.
    const BATCH_SIZE: usize = 25;
    const BATCH_FLUSH_MS: u64 = 50;
    const MAX_SNIPPET_LEN: usize = 500;
    let mut batch: Vec<Value> = Vec::with_capacity(BATCH_SIZE);
    let mut last_flush = std::time::Instant::now();
    let flush = |tx: &WsTx, id: &str, batch: &mut Vec<Value>| {
        let drained = std::mem::take(batch);
        let count = drained.len();
        let tx = tx.clone();
        let id = id.to_string();
        async move {
            if count == 0 {
                return;
            }
            send_chunk(&tx, &id, json!({ "hits": drained })).await;
        }
    };
    while let Ok(Some(line)) = lines.next_line().await {
        let s = line.strip_prefix("./").unwrap_or(&line);
        let mut it = s.splitn(3, ':');
        let file = match it.next() {
            Some(v) => v.to_string(),
            None => continue,
        };
        let lineno: u32 = match it.next().and_then(|v| v.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let mut snippet = it.next().unwrap_or("").to_string();
        // Truncate freakishly long lines (minified files can have
        // multi-MB single lines). Without this every match in a
        // bundle would blow up both the WS frame and the React
        // render.
        if snippet.len() > MAX_SNIPPET_LEN {
            snippet.truncate(MAX_SNIPPET_LEN);
            snippet.push('…');
        }
        batch.push(json!({ "file": file, "line": lineno, "snippet": snippet }));
        hits += 1;
        let should_flush =
            batch.len() >= BATCH_SIZE || last_flush.elapsed().as_millis() as u64 >= BATCH_FLUSH_MS;
        if should_flush {
            flush(tx, id, &mut batch).await;
            last_flush = std::time::Instant::now();
            send_progress(tx, id, hits, limit).await;
        }
    }
    if !batch.is_empty() {
        flush(tx, id, &mut batch).await;
    }
    let _ = child.kill().await;
    send_done(tx, id, json!({ "total": hits, "truncated": hits >= limit })).await;
}

async fn subscribe_fs(tx: &WsTx, id: &str, mission_id: Uuid) {
    let k8s = match crate::k8s_pod::global_client() {
        Some(c) => c,
        None => return send_error(tx, Some(id), "pod unavailable").await,
    };
    // inotifywait recursively watches every dir it sees. On an
    // NX-style monorepo with `node_modules/` checked out, that's
    // tens of thousands of dirs — `inotifywait` either blows
    // through the kernel's `fs.inotify.max_user_watches` (8192
    // default on most distros) and bails, or chews through
    // pod memory holding all the watch descriptors. Either way,
    // opening the editor "crashed the server".
    //
    // `@<dir>` syntax tells inotifywait to NOT recurse into
    // that subtree while still watching its siblings. Listed in
    // order of frequency-and-size.
    let mut child = match k8s
        .spawn_streaming_exec(
            mission_id,
            "inotifywait",
            &[
                "-mr",
                "--quiet",
                "/workspaces/repos",
                "@/workspaces/repos/.git",
                "@/workspaces/repos/node_modules",
                "@/workspaces/repos/dist",
                "@/workspaces/repos/build",
                "@/workspaces/repos/.next",
                "@/workspaces/repos/.nuxt",
                "@/workspaces/repos/.turbo",
                "@/workspaces/repos/.parcel-cache",
                "@/workspaces/repos/.cache",
                "@/workspaces/repos/target",
                "@/workspaces/repos/__pycache__",
                "@/workspaces/repos/.venv",
                "@/workspaces/repos/venv",
                "@/workspaces/repos/vendor",
                "@/workspaces/repos/coverage",
                "--exclude",
                // Excludes are regex matched against the full
                // path of each event. Catches deeper occurrences
                // (e.g. `.../my-pkg/node_modules/`) that the
                // top-level `@<dir>` excludes miss.
                "(^|/)(\\.git|node_modules|dist|build|out|\\.next|\\.nuxt|\\.turbo|\\.parcel-cache|\\.cache|target|__pycache__|\\.venv|venv|vendor|coverage)(/|$)",
                "-e",
                "close_write,move,create,delete",
                "--format",
                "%w%f|%e",
            ],
        )
        .await
    {
        Ok(c) => c,
        Err(e) => return send_error(tx, Some(id), &format!("spawn: {e}")).await,
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return send_error(tx, Some(id), "no stdout").await,
    };
    // Send `ready` so the client knows the subscription is live.
    send_ready(tx, id, json!({ "subscribed": true })).await;

    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (abs, ev) = match trimmed.rsplit_once('|') {
            Some(p) => p,
            None => continue,
        };
        let rest = match abs.strip_prefix("/workspaces/repos/") {
            Some(r) => r,
            None => continue,
        };
        let (repo, path) = match rest.split_once('/') {
            Some(p) => p,
            None => continue,
        };
        if repo.is_empty() || path.is_empty() {
            continue;
        }
        // Unsolicited: no `id`, separate `type`.
        let v: Value = json!({
            "type": "fs_change",
            "data": { "repo": repo, "path": path, "event": ev }
        });
        send_text(tx, v.to_string()).await;
    }
    let _ = child.kill().await;
    send_done(tx, id, json!({ "unsubscribed": true })).await;
}

// Suppress unused-warning helper for Serialize that landed in a
// later iteration — kept around in case we wire structured
// emit types instead of `Value`. Cheap to leave.
#[allow(dead_code)]
#[derive(Serialize)]
struct ChunkEnvelope<T: Serialize> {
    id: String,
    #[serde(rename = "type")]
    ty: &'static str,
    data: T,
}
