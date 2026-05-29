//! Mission fork: snapshot disk + docker state of a running K8sPod
//! mission onto a fresh pod under a new mission UUID.
//!
//! High-level flow (matches the planned design at
//! `~/.claude/plans/ok-now-i-want-witty-raccoon.md`):
//!
//! ```text
//! POST /api/control/missions/:id/fork
//!   1. Validate source mission + K8sPod workspace.
//!   2. INSERT new mission row (parent_mission_id = source.id,
//!      pod_phase = "forking"); respond immediately with the new id.
//!   3. tokio::spawn the heavy work:
//!        a. docker pause + sync inside the source pod
//!        b. VolumeSnapshot {workspaces, docker} PVCs
//!        c. wait for snapshots readyToUse=true
//!        d. docker unpause source dockerd
//!        e. create new PVCs from snapshots
//!        f. SQL bulk-copy mission_events with mission_id rewrite
//!        g. create_forked_mission_pod (force_pull=true)
//!        h. wait_for_ready
//!        i. delete snapshots (PVCs are now independent volumes)
//!   4. On any failure, rollback (destroy new pod + PVCs + snapshots,
//!      mark new mission failed). Source mission never observably
//!      changes besides the brief docker-pause window.
//! ```

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

    let new_mission = control
        .mission_store
        .create_mission_with_parent(
            Some(&new_title),
            Some(source.workspace_id),
            source.agent.as_deref(),
            source.model_override.as_deref(),
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

    // Surface the initial "forking" phase before we return so the
    // dashboard's mission row renders the spinner even on the very
    // first poll.
    let _ = control
        .mission_store
        .update_mission_pod_phase(
            new_mission_id,
            Some("forking"),
            Some("Snapshotting source PVCs"),
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
            tracing::error!(
                source_mission_id = %source_mission_id,
                new_mission_id = %new_mission_id,
                error = %e,
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
        set_phase(
            &mission_store,
            new_mid,
            "forking",
            "Quiescing source dockerd",
        )
        .await;
        let _ = k8s.quiesce_dockerd(source_mid).await;

        set_phase(
            &mission_store,
            new_mid,
            "forking",
            "Creating VolumeSnapshots",
        )
        .await;
        k8s.create_volume_snapshot(&ws_snap, &src_ws_pvc)
            .await
            .context("create workspaces snapshot")?;
        k8s.create_volume_snapshot(&docker_snap, &src_docker_pvc)
            .await
            .context("create docker snapshot")?;

        set_phase(
            &mission_store,
            new_mid,
            "forking",
            "Waiting for snapshots to be ready",
        )
        .await;
        k8s.wait_snapshot_ready(&ws_snap, SNAPSHOT_TIMEOUT)
            .await
            .context("wait workspaces snapshot ready")?;
        k8s.wait_snapshot_ready(&docker_snap, SNAPSHOT_TIMEOUT)
            .await
            .context("wait docker snapshot ready")?;

        // Snapshot data is captured. Source dockerd can resume. We
        // unquiesce eagerly (not just via the guard's Drop) so the
        // source mission's containers wake up the moment the slow
        // snapshot poll finishes.
        let _ = k8s.unquiesce_dockerd(source_mid).await;

        set_phase(
            &mission_store,
            new_mid,
            "forking",
            "Provisioning forked PVCs",
        )
        .await;
        k8s.create_pvc_from_snapshot(&new_ws_pvc, &ws_snap, WORKSPACES_VOLUME_SIZE)
            .await
            .context("create workspaces PVC from snapshot")?;
        k8s.create_pvc_from_snapshot(&new_docker_pvc, &docker_snap, DOCKER_VOLUME_SIZE)
            .await
            .context("create docker PVC from snapshot")?;

        set_phase(
            &mission_store,
            new_mid,
            "forking",
            "Copying conversation events",
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

        set_phase(&mission_store, new_mid, "pulling", "Pulling current image").await;
        k8s.create_forked_mission_pod(new_mid, workspace_id, &env_vars, init_script.as_deref())
            .await
            .context("create forked mission pod")?;

        set_phase(
            &mission_store,
            new_mid,
            "container_starting",
            "Waiting for pod to become ready",
        )
        .await;
        k8s.wait_for_ready(new_mid, POD_READY_TIMEOUT)
            .await
            .context("forked pod did not become ready")?;

        // PVCs are now independent Longhorn volumes; the snapshot
        // CRs are no longer load-bearing. Reclaim them eagerly so
        // `kubectl get volumesnapshot -n sandboxed-sh` stays clean.
        let _ = k8s.delete_volume_snapshot(&ws_snap).await;
        let _ = k8s.delete_volume_snapshot(&docker_snap).await;

        set_phase(&mission_store, new_mid, "ready", "Forked mission is ready").await;
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
            tracing::error!(
                source_mid = %source_mid,
                new_mid = %new_mid,
                error = %e,
                "fork orchestration failed; rolling back"
            );
            // Best-effort rollback. Source mission never observably
            // changes besides the brief docker-pause window.
            let _ = k8s.unquiesce_dockerd(source_mid).await;
            let _ = k8s.destroy_mission_pod(new_mid).await; // pod + 2 PVCs
            let _ = k8s.delete_volume_snapshot(&ws_snap).await;
            let _ = k8s.delete_volume_snapshot(&docker_snap).await;
            let msg = format!("Fork failed: {e}");
            let _ = mission_store
                .update_mission_pod_phase(new_mid, Some("error"), Some(&msg))
                .await;
            let _ = mission_store
                .update_mission_status(new_mid, MissionStatus::Failed)
                .await;
            Err(e)
        }
    }
}

async fn set_phase(
    mission_store: &Arc<dyn MissionStore>,
    mission_id: Uuid,
    phase: &str,
    message: &str,
) {
    let _ = mission_store
        .update_mission_pod_phase(mission_id, Some(phase), Some(message))
        .await;
}
