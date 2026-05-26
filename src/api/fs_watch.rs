//! `/api/control/missions/:id/fs-events` — WebSocket stream of
//! file-system change events from inside the per-mission pod.
//!
//! The dashboard's editor opens one of these per mission and uses
//! the events to refetch open files when they're modified on disk
//! (e.g. the agent edits a file the user is also viewing). Without
//! this stream the editor is pull-once and falls out of sync.
//!
//! Pod-side: `inotifywait -mr /workspaces/repos -e
//! close_write,move,create,delete --format '%w%f|%e'`.
//! `close_write` (not `modify`) is what fires when a write
//! finishes — `modify` would emit hundreds of events per save and
//! trigger refetch storms.
//!
//! Wire (per line):
//!   { "type":"fs_change", "repo":"<repo>", "path":"<rel>",
//!     "event":"CLOSE_WRITE,CLOSE" }
//! Paths outside `/workspaces/repos/<repo>/...` (e.g. inotify's
//! root events on the watched dir itself) are filtered server-side.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
    Extension,
};
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

use super::auth::AuthUser;
use super::routes::AppState;

pub async fn fs_events(
    State(_state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
    Path(mission_id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = run_fs_events(socket, mission_id).await {
            tracing::warn!(
                mission_id = %mission_id,
                error = %e,
                "fs-events bridge ended with error"
            );
        }
    })
}

async fn run_fs_events(socket: WebSocket, mission_id: Uuid) -> anyhow::Result<()> {
    let k8s = crate::k8s_pod::global_client()
        .ok_or_else(|| anyhow::anyhow!("k8s client unavailable (not running in cluster?)"))?;

    // Spawn inotifywait recursively over /workspaces/repos. We
    // request the events that matter for an editor: file writes
    // finishing, creates, deletes, renames. `modify` fires on
    // every byte buffered to disk during a write and would
    // trigger 100+ refetches per save — explicitly excluded.
    let mut child = k8s
        .spawn_streaming_exec(
            mission_id,
            "inotifywait",
            &[
                "-mr",
                "--quiet",
                "/workspaces/repos",
                "-e",
                "close_write,move,create,delete",
                "--format",
                "%w%f|%e",
            ],
        )
        .await?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("inotifywait child has no stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("inotifywait child has no stderr"))?;

    // Drain stderr — inotify's "Setting up watches" banner goes
    // here. Logged at debug so it doesn't drown tracing.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                tracing::debug!(target: "fs_watch.stderr", "{line}");
            }
        }
    });

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut stdout_lines = BufReader::new(stdout).lines();

    // Forward inotify lines as JSON to the WS.
    let to_ws = tokio::spawn(async move {
        while let Ok(Some(line)) = stdout_lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Split "<absolute>|<EVENT,EVENT>"
            let (abs_path, event) = match trimmed.rsplit_once('|') {
                Some(p) => p,
                None => continue,
            };
            // Strip the "/workspaces/repos/" prefix and split off
            // the first segment as the repo name. Anything that
            // doesn't fit the layout (the root dir itself, an
            // event on a top-level repo dir creation, etc.) is
            // dropped — the editor only acts on file paths.
            let rest = match abs_path.strip_prefix("/workspaces/repos/") {
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
            let json = serde_json::json!({
                "type": "fs_change",
                "repo": repo,
                "path": path,
                "event": event,
            });
            if ws_tx.send(Message::Text(json.to_string())).await.is_err() {
                break;
            }
        }
    });

    // Drain inbound WS to detect close (we don't expect data from
    // the client on this channel today; future-proofs for
    // subscribe/unsubscribe filtering).
    let from_ws = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = to_ws => {}
        _ = from_ws => {}
    }
    let _ = child.kill().await;
    Ok(())
}
