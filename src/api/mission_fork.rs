//! Mission fork: snapshot disk + docker state of a running K8sPod
//! mission onto a fresh pod under a new mission UUID.
//!
//! ## Flow
//!
//! ```text
//! POST /api/control/missions/:id/fork
//!   1. Validate source mission + K8sPod workspace.
//!   2. INSERT new mission row (parent_mission_id = source.id,
//!      pod_phase = "forking"); respond immediately with the new id.
//!   3. tokio::spawn the heavy work:
//!        a. SQL bulk-copy mission_events with mission_id rewrite
//!           (FIRST, before anything that can fail — see below).
//!        b. docker pause + sync inside the source pod
//!        c. VolumeSnapshot {workspaces, docker} PVCs with retry
//!           on Harvester CSI transient API conflicts
//!        d. wait for snapshots readyToUse=true
//!        e. docker unpause source dockerd
//!        f. create new PVCs from snapshots
//!        g. create_forked_mission_pod (force_pull=true)
//!        h. wait_for_ready
//!        i. delete snapshots (PVCs are now independent volumes)
//!   4. On any failure, rollback (destroy new pod + PVCs + snapshots,
//!      mark new mission failed). Source mission never observably
//!      changes besides the brief docker-pause window.
//! ```
//!
//! ## Why events copy runs FIRST
//!
//! The disk/docker clone path can fail in non-trivial ways — the
//! Harvester CSI's snapshot controller has a known race with its
//! `VolumeSnapshotBeingCreated` annotation that can wedge a
//! snapshot mid-flight, the pod can fail to schedule, etc. By
//! copying events before any of that, even a failed fork still
//! carries the source's conversation history. The operator
//! navigates to the new mission, sees the chat, and can retry the
//! fork or delete the failed mission with one click. Without this
//! ordering, a failed fork is an empty shell — the operator has
//! lost their landmark and has to manually correlate URLs.
//!
//! Events copy is a single `INSERT … SELECT` in SQLite, so paying
//! the cost up front even on the happy path is negligible.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::api::auth::AuthUser;
use crate::api::control::MissionStatus;
use crate::api::mission_store::MissionStore;
use crate::api::routes::AppState;
use crate::k8s_pod::{
    docker_pvc_name, snapshot_name, workspaces_pvc_name, K8sPodClient, DOCKER_VOLUME_SIZE,
    WORKSPACES_VOLUME_SIZE,
};
use crate::util::internal_error;
use crate::workspace::WorkspaceType;

/// Snapshot READY poll budget. Longhorn v1 typically goes ready in
/// 10-60 s; we allow 5 minutes for slow-disk edge cases. Beyond this
/// the orchestrator gives up + rolls back.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(300);
/// Pod-ready budget on the fork (image pull + start + container
/// ready). `imagePullPolicy: Always` means the fork pays the pull
/// cost even on a node that already has the digest.
const POD_READY_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Default, Deserialize)]
pub struct ForkBody {
    /// Title for the new mission. Defaults to "Fork of <source title>".
    pub title: Option<String>,
    /// Copy only events whose `sequence <= after_sequence`. None copies all
    /// (the topbar "Fork" button case). Threaded for a future
    /// "fork from message N" UI; backend already supports it.
    pub after_sequence: Option<i64>,
    /// Model override for the forked mission. None / empty inherits the
    /// source mission's model (the default one-click fork). The dashboard's
    /// fork picker sends this so the operator can switch models when forking
    /// — e.g. retrying a wedged claudecode mission on a different Opus
    /// version without touching the source.
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ForkResponse {
    pub mission_id: Uuid,
    pub parent_mission_id: Uuid,
}

/// POST /api/control/missions/:id/fork
///
/// Synchronously creates the new mission row + spawns the async
/// orchestrator, then returns. The dashboard navigates to the new
/// mission id immediately; pod_phase updates flow over the existing
/// SSE stream so the operator sees "Snapshotting source PVCs",
/// "Pulling current image", "Forked mission is ready" without any
/// new transport.
pub async fn fork_mission_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(source_mission_id): Path<Uuid>,
    body: Option<Json<ForkBody>>,
) -> Result<Json<ForkResponse>, (StatusCode, String)> {
    let body = body.map(|Json(b)| b).unwrap_or_default();

    let control = state.control.get_or_spawn(&user).await;
    let source = control
        .mission_store
        .get_mission(source_mission_id)
        .await
        .map_err(internal_error)?
        .ok_or((
            StatusCode::NOT_FOUND,
            "source mission not found".to_string(),
        ))?;

    let workspace = state.workspaces.get(source.workspace_id).await.ok_or((
        StatusCode::NOT_FOUND,
        "source mission's workspace not found".to_string(),
    ))?;

    if workspace.workspace_type != WorkspaceType::K8sPod {
        return Err((
            StatusCode::BAD_REQUEST,
            "fork is only supported for k8s_pod workspaces".to_string(),
        ));
    }

    let k8s = crate::k8s_pod::global_client().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "k8s_pod backend not configured".to_string(),
    ))?;

    let new_title = body.title.clone().unwrap_or_else(|| {
        format!(
            "Fork of {}",
            source.title.as_deref().unwrap_or("Untitled mission")
        )
    });

    // The fork inherits the source's model unless the request overrides it
    // (trimmed; an empty string means "inherit", same as omitting it).
    let model_override = body
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or(source.model_override.as_deref());

    let new_mission = control
        .mission_store
        .create_mission_with_parent(
            Some(&new_title),
            Some(source.workspace_id),
            source.agent.as_deref(),
            model_override,
            source.model_effort.as_deref(),
            Some(source.backend.as_str()),
            source.config_profile.as_deref(),
            Some(source.id),
            source.working_directory.as_deref(),
            &[],
        )
        .await
        .map_err(internal_error)?;

    let new_mission_id = new_mission.id;

    // Surface an initial phase before we return so the dashboard's
    // ForkProgressOverlay renders the spinner even on the very first
    // poll (the orchestrator's first real `set_phase_json` lands a
    // few ms later, but the response is on the wire before that).
    let initial_detail = json!({ "label": "Copying conversation events" }).to_string();
    let _ = control
        .mission_store
        .update_mission_pod_phase(
            new_mission_id,
            Some("events_copying"),
            Some(&initial_detail),
        )
        .await;

    let after_seq = body.after_sequence;
    let env_vars = workspace.env_vars.clone();
    let init_script = workspace.init_script.clone();
    let workspace_id = source.workspace_id;
    let mission_store = control.mission_store.clone();

    tokio::spawn(async move {
        if let Err(e) = run_fork(
            k8s,
            mission_store,
            source_mission_id,
            new_mission_id,
            workspace_id,
            env_vars,
            init_script,
            after_seq,
        )
        .await
        {
            // `{:#}` walks the anyhow Context chain so the underlying
            // cause (often a kube ApiError JSON body — "forbidden",
            // "alreadyexists", validation messages) is visible. Plain
            // `{}` only shows the outermost `.context()` string.
            tracing::error!(
                source_mission_id = %source_mission_id,
                new_mission_id = %new_mission_id,
                error = format!("{e:#}"),
                "fork worker failed"
            );
        }
    });

    Ok(Json(ForkResponse {
        mission_id: new_mission_id,
        parent_mission_id: source_mission_id,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn run_fork(
    k8s: Arc<K8sPodClient>,
    mission_store: Arc<dyn MissionStore>,
    source_mid: Uuid,
    new_mid: Uuid,
    workspace_id: Uuid,
    env_vars: HashMap<String, String>,
    init_script: Option<String>,
    after_sequence: Option<i64>,
) -> anyhow::Result<()> {
    let ws_snap = snapshot_name(new_mid, "workspaces");
    let docker_snap = snapshot_name(new_mid, "docker");
    let new_ws_pvc = workspaces_pvc_name(new_mid);
    let new_docker_pvc = docker_pvc_name(new_mid);
    let src_ws_pvc = workspaces_pvc_name(source_mid);
    let src_docker_pvc = docker_pvc_name(source_mid);

    // Defer-style RAII guard: unquiesce the source dockerd no matter
    // how we exit. The guard schedules an async unpause on Drop so a
    // panic / early-return / timeout never leaves containers stuck in
    // `paused`. The orchestrator also unquiesces explicitly on the
    // happy path so containers wake up promptly without waiting for
    // the guard to drop at end-of-function.
    struct UnquiesceGuard {
        k8s: Arc<K8sPodClient>,
        mid: Uuid,
        active: bool,
    }
    impl Drop for UnquiesceGuard {
        fn drop(&mut self) {
            if !self.active {
                return;
            }
            let k8s = self.k8s.clone();
            let mid = self.mid;
            tokio::spawn(async move {
                let _ = k8s.unquiesce_dockerd(mid).await;
            });
        }
    }
    let mut guard = UnquiesceGuard {
        k8s: k8s.clone(),
        mid: source_mid,
        active: true,
    };

    let inner = async {
        // Copy events FIRST — before anything that can fail on the
        // pod / PVC / snapshot side. This way, even when the disk
        // clone path fails (Harvester CSI transient race, snapshot
        // controller hiccup, etc.) the forked mission already
        // carries the source's conversation history. The operator
        // sees the chat when they navigate to the new mission and
        // can decide whether to retry the fork or delete it.
        //
        // Cheap (single `INSERT ... SELECT` per the impl in
        // `mission_store::sqlite.rs`) so we pay it up front even on
        // happy-path forks.
        // === events_copying =============================================
        set_phase_json(
            &mission_store,
            new_mid,
            "events_copying",
            json!({ "label": "Copying conversation events" }),
        )
        .await;
        let copied = mission_store
            .copy_events_into(source_mid, new_mid, after_sequence)
            .await
            .map_err(|e| anyhow::anyhow!("copy_events_into: {e}"))?;
        tracing::info!(
            source_mid = %source_mid,
            new_mid = %new_mid,
            copied_events = copied,
            "fork: events copied"
        );

        // === quiescing_source ==========================================
        set_phase_json(
            &mission_store,
            new_mid,
            "quiescing_source",
            json!({
                "label": "Pausing source pod's docker daemon",
                "events_copied": copied,
            }),
        )
        .await;
        let _ = k8s.quiesce_dockerd(source_mid).await;

        // === snapshotting ==============================================
        // Both snapshots progress in parallel from the snapshot
        // controller's perspective. We update the per-item status
        // as each create + wait pair completes.
        let snap_items = |ws: &str, dk: &str| {
            json!({
                "label": "Snapshotting source disks",
                "items": [
                    {"name": "workspaces", "status": ws},
                    {"name": "docker",     "status": dk},
                ],
            })
        };
        set_phase_json(
            &mission_store,
            new_mid,
            "snapshotting",
            snap_items("pending", "pending"),
        )
        .await;
        // wait_snapshot_ready tolerates the snapshot-controller's
        // own transient errors ("object has been modified" 409
        // reconcile loop, "VolumeSnapshotBeingCreated annotation"
        // race). Only RBAC / missing-class / missing-source-PVC
        // errors short-circuit; everything else is polled out
        // until readyToUse=true.
        k8s.create_volume_snapshot(&ws_snap, &src_ws_pvc)
            .await
            .context("create workspaces snapshot")?;
        k8s.create_volume_snapshot(&docker_snap, &src_docker_pvc)
            .await
            .context("create docker snapshot")?;
        set_phase_json(
            &mission_store,
            new_mid,
            "snapshotting",
            snap_items("in_progress", "in_progress"),
        )
        .await;
        k8s.wait_snapshot_ready(&ws_snap, SNAPSHOT_TIMEOUT)
            .await
            .context("wait workspaces snapshot ready")?;
        set_phase_json(
            &mission_store,
            new_mid,
            "snapshotting",
            snap_items("done", "in_progress"),
        )
        .await;
        k8s.wait_snapshot_ready(&docker_snap, SNAPSHOT_TIMEOUT)
            .await
            .context("wait docker snapshot ready")?;
        set_phase_json(
            &mission_store,
            new_mid,
            "snapshotting",
            snap_items("done", "done"),
        )
        .await;

        // Snapshot data is captured. Source dockerd can resume. We
        // unquiesce eagerly (not just via the guard's Drop) so the
        // source mission's containers wake up the moment the slow
        // snapshot poll finishes.
        let _ = k8s.unquiesce_dockerd(source_mid).await;

        // === pvc_provisioning ==========================================
        let pvc_items = |ws: &str, dk: &str| {
            json!({
                "label": "Claiming forked volumes",
                "items": [
                    {"name": "workspaces", "status": ws},
                    {"name": "docker",     "status": dk},
                ],
            })
        };
        set_phase_json(
            &mission_store,
            new_mid,
            "pvc_provisioning",
            pvc_items("pending", "pending"),
        )
        .await;
        k8s.create_pvc_from_snapshot(&new_ws_pvc, &ws_snap, WORKSPACES_VOLUME_SIZE)
            .await
            .context("create workspaces PVC from snapshot")?;
        set_phase_json(
            &mission_store,
            new_mid,
            "pvc_provisioning",
            pvc_items("done", "in_progress"),
        )
        .await;
        k8s.create_pvc_from_snapshot(&new_docker_pvc, &docker_snap, DOCKER_VOLUME_SIZE)
            .await
            .context("create docker PVC from snapshot")?;
        set_phase_json(
            &mission_store,
            new_mid,
            "pvc_provisioning",
            pvc_items("done", "done"),
        )
        .await;

        // === pod_starting ==============================================
        set_phase_json(
            &mission_store,
            new_mid,
            "pod_starting",
            json!({
                "label": "Starting forked pod",
                "sub": "Pulling current image and attaching volumes",
            }),
        )
        .await;
        k8s.create_forked_mission_pod(new_mid, workspace_id, &env_vars, init_script.as_deref())
            .await
            .context("create forked mission pod")?;
        k8s.wait_for_ready(new_mid, POD_READY_TIMEOUT)
            .await
            .context("forked pod did not become ready")?;

        // Clear the autostack marker the source pod left on its
        // `/workspaces` PVC so bashenv's `docker compose up -d`
        // pass actually fires on the fork. See history for the
        // rationale + best-effort error handling.
        let _ = k8s
            .exec_command(
                new_mid,
                None,
                "/bin/sh",
                &[
                    "-c".to_string(),
                    "rm -f /workspaces/.sandboxed-autostack-done".to_string(),
                ],
                &HashMap::new(),
            )
            .await
            .map_err(|e| {
                tracing::warn!(
                    new_mid = %new_mid,
                    error = %e,
                    "fork: failed to clear autostack marker (compose stack will need manual up)"
                );
            });

        // PVCs are now independent Longhorn volumes; the snapshot
        // CRs are no longer load-bearing. Reclaim them eagerly so
        // `kubectl get volumesnapshot -n sandboxed-sh` stays clean.
        let _ = k8s.delete_volume_snapshot(&ws_snap).await;
        let _ = k8s.delete_volume_snapshot(&docker_snap).await;

        // === dockerd_starting ==========================================
        set_phase_json(
            &mission_store,
            new_mid,
            "dockerd_starting",
            json!({ "label": "Starting Docker daemon inside the pod" }),
        )
        .await;
        k8s.wait_dockerd_ready(new_mid, Duration::from_secs(120))
            .await
            .context("dockerd did not become ready")?;

        // === compose_starting ==========================================
        // Trigger the autostack pass once dockerd is up by running a
        // throwaway bash. The bashenv hook then kicks the background
        // `docker compose up -d` task. We need the trigger because
        // the fork's first agent bash hasn't run yet — but the
        // marker-clear above already happened, so bashenv WILL run
        // the compose-up step on this exec.
        let _ = k8s
            .exec_command(
                new_mid,
                None,
                "/bin/bash",
                &["-c".to_string(), "true".to_string()],
                &HashMap::new(),
            )
            .await;
        // Poll compose service status, surfacing each tick's snapshot
        // into pod_message so the dashboard's per-service sub-list
        // walks starting → healthy live.
        set_phase_json(
            &mission_store,
            new_mid,
            "compose_starting",
            json!({
                "label": "Starting compose services",
                "services": []
            }),
        )
        .await;
        let mission_store_for_cb = mission_store.clone();
        k8s.wait_compose_healthy(new_mid, Duration::from_secs(360), move |services| {
            let store = mission_store_for_cb.clone();
            async move {
                let detail = json!({
                    "label": "Starting compose services",
                    "services": services
                        .iter()
                        .map(|s| json!({
                            "service": s.service,
                            "state": s.state,
                            "health": s.health,
                            "status": s.status,
                            "image": s.image,
                        }))
                        .collect::<Vec<_>>(),
                });
                let _ = store
                    .update_mission_pod_phase(
                        new_mid,
                        Some("compose_starting"),
                        Some(&detail.to_string()),
                    )
                    .await;
            }
        })
        .await
        .context("compose services did not become healthy")?;

        // === ready =====================================================
        set_phase_json(
            &mission_store,
            new_mid,
            "ready",
            json!({ "label": "Forked mission is ready" }),
        )
        .await;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    // Disable the guard — we unquiesced explicitly on the happy
    // path (and again here on the failure path) so the drop is a
    // no-op.
    guard.active = false;

    match inner {
        Ok(()) => Ok(()),
        Err(e) => {
            // `{:#}` walks the full anyhow Context chain so the
            // underlying kube ApiError / webhook denial is visible
            // both in the log AND in the pod_message the dashboard
            // surfaces to the operator.
            let chained = format!("{e:#}");
            tracing::error!(
                source_mid = %source_mid,
                new_mid = %new_mid,
                error = %chained,
                "fork orchestration failed; rolling back"
            );
            // Best-effort rollback. Source mission never observably
            // changes besides the brief docker-pause window.
            let _ = k8s.unquiesce_dockerd(source_mid).await;
            let _ = k8s.destroy_mission_pod(new_mid).await; // pod + 2 PVCs
            let _ = k8s.delete_volume_snapshot(&ws_snap).await;
            let _ = k8s.delete_volume_snapshot(&docker_snap).await;
            set_phase_json(
                &mission_store,
                new_mid,
                "error",
                json!({ "label": "Fork failed", "error": chained }),
            )
            .await;
            let _ = mission_store
                .update_mission_status(new_mid, MissionStatus::Failed)
                .await;
            Err(e)
        }
    }
}

/// Update mission `pod_phase` + `pod_message`, with the message body
/// serialised as JSON for the dashboard's `ForkProgressOverlay` to
/// parse. The overlay JSON-parses `pod_message` opportunistically
/// and falls back to rendering the raw string if it isn't valid
/// JSON — so non-fork phases (which historically wrote plain
/// strings) still work without changes.
async fn set_phase_json(
    mission_store: &Arc<dyn MissionStore>,
    mission_id: Uuid,
    phase: &str,
    detail: serde_json::Value,
) {
    let body = detail.to_string();
    let _ = mission_store
        .update_mission_pod_phase(mission_id, Some(phase), Some(&body))
        .await;
}

// `create_and_wait_snapshot_with_retry` + `is_transient_snapshot_error`
// were removed: they were racing the snapshot-controller's own retry
// loop. The controller emits 409 "object has been modified" errors
// during normal reconcile, and our delete-and-recreate strategy made
// the race permanent. The fix lives in `K8sPodClient::wait_snapshot_ready`
// + `is_terminal_snapshot_error` in `src/k8s_pod.rs` — we just poll
// patiently alongside the controller and let it finish.
