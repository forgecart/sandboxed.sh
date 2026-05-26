//! `/api/control/missions/:id/lsp` — WebSocket bridge between the
//! dashboard's Monaco language-client and a language server
//! running inside the per-mission pod.
//!
//! Wire protocol:
//!   - **WebSocket frames**: bare JSON-RPC messages (no
//!     Content-Length headers). This is the `vscode-ws-jsonrpc`
//!     convention; `monaco-languageclient` defaults to it.
//!   - **LSP stdio**: standard LSP framing
//!     (`Content-Length: N\r\n\r\n<body>`). We frame on the way to
//!     stdin and unframe on the way from stdout.
//!
//! K8sPod-only — other workspace types have no per-mission pod to
//! spawn the LSP into. The dashboard hides the LSP connection on
//! those workspaces.
//!
//! Currently spawns `typescript-language-server --stdio`. The
//! `?lang=<id>` query param is reserved for future expansion
//! (pyright, gopls, rust-analyzer) but only `typescript` is
//! wired today.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    response::Response,
    Extension,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use uuid::Uuid;

use super::auth::AuthUser;
use super::routes::AppState;

#[derive(Debug, Deserialize)]
pub struct LspQuery {
    /// Language id. Today only `typescript` (default). Future:
    /// `python`, `go`, `rust`. Anything else 400s.
    #[serde(default)]
    pub lang: Option<String>,
}

pub async fn lsp_bridge(
    State(_state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
    Path(mission_id): Path<Uuid>,
    Query(q): Query<LspQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let lang = q.lang.as_deref().unwrap_or("typescript");
    if lang != "typescript" {
        return Response::builder()
            .status(400)
            .body(format!("unsupported lang: {lang}").into())
            .unwrap();
    }
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = run_lsp_bridge(socket, mission_id).await {
            tracing::warn!(mission_id = %mission_id, error = %e, "LSP bridge ended with error");
        } else {
            tracing::info!(mission_id = %mission_id, "LSP bridge closed cleanly");
        }
    })
}

async fn run_lsp_bridge(socket: WebSocket, mission_id: Uuid) -> anyhow::Result<()> {
    let k8s = crate::k8s_pod::global_client()
        .ok_or_else(|| anyhow::anyhow!("k8s client unavailable (not running in cluster?)"))?;

    // Spawn typescript-language-server inside the pod. The
    // workspace-base image installs it globally — we invoke the
    // bare binary so `--stdio` framing isn't disturbed by a shell
    // rc file.
    let mut child = k8s
        .spawn_streaming_exec(mission_id, "typescript-language-server", &["--stdio"])
        .await?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("LSP child has no stdin pipe"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("LSP child has no stdout pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("LSP child has no stderr pipe"))?;

    // Drain stderr to tracing so we can see startup banners /
    // crashes — left unattended it'd block when the kernel pipe
    // buffer fills.
    tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut reader = BufReader::new(stderr);
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(nl) = buf.iter().rposition(|b| *b == b'\n') {
                        let line = String::from_utf8_lossy(&buf[..nl]).to_string();
                        for l in line.lines() {
                            if !l.trim().is_empty() {
                                tracing::debug!(target: "lsp.stderr", "{l}");
                            }
                        }
                        buf.drain(..=nl);
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (ws_tx, mut ws_rx) = socket.split();
    let ws_tx = Arc::new(tokio::sync::Mutex::new(ws_tx));

    // Task A: read LSP stdout (framed) → unframe → push body over WS.
    let ws_tx_out = ws_tx.clone();
    let to_ws = tokio::spawn(async move {
        let mut stdout = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut stdout).await {
                Ok(Some(body)) => {
                    let s = match String::from_utf8(body) {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::warn!(error = %e, "LSP body not UTF-8; dropping");
                            continue;
                        }
                    };
                    let mut tx = ws_tx_out.lock().await;
                    if tx.send(Message::Text(s)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "LSP stdout read failed");
                    break;
                }
            }
        }
    });

    // Task B: read WS frames → frame with Content-Length → write to LSP stdin.
    let from_ws = tokio::spawn(async move {
        let mut stdin: ChildStdin = stdin;
        while let Some(msg) = ws_rx.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "LSP WS recv failed");
                    break;
                }
            };
            match msg {
                Message::Text(s) => {
                    if write_lsp_message(&mut stdin, s.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Message::Binary(b) => {
                    if write_lsp_message(&mut stdin, &b).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => {
                    // Axum auto-pongs; nothing to do.
                }
            }
        }
        // Closing stdin signals the LSP to exit cleanly.
        let _ = stdin.shutdown().await;
    });

    // Whichever task ends first triggers teardown.
    tokio::select! {
        _ = to_ws => {}
        _ = from_ws => {}
    }
    let _ = child.kill().await;
    Ok(())
}

/// Read one LSP-framed message from `stdout`. Returns `None` on
/// EOF. Errors on malformed headers or short body.
async fn read_lsp_message(stdout: &mut BufReader<ChildStdout>) -> anyhow::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        let n = stdout.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break; // end of headers
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse().ok();
        }
        // Other headers (Content-Type, etc.) ignored.
    }
    let len =
        content_length.ok_or_else(|| anyhow::anyhow!("LSP message missing Content-Length"))?;
    let mut body = vec![0u8; len];
    stdout.read_exact(&mut body).await?;
    Ok(Some(body))
}

async fn write_lsp_message(stdin: &mut ChildStdin, body: &[u8]) -> anyhow::Result<()> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes()).await?;
    stdin.write_all(body).await?;
    stdin.flush().await?;
    Ok(())
}
