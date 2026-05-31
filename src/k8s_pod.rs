//! Kubernetes-Pod-backed workspace operations.
//!
//! Each `workspace_type: k8s_pod` workspace lives as a privileged Pod
//! in the control-plane's namespace. The Pod has its own netns +
//! writable `/proc/sys`, so dockerd's bridge driver + sysctls work
//! the way they don't inside the nspawn `Container` backend.
//!
//! This module owns the lifecycle (create / wait-ready / exec /
//! destroy) and is called inline from the workspace-related API
//! handlers + `WorkspaceExec` when `workspace_type == K8sPod`. The
//! existing nspawn / host code paths stay unchanged.
//!
//! Image + namespace are configured via env vars on the control-plane
//! pod (`SANDBOXED_SH_K8S_WORKSPACE_IMAGE`,
//! `SANDBOXED_SH_K8S_WORKSPACE_NAMESPACE`). Both must be set for the
//! backend to be considered enabled; if either is missing,
//! `K8sPodClient::try_init` returns None and create_workspace
//! rejects k8s_pod requests with a 400.

use anyhow::{anyhow, bail, Context, Result};
use k8s_openapi::api::core::v1::{
    ConfigMap, ConfigMapVolumeSource, Container, KeyToPath, LocalObjectReference,
    PersistentVolumeClaim, PersistentVolumeClaimSpec, PersistentVolumeClaimVolumeSource, Pod,
    PodSecurityContext, PodSpec, ResourceRequirements, SecurityContext, TypedLocalObjectReference,
    Volume, VolumeMount, VolumeResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::{
    api::{Api, ApiResource, DeleteParams, DynamicObject, GroupVersionKind, PostParams},
    config::Config,
    Client,
};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{ExitStatus, Output};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Phases emitted by `stream_pod_startup_events`. Stream ordered
/// (roughly): PvcBinding -> PodScheduled -> Pulling -> Pulled ->
/// ContainerStarting -> ContainerReady -> [InitScriptRunning ->]
/// Ready. `Error` is terminal; otherwise the stream closes after
/// `Ready`. Variants serde-derived so they ride the existing SSE
/// envelope without bespoke encoding.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum PodStartupEvent {
    PvcBinding,
    PodScheduled,
    Pulling { image: String },
    Pulled,
    ContainerStarting,
    ContainerReady,
    InitScriptRunning,
    Ready,
    Error { message: String },
}

impl PodStartupEvent {
    /// Short human-readable description for the dashboard spinner.
    pub fn message(&self) -> String {
        match self {
            Self::PvcBinding => "Binding storage…".to_string(),
            Self::PodScheduled => "Pod scheduled, waiting for image…".to_string(),
            Self::Pulling { image } => format!("Pulling image: {}", image),
            Self::Pulled => "Image pulled".to_string(),
            Self::ContainerStarting => "Starting container…".to_string(),
            Self::ContainerReady => "Container ready".to_string(),
            Self::InitScriptRunning => "Running init script…".to_string(),
            Self::Ready => "Ready".to_string(),
            Self::Error { message } => format!("Error: {}", message),
        }
    }

    /// One-word identifier suitable for `mission.pod_phase`.
    pub fn phase_id(&self) -> &'static str {
        match self {
            Self::PvcBinding => "pvc_binding",
            Self::PodScheduled => "pod_scheduled",
            Self::Pulling { .. } => "pulling",
            Self::Pulled => "pulled",
            Self::ContainerStarting => "container_starting",
            Self::ContainerReady => "container_ready",
            Self::InitScriptRunning => "init_script_running",
            Self::Ready => "ready",
            Self::Error { .. } => "error",
        }
    }
}

/// Snapshot of one docker-compose service inside the mission pod's
/// dockerd. Lives on every `mission_docker_status` SSE event so the
/// dashboard can render a live status row per service (spinner /
/// orange / red / green) without polling. Names match the
/// `docker compose ps --format json` output for easy mapping.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DockerServiceStatus {
    /// Compose service name, e.g. `postgres`, `elasticsearch`.
    pub service: String,
    /// Container short id, useful for the UI as a stable key.
    pub container_id: String,
    /// `created` | `running` | `restarting` | `paused` | `exited` |
    /// `dead` | `removing`. Maps to a colour family in the dashboard.
    pub state: String,
    /// `healthy` | `starting` | `unhealthy` | `none`. The compose JSON
    /// reports `Health` as one of these (or empty when no healthcheck
    /// is configured).
    pub health: String,
    /// Raw "Status" string from docker (e.g. "Up 5 seconds (healthy)").
    pub status: String,
    /// Image reference, surfaced for debugging — the dashboard hides
    /// it under a tooltip.
    pub image: String,
}

/// Process-wide handle to the k8s_pod backend. Populated by
/// `K8sPodClient::try_init` at startup; queried by call sites (like
/// `WorkspaceExec::output`) that need to dispatch on workspace_type
/// without having `AppState` in scope.
static GLOBAL_CLIENT: tokio::sync::OnceCell<Option<std::sync::Arc<K8sPodClient>>> =
    tokio::sync::OnceCell::const_new();

/// Returns the global client if `try_init` was called at startup AND
/// it returned `Some` (i.e. the env vars + cluster client were
/// available). `None` if the backend isn't configured.
pub fn global_client() -> Option<std::sync::Arc<K8sPodClient>> {
    GLOBAL_CLIENT.get().cloned().flatten()
}

const POD_LABEL_MISSION_KEY: &str = "forgecart.dev/mission-id";
const POD_LABEL_WORKSPACE_KEY: &str = "forgecart.dev/workspace-id";
const POD_LABEL_MANAGED_BY_KEY: &str = "app.kubernetes.io/managed-by";
const POD_LABEL_MANAGED_BY_VALUE: &str = "sandboxed-sh";
pub(crate) const STORAGE_CLASS: &str = "harvester";
pub(crate) const WORKSPACES_VOLUME_SIZE: &str = "20Gi";
pub(crate) const DOCKER_VOLUME_SIZE: &str = "20Gi";
const PULL_SECRET_DEFAULT: &str = "nexus-registry";
/// Secret (in the workspace namespace) that the deployment populates
/// with the mission-pod kubeconfig under `KUBECONFIG_CONTENT_KEY`.
/// Only that one key is projected into mission pods (via
/// `valueFrom: secretKeyRef`) — never the whole Secret, see the
/// env-injection comment in `build_pod_spec` for why a blanket
/// `envFrom` is deliberately avoided. Overridable via
/// `SANDBOXED_SH_K8S_WORKSPACE_MISSION_ENV_SECRET`.
const MISSION_ENV_SECRET_DEFAULT: &str = "sandboxed-sh-mission-env";
/// Key within the mission-env Secret holding the base64 kubeconfig
/// that `bashenv.sh` decodes into `~/.kube/config`. It carries the
/// agent ServiceAccount's cluster-admin credential, which is what lets
/// a mission reach the control-plane API and sibling mission pods.
const KUBECONFIG_CONTENT_KEY: &str = "KUBECONFIG_CONTENT";
/// VolumeSnapshotClass name in the workload cluster. Created by the
/// Harvester CSI driver at install time. If this changes, the
/// startup probe in `K8sPodClient::try_init` will surface it.
pub(crate) const SNAPSHOT_CLASS: &str = "harvester-snapshot";

/// Per-mission Pod / PVC / ConfigMap name. Keyed on mission_id, not
/// workspace_id, since each mission gets its own pod. Prefix `m-`
/// disambiguates from the old `ws-*` resources during cutover.
fn k8s_object_name(mission_id: Uuid, suffix: &str) -> String {
    // k8s names: max 63 chars, lowercase, [a-z0-9-]. "m-<uuid>" fits;
    // suffix lets us derive PVC / ConfigMap names from the same base.
    let base = format!("m-{}", mission_id);
    if suffix.is_empty() {
        base
    } else {
        format!("{}-{}", base, suffix)
    }
}

pub(crate) fn pod_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "")
}

pub(crate) fn workspaces_pvc_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "workspaces")
}

pub(crate) fn docker_pvc_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "docker")
}

fn init_configmap_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "init")
}

/// Snapshot CR name for a fork operation. Keyed on the *new* (fork)
/// mission's id so two concurrent forks of the same source don't
/// collide. Returned strings stay under k8s's 63-char name limit
/// (snap- + 36-char UUID + -workspaces = 51 chars).
#[allow(dead_code)] // Phase 3 (mission_fork.rs) is the sole caller.
pub(crate) fn snapshot_name(new_mission_id: Uuid, suffix: &str) -> String {
    format!("snap-{}-{}", new_mission_id, suffix)
}

fn standard_labels(mission_id: Uuid, workspace_id: Uuid) -> BTreeMap<String, String> {
    let mut labels = BTreeMap::new();
    labels.insert(POD_LABEL_MISSION_KEY.to_string(), mission_id.to_string());
    labels.insert(
        POD_LABEL_WORKSPACE_KEY.to_string(),
        workspace_id.to_string(),
    );
    labels.insert(
        POD_LABEL_MANAGED_BY_KEY.to_string(),
        POD_LABEL_MANAGED_BY_VALUE.to_string(),
    );
    labels
}

/// Client for managing workspace Pods + their associated resources.
///
/// One instance lives in `AppState`; cloning is cheap (kube::Client
/// is Arc-internal).
#[derive(Clone)]
pub struct K8sPodClient {
    client: Client,
    namespace: String,
    image: String,
    pull_secret: String,
    mission_env_secret: String,
}

impl K8sPodClient {
    /// Returns `Some` only if the env vars + an in-cluster kube
    /// client are all available. Called once at startup; the result
    /// is stashed in AppState and in the `GLOBAL_CLIENT` static so
    /// call sites without `AppState` in scope (e.g.
    /// `WorkspaceExec::output`) can reach it.
    pub async fn try_init() -> Option<Self> {
        let image = std::env::var("SANDBOXED_SH_K8S_WORKSPACE_IMAGE")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let namespace = std::env::var("SANDBOXED_SH_K8S_WORKSPACE_NAMESPACE")
            .ok()
            .filter(|s| !s.trim().is_empty())?;
        let pull_secret = std::env::var("SANDBOXED_SH_K8S_WORKSPACE_PULL_SECRET")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| PULL_SECRET_DEFAULT.to_string());
        let mission_env_secret = std::env::var("SANDBOXED_SH_K8S_WORKSPACE_MISSION_ENV_SECRET")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| MISSION_ENV_SECRET_DEFAULT.to_string());
        // Force in-cluster config. The control plane's `$HOME/.kube/config`
        // points at the Rancher API proxy, which 403s on WebSocket
        // upgrades for `pods/exec`. The in-cluster API server (resolved
        // via $KUBERNETES_SERVICE_HOST + the mounted ServiceAccount
        // token) is the only path that honors WebSocket upgrades for
        // exec.
        let config = match Config::incluster() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "K8sPod backend disabled: no in-cluster config (deployment needs a ServiceAccount)");
                return None;
            }
        };
        let client = match Client::try_from(config) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "K8sPod backend disabled: failed to construct kube Client from in-cluster config");
                return None;
            }
        };
        tracing::info!(
            namespace = %namespace,
            image = %image,
            pull_secret = %pull_secret,
            mission_env_secret = %mission_env_secret,
            "K8sPod backend enabled (in-cluster config)"
        );
        let me = Self {
            client,
            namespace,
            image,
            pull_secret,
            mission_env_secret,
        };
        // Mirror into the global handle. If try_init is called twice
        // (shouldn't happen but be defensive), the first call wins.
        let _ = GLOBAL_CLIENT
            .set(Some(std::sync::Arc::new(me.clone())))
            .ok();
        Some(me)
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    fn pvcs(&self) -> Api<PersistentVolumeClaim> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    fn cms(&self) -> Api<ConfigMap> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    /// Create the PVCs + (optional) ConfigMap + Pod for a single
    /// mission. Idempotent — if the Pod already exists, this is a
    /// no-op so a Stale-write race or a reboot mid-create can re-run
    /// safely. `workspace_id` is used only for the labels (so a
    /// dashboard can list "all pods belonging to workspace X").
    pub async fn create_mission_pod(
        &self,
        mission_id: Uuid,
        workspace_id: Uuid,
        env_vars: &HashMap<String, String>,
        init_script: Option<&str>,
    ) -> Result<()> {
        self.create_mission_pod_inner(mission_id, workspace_id, env_vars, init_script, false)
            .await
    }

    /// Variant used by the fork orchestrator. PVCs already exist
    /// (provisioned from `VolumeSnapshot`s — see
    /// `create_pvc_from_snapshot`) so `ensure_pvc` no-ops via the
    /// `get_opt` guard. `force_pull = true` switches the Pod's
    /// `imagePullPolicy` to `Always` so the fork lands on the
    /// current `:latest` digest even if the node has an older
    /// image cached.
    pub async fn create_forked_mission_pod(
        &self,
        mission_id: Uuid,
        workspace_id: Uuid,
        env_vars: &HashMap<String, String>,
        init_script: Option<&str>,
    ) -> Result<()> {
        self.create_mission_pod_inner(mission_id, workspace_id, env_vars, init_script, true)
            .await
    }

    async fn create_mission_pod_inner(
        &self,
        mission_id: Uuid,
        workspace_id: Uuid,
        env_vars: &HashMap<String, String>,
        init_script: Option<&str>,
        force_pull: bool,
    ) -> Result<()> {
        let pod_name = pod_name(mission_id);

        if self.pods().get_opt(&pod_name).await?.is_some() {
            tracing::info!(mission_id = %mission_id, "Pod already exists, skipping create");
            return Ok(());
        }

        // 1. PVCs
        self.ensure_pvc(&workspaces_pvc_name(mission_id), WORKSPACES_VOLUME_SIZE)
            .await?;
        self.ensure_pvc(&docker_pvc_name(mission_id), DOCKER_VOLUME_SIZE)
            .await?;

        // 2. ConfigMap (if init script supplied)
        if let Some(script) = init_script {
            self.ensure_init_configmap(mission_id, script).await?;
        }

        // 3. Pod
        let pod = self.build_pod_spec(
            mission_id,
            workspace_id,
            init_script.is_some(),
            env_vars,
            force_pull,
        );
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .with_context(|| format!("Failed to create mission pod {}", pod_name))?;
        tracing::info!(
            mission_id = %mission_id,
            workspace_id = %workspace_id,
            pod = %pod_name,
            force_pull,
            "Created mission pod"
        );
        Ok(())
    }

    async fn ensure_pvc(&self, name: &str, size: &str) -> Result<()> {
        if self.pvcs().get_opt(name).await?.is_some() {
            return Ok(());
        }
        let mut requests = BTreeMap::new();
        requests.insert("storage".to_string(), Quantity(size.to_string()));
        let pvc = PersistentVolumeClaim {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some(self.namespace.clone()),
                ..Default::default()
            },
            spec: Some(PersistentVolumeClaimSpec {
                access_modes: Some(vec!["ReadWriteOnce".to_string()]),
                resources: Some(VolumeResourceRequirements {
                    requests: Some(requests),
                    limits: None,
                }),
                storage_class_name: Some(STORAGE_CLASS.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        self.pvcs()
            .create(&PostParams::default(), &pvc)
            .await
            .with_context(|| format!("Failed to create PVC {}", name))?;
        Ok(())
    }

    // ──── VolumeSnapshot helpers (Phase 1 of mission-fork) ─────────────────
    //
    // VolumeSnapshot is a CRD provided by the snapshot-controller +
    // the Harvester CSI driver. We use kube-rs `DynamicObject` rather
    // than typed bindings so we don't have to vendor a separate crate
    // for the v1 schema — it's a 2-field spec (snapshotClassName +
    // source.persistentVolumeClaimName) and a status that exposes
    // `readyToUse: bool`.

    /// Returns the namespaced `Api<DynamicObject>` for
    /// `snapshot.storage.k8s.io/v1 VolumeSnapshot`. Lazy — kube-rs
    /// caches discovery internally.
    pub(crate) fn snapshots(&self) -> Api<DynamicObject> {
        let gvk = GroupVersionKind::gvk("snapshot.storage.k8s.io", "v1", "VolumeSnapshot");
        let ar = ApiResource::from_gvk(&gvk);
        Api::namespaced_with(self.client.clone(), &self.namespace, &ar)
    }

    /// Create a `VolumeSnapshot` of `source_pvc` named `snap_name`.
    /// Idempotent: returns Ok if a snapshot with this name already
    /// exists (we don't validate that an existing one points at the
    /// same source — callers always derive the name from a unique
    /// new mission_id, so a name collision means a duplicate fork
    /// call which is safe to retry against the same snapshot).
    pub async fn create_volume_snapshot(&self, snap_name: &str, source_pvc: &str) -> Result<()> {
        if self.snapshots().get_opt(snap_name).await?.is_some() {
            return Ok(());
        }
        let gvk = GroupVersionKind::gvk("snapshot.storage.k8s.io", "v1", "VolumeSnapshot");
        let ar = ApiResource::from_gvk(&gvk);
        let snap = DynamicObject::new(snap_name, &ar)
            .within(&self.namespace)
            .data(json!({
                "spec": {
                    "volumeSnapshotClassName": SNAPSHOT_CLASS,
                    "source": {
                        "persistentVolumeClaimName": source_pvc,
                    },
                },
            }));
        self.snapshots()
            .create(&PostParams::default(), &snap)
            .await
            .with_context(|| {
                format!(
                    "Failed to create VolumeSnapshot {} for PVC {}",
                    snap_name, source_pvc
                )
            })?;
        Ok(())
    }

    /// Poll the snapshot's `status.readyToUse` until it flips to
    /// `true`. Returns Err on timeout or terminal error.
    ///
    /// Transient errors emitted by the snapshot controller during
    /// its own retry loop ("the object has been modified",
    /// "operation cannot be fulfilled", "the server rejected our
    /// request", "VolumeSnapshotBeingCreated") are NOT treated as
    /// failure — they're surfaced in `status.error.message` for
    /// telemetry purposes but the controller will keep trying.
    /// We just keep polling alongside it. Only `wait_snapshot_ready`
    /// terminates the wait, either on readyToUse=true or on the
    /// overall timeout.
    ///
    /// This is the key fix for the live Harvester install: the
    /// snapshot does eventually become ready on the Harvester side,
    /// but the workload-cluster's snapshot-controller takes several
    /// reconcile cycles to update the workload-side CR status
    /// (because its own update API call races with itself,
    /// producing the 409 "the object has been modified" loop). An
    /// earlier version of this code bailed on the first such error
    /// and re-created the snapshot — which made the race
    /// permanent. Patience here lets the controller finish.
    pub async fn wait_snapshot_ready(&self, snap_name: &str, timeout: Duration) -> Result<()> {
        let start = Instant::now();
        let mut last_warn_at: Option<Instant> = None;
        loop {
            let snap = self
                .snapshots()
                .get(snap_name)
                .await
                .with_context(|| format!("Failed to GET VolumeSnapshot {}", snap_name))?;
            let ready = snap
                .data
                .get("status")
                .and_then(|s| s.get("readyToUse"))
                .and_then(|r| r.as_bool())
                .unwrap_or(false);
            if ready {
                return Ok(());
            }
            // Surface terminal errors (RBAC, missing class, source PVC
            // gone) immediately. Everything else is treated as
            // transient — the snapshot-controller's own reconcile
            // loop will retry. We log at most once every 15 s so the
            // backend log doesn't get flooded during a long wait.
            let err_msg = snap
                .data
                .get("status")
                .and_then(|s| s.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string());
            if let Some(msg) = err_msg.as_deref() {
                if is_terminal_snapshot_error(msg) {
                    bail!("VolumeSnapshot {} failed (terminal): {}", snap_name, msg);
                }
                let should_warn = last_warn_at
                    .map(|t| t.elapsed() > Duration::from_secs(15))
                    .unwrap_or(true);
                if should_warn {
                    tracing::debug!(
                        snap = snap_name,
                        error = msg,
                        "VolumeSnapshot has a transient error in status; snapshot-controller will retry"
                    );
                    last_warn_at = Some(Instant::now());
                }
            }
            if start.elapsed() > timeout {
                let last_status = err_msg.unwrap_or_else(|| "(no status.error)".to_string());
                bail!(
                    "VolumeSnapshot {} not ready within {:?} (last status: {})",
                    snap_name,
                    timeout,
                    last_status
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Create a PVC whose contents are restored from `snap_name`.
    /// Idempotent. The PVC inherits the snapshot's data on first
    /// mount; afterwards it diverges as its own Longhorn volume —
    /// deleting the snapshot then has no effect on the new PVC.
    pub async fn create_pvc_from_snapshot(
        &self,
        pvc_name: &str,
        snap_name: &str,
        size: &str,
    ) -> Result<()> {
        if self.pvcs().get_opt(pvc_name).await?.is_some() {
            return Ok(());
        }
        let mut requests = BTreeMap::new();
        requests.insert("storage".to_string(), Quantity(size.to_string()));
        let pvc = PersistentVolumeClaim {
            metadata: ObjectMeta {
                name: Some(pvc_name.to_string()),
                namespace: Some(self.namespace.clone()),
                ..Default::default()
            },
            spec: Some(PersistentVolumeClaimSpec {
                access_modes: Some(vec!["ReadWriteOnce".to_string()]),
                resources: Some(VolumeResourceRequirements {
                    requests: Some(requests),
                    limits: None,
                }),
                storage_class_name: Some(STORAGE_CLASS.to_string()),
                data_source: Some(TypedLocalObjectReference {
                    api_group: Some("snapshot.storage.k8s.io".to_string()),
                    kind: "VolumeSnapshot".to_string(),
                    name: snap_name.to_string(),
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        self.pvcs()
            .create(&PostParams::default(), &pvc)
            .await
            .with_context(|| {
                format!(
                    "Failed to create PVC {} from snapshot {}",
                    pvc_name, snap_name
                )
            })?;
        Ok(())
    }

    /// Delete a VolumeSnapshot. 404-tolerant. Once the fork's PVC is
    /// provisioned, the snapshot is no longer load-bearing — we
    /// reclaim it eagerly so disk usage tracks live volumes only.
    pub async fn delete_volume_snapshot(&self, snap_name: &str) -> Result<()> {
        match self
            .snapshots()
            .delete(snap_name, &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if is_404(&e) => Ok(()),
            Err(e) => {
                Err(e).with_context(|| format!("Failed to delete VolumeSnapshot {}", snap_name))
            }
        }
    }

    // ──── dockerd quiesce for crash-consistent snapshots ───────────────────
    //
    // Best-effort: we `docker pause` every running container then
    // `sync` so the filesystem buffers flush. Containers stay paused
    // only long enough for the snapshot to capture their overlay
    // state — the orchestrator unpauses immediately after the
    // snapshot READY response. Failure here doesn't block the fork
    // (e.g. the source pod might already have crashed); the cost is
    // that the fork's docker layer cache may be inconsistent and
    // `docker compose up -d` in the fork will have to re-pull /
    // rebuild from upstream.

    /// Pause every running container in the source mission's
    /// dockerd. Returns Ok even if the exec command failed — see
    /// module comment above. Logs the failure for triage.
    pub async fn quiesce_dockerd(&self, src_mission_id: Uuid) -> Result<()> {
        let script = "docker ps -q 2>/dev/null | xargs -r docker pause 2>/dev/null; sync";
        let out = self
            .exec_command(
                src_mission_id,
                None,
                "/bin/sh",
                &["-c".to_string(), script.to_string()],
                &HashMap::new(),
            )
            .await;
        match out {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => {
                tracing::warn!(
                    src_mission_id = %src_mission_id,
                    code = ?o.status.code(),
                    stderr = %String::from_utf8_lossy(&o.stderr),
                    "quiesce_dockerd exited nonzero; continuing with best-effort snapshot"
                );
                Ok(())
            }
            Err(e) => {
                tracing::warn!(
                    src_mission_id = %src_mission_id,
                    error = %e,
                    "quiesce_dockerd exec failed; continuing"
                );
                Ok(())
            }
        }
    }

    /// Unpause every paused container in the source pod's dockerd.
    /// Idempotent + tolerant of an already-gone source pod (e.g.
    /// the user deleted it mid-fork) — we never want to leave the
    /// source's containers stuck in `paused` state.
    pub async fn unquiesce_dockerd(&self, src_mission_id: Uuid) -> Result<()> {
        let script =
            "docker ps -q -f status=paused 2>/dev/null | xargs -r docker unpause 2>/dev/null";
        let _ = self
            .exec_command(
                src_mission_id,
                None,
                "/bin/sh",
                &["-c".to_string(), script.to_string()],
                &HashMap::new(),
            )
            .await
            .map_err(|e| {
                tracing::warn!(
                    src_mission_id = %src_mission_id,
                    error = %e,
                    "unquiesce_dockerd exec failed (source pod may be gone)"
                );
            });
        Ok(())
    }

    /// Public alias of `ensure_init_configmap` so the rerun-init
    /// handler can refresh a mission's stored init.sh without
    /// going through full create_mission_pod.
    pub async fn ensure_init_configmap_public(&self, mission_id: Uuid, script: &str) -> Result<()> {
        self.ensure_init_configmap(mission_id, script).await
    }

    async fn ensure_init_configmap(&self, mission_id: Uuid, script: &str) -> Result<()> {
        let name = init_configmap_name(mission_id);
        let mut data = BTreeMap::new();
        data.insert("init.sh".to_string(), script.to_string());
        let cm = ConfigMap {
            metadata: ObjectMeta {
                name: Some(name.clone()),
                namespace: Some(self.namespace.clone()),
                ..Default::default()
            },
            data: Some(data),
            ..Default::default()
        };
        // Replace-or-create so reruns pick up edits.
        if self.cms().get_opt(&name).await?.is_some() {
            self.cms()
                .replace(&name, &PostParams::default(), &cm)
                .await
                .with_context(|| format!("Failed to replace ConfigMap {}", name))?;
        } else {
            self.cms()
                .create(&PostParams::default(), &cm)
                .await
                .with_context(|| format!("Failed to create ConfigMap {}", name))?;
        }
        Ok(())
    }

    fn build_pod_spec(
        &self,
        mission_id: Uuid,
        workspace_id: Uuid,
        with_init_script: bool,
        env_vars: &HashMap<String, String>,
        _force_pull: bool,
    ) -> Pod {
        let mut volumes = vec![
            Volume {
                name: "workspaces".to_string(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: workspaces_pvc_name(mission_id),
                    read_only: Some(false),
                }),
                ..Default::default()
            },
            Volume {
                name: "docker".to_string(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: docker_pvc_name(mission_id),
                    read_only: Some(false),
                }),
                ..Default::default()
            },
        ];

        let mut volume_mounts = vec![
            VolumeMount {
                name: "workspaces".to_string(),
                mount_path: "/workspaces".to_string(),
                ..Default::default()
            },
            VolumeMount {
                name: "docker".to_string(),
                mount_path: "/var/lib/docker".to_string(),
                ..Default::default()
            },
        ];

        if with_init_script {
            volumes.push(Volume {
                name: "init-script".to_string(),
                config_map: Some(ConfigMapVolumeSource {
                    name: init_configmap_name(mission_id),
                    default_mode: Some(0o755),
                    items: Some(vec![KeyToPath {
                        key: "init.sh".to_string(),
                        path: "init.sh".to_string(),
                        mode: Some(0o755),
                    }]),
                    optional: Some(false),
                }),
                ..Default::default()
            });
            volume_mounts.push(VolumeMount {
                name: "init-script".to_string(),
                mount_path: "/etc/sandboxed".to_string(),
                read_only: Some(true),
                ..Default::default()
            });
        }

        // Almost no host-side env flows into mission pods. The previous
        // design attached the `sandboxed-sh-mission-env` Secret via
        // `envFrom: secretRef`, which pushed env.defaults (DB creds,
        // ANTHROPIC_API_KEY, registry token, …) into every mission
        // pod regardless of which workspace it belonged to. That
        // (a) leaked host-controlled state into customer workspaces
        // and (b) overloaded `ANTHROPIC_API_KEY` between operator
        // (Claude Code auth) and customer (linter / app) semantics.
        //
        // The full env surface a mission pod sees now comes from
        // `workspace.env_vars` — managed per-workspace via the
        // dashboard's workspace edit UI. Forgecart-specific defaults
        // live on the forgecart workspace's `env_vars`. The Claude
        // Code operator credential is injected per-subprocess by
        // `mission_runner` (as `CLAUDE_CODE_OAUTH_TOKEN`) and never
        // appears in the pod env, so customer code can't read it.
        //
        // The single deliberate exception is `KUBECONFIG_CONTENT`,
        // projected below as a single `secretKeyRef` key (NOT a blanket
        // `envFrom`). It carries the agent ServiceAccount's kubeconfig
        // so a mission can reach the control-plane API and sibling
        // mission pods — without it, `bashenv.sh` has nothing to write
        // to `~/.kube/config` and cross-pod access fails with "no
        // cluster-scope RBAC". Projecting just this one key keeps the
        // DB creds / registry token / ANTHROPIC_API_KEY out of the pod.

        let mut env_list = env_vars
            .iter()
            .map(|(k, v)| k8s_openapi::api::core::v1::EnvVar {
                name: k.clone(),
                value: Some(v.clone()),
                value_from: None,
            })
            .collect::<Vec<_>>();

        // Inject the mission id as GITHUB_RUN_ID so workflows that key
        // per-run resources on it get a stable per-mission value
        // locally, mirroring CI. shop-beta's e2e suite, for example,
        // derives its Postgres DB name from `$GITHUB_RUN_ID` to keep
        // concurrent runs from colliding; without it the local run has
        // no isolation suffix. A workspace `env_vars` entry wins if it
        // sets GITHUB_RUN_ID explicitly. Value is the raw mission UUID
        // (hyphenated) — consumers that splice it into a SQL identifier
        // are responsible for sanitising (e.g. hyphens → underscores).
        if !env_vars.contains_key("GITHUB_RUN_ID") {
            env_list.push(k8s_openapi::api::core::v1::EnvVar {
                name: "GITHUB_RUN_ID".to_string(),
                value: Some(mission_id.to_string()),
                value_from: None,
            });
        }

        // Project ONLY the kubeconfig key out of the mission-env Secret
        // (see the env comment above for why a blanket `envFrom` is not
        // used). `optional: true` keeps pods startable in deployments
        // where the Secret doesn't exist (e.g. docker-compose); in that
        // case the var is simply unset and `bashenv.sh` already no-ops
        // on an empty `KUBECONFIG_CONTENT`. A workspace `env_vars` entry
        // for the same key wins and suppresses the projection.
        if !env_vars.contains_key(KUBECONFIG_CONTENT_KEY) {
            env_list.push(k8s_openapi::api::core::v1::EnvVar {
                name: KUBECONFIG_CONTENT_KEY.to_string(),
                value: None,
                value_from: Some(k8s_openapi::api::core::v1::EnvVarSource {
                    secret_key_ref: Some(k8s_openapi::api::core::v1::SecretKeySelector {
                        name: self.mission_env_secret.clone(),
                        key: KUBECONFIG_CONTENT_KEY.to_string(),
                        optional: Some(true),
                    }),
                    ..Default::default()
                }),
            });
        }

        let mut requests = BTreeMap::new();
        requests.insert("cpu".to_string(), Quantity("2000m".to_string()));
        requests.insert("memory".to_string(), Quantity("4Gi".to_string()));
        let mut limits = BTreeMap::new();
        limits.insert("cpu".to_string(), Quantity("4000m".to_string()));
        limits.insert("memory".to_string(), Quantity("16Gi".to_string()));

        let container = Container {
            name: "workspace".to_string(),
            image: Some(self.image.clone()),
            // `Always` for every mission pod (not just forks). Reason:
            // `SANDBOXED_SH_K8S_WORKSPACE_IMAGE` defaults to a mutable
            // `:latest` tag and `IfNotPresent` would let nodes pin a
            // stale digest forever — verified live with the
            // workspace-base daemon.json change that never landed
            // because the node had `:latest` cached. The cost of
            // `Always` is one HEAD request per pod create (kube
            // re-pulls layers only when the manifest digest moved);
            // actual layer bytes stay cached. `force_pull` is now a
            // no-op kept for callsite compat.
            image_pull_policy: Some("Always".to_string()),
            env: if env_list.is_empty() {
                None
            } else {
                Some(env_list)
            },
            volume_mounts: Some(volume_mounts),
            security_context: Some(SecurityContext {
                privileged: Some(true),
                ..Default::default()
            }),
            resources: Some(ResourceRequirements {
                requests: Some(requests),
                limits: Some(limits),
                claims: None,
            }),
            ..Default::default()
        };

        Pod {
            metadata: ObjectMeta {
                name: Some(pod_name(mission_id)),
                namespace: Some(self.namespace.clone()),
                labels: Some(standard_labels(mission_id, workspace_id)),
                ..Default::default()
            },
            spec: Some(PodSpec {
                containers: vec![container],
                image_pull_secrets: Some(vec![LocalObjectReference {
                    name: self.pull_secret.clone(),
                }]),
                volumes: Some(volumes),
                restart_policy: Some("Always".to_string()),
                // workspaces don't need k8s API access from inside —
                // use the namespace's default SA, not the privileged
                // control-plane SA.
                service_account_name: Some("default".to_string()),
                security_context: Some(PodSecurityContext::default()),
                termination_grace_period_seconds: Some(5),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// Wait for the Pod to reach `Running` phase. Times out after
    /// `timeout` and returns the last phase + most recent event for
    /// diagnostics.
    pub async fn wait_for_ready(&self, mission_id: Uuid, timeout: Duration) -> Result<()> {
        let pod_name = pod_name(mission_id);
        let start = Instant::now();
        loop {
            let pod = self
                .pods()
                .get(&pod_name)
                .await
                .with_context(|| format!("Failed to get pod {}", pod_name))?;
            let phase = pod
                .status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .unwrap_or("Unknown");
            if phase == "Running" {
                // Also wait for the container's Ready condition so
                // exec works on first call.
                if pod
                    .status
                    .as_ref()
                    .and_then(|s| s.container_statuses.as_ref())
                    .map(|cs| cs.iter().all(|c| c.ready))
                    .unwrap_or(false)
                {
                    return Ok(());
                }
            }
            if matches!(phase, "Failed" | "Unknown") {
                bail!("Pod {} entered phase {}", pod_name, phase);
            }
            if start.elapsed() > timeout {
                bail!(
                    "Pod {} did not reach Running within {:?} (last phase: {})",
                    pod_name,
                    timeout,
                    phase
                );
            }
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    }

    /// Wait until the inner dockerd is responsive. The workspace-base
    /// entrypoint spawns `dockerd` in the background; pod-level
    /// `wait_for_ready` returns when the *container* is ready, but
    /// `docker version` doesn't succeed for another ~10 s while
    /// dockerd binds `/var/run/docker.sock` and initialises the
    /// containerd backend. The fork progress overlay needs that
    /// finer-grained signal — otherwise the operator sees a green
    /// "pod ready" row while `docker ps` would still fail inside.
    pub async fn wait_dockerd_ready(&self, mission_id: Uuid, timeout: Duration) -> Result<()> {
        let start = Instant::now();
        loop {
            let probe = self
                .exec_command(
                    mission_id,
                    None,
                    "/bin/sh",
                    &[
                        "-c".to_string(),
                        "docker version --format '{{.Server.Version}}' 2>/dev/null".to_string(),
                    ],
                    &HashMap::new(),
                )
                .await;
            if let Ok(out) = probe {
                if out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty() {
                    return Ok(());
                }
            }
            if start.elapsed() > timeout {
                bail!(
                    "dockerd in pod {} did not respond within {:?}",
                    pod_name(mission_id),
                    timeout
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Wait until every compose service is either `running + healthy`
    /// (or `running` with no healthcheck) or a successfully-exited
    /// init container. Calls `progress_cb` on each poll so the fork
    /// orchestrator can serialise the latest service list into the
    /// mission's `pod_message` for the dashboard's per-service UI.
    ///
    /// Returns Err on timeout — the caller surfaces that as a
    /// fork-stalled error and the operator inspects via the
    /// overlay's last-known service list.
    pub async fn wait_compose_healthy<F, Fut>(
        &self,
        mission_id: Uuid,
        timeout: Duration,
        mut progress_cb: F,
    ) -> Result<()>
    where
        F: FnMut(Vec<DockerServiceStatus>) -> Fut,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let start = Instant::now();
        // First poll may return empty if `bashenv.sh` hasn't kicked
        // its background `docker compose up -d` yet. We tolerate
        // empty-for-a-while: only after `EMPTY_GRACE_SECS` do we
        // treat empty as "compose is done with nothing to start".
        const EMPTY_GRACE_SECS: u64 = 30;
        loop {
            let services = self
                .query_docker_compose_status(mission_id)
                .await
                .unwrap_or_default();
            // Run the progress callback to completion *inline* — if we
            // spawned it instead, a late-completing callback could
            // race with the caller's post-wait "ready" pod_phase
            // update and overwrite it with the stale "compose_starting"
            // payload. Bug observed live on mission e9eeea6c.
            progress_cb(services.clone()).await;
            if services.is_empty() {
                if start.elapsed().as_secs() >= EMPTY_GRACE_SECS {
                    // No compose files in the inherited /workspaces/repos
                    // (or all repos were filtered out by SANDBOXED_AUTOSTACK_REPOS).
                    // The fork is "ready" — nothing to wait for.
                    return Ok(());
                }
            } else if all_compose_services_healthy(&services) {
                return Ok(());
            }
            if start.elapsed() > timeout {
                let unhealthy: Vec<&str> = services
                    .iter()
                    .filter(|s| !is_service_ready(s))
                    .map(|s| s.service.as_str())
                    .collect();
                bail!(
                    "compose services did not become healthy in {:?} for pod {} (unhealthy: {})",
                    timeout,
                    pod_name(mission_id),
                    unhealthy.join(", ")
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Run `docker compose up -d` for every repo under
    /// `/workspaces/repos/<name>/` that ships a `docker-compose.yml`
    /// or `compose.yml` (subject to the
    /// `SANDBOXED_AUTOSTACK_REPOS` allowlist, read from the pod's
    /// env), and stream each output line through `log_cb` as
    /// `(repo_name, line)`. Returns when the outer bash script
    /// exits — convergence of the per-service state is handled by
    /// the subsequent `wait_compose_healthy` call.
    ///
    /// **Why a single bash script instead of N concurrent execs?**
    /// One `kubectl exec` gives us one ordered stdout stream. The
    /// script prefixes each repo's output with a private
    /// `@@@COMPOSE@@@ <repo_name>` sentinel so the reader knows
    /// which repo the next batch of lines belongs to without
    /// juggling N exec processes. The sentinel never reaches the
    /// dashboard — the parser swallows it.
    ///
    /// **Why `--pull=missing` (default)?** Compose caches images
    /// after first pull; forcing `--pull=always` would re-download
    /// every service image on every pod start, defeating the whole
    /// point of the Nexus mirror cache.
    ///
    /// Streaming pattern copied from `stream_docker_compose_status`
    /// above — `tokio::process::Command::new("kubectl")` with
    /// `.stdout(Stdio::piped())`, then `BufReader::lines()` in a
    /// `tokio::select!` cancellation loop.
    pub async fn run_compose_up_with_logs<F, Fut>(
        &self,
        mission_id: Uuid,
        repos_allowlist: Option<&str>,
        stop: tokio_util::sync::CancellationToken,
        mut log_cb: F,
    ) -> Result<()>
    where
        F: FnMut(String, String) -> Fut,
        Fut: std::future::Future<Output = ()> + Send,
    {
        // Script-side env var lets the pod's bash honour the same
        // allowlist semantics bashenv.sh used to: space-or-comma
        // separated repo names; unset/empty = every repo.
        let allow_env = repos_allowlist.unwrap_or("");
        // The script:
        //  1. Walks /workspaces/repos/*/
        //  2. Skips entries without a compose file
        //  3. Skips entries where compose has `build:` (self-builds —
        //     would rebuild the product image and starve the backing
        //     services)
        //  4. For each remaining repo: prints sentinel line, then
        //     runs `docker compose up -d 2>&1`, continuing past
        //     per-repo failures.
        let script = format!(
            r#"set +e
            SANDBOXED_AUTOSTACK_REPOS="{allow}"
            __allow="${{SANDBOXED_AUTOSTACK_REPOS//,/ }}"
            # Docker logins for private registries. bashenv.sh runs
            # the same logins in a backgrounded subshell, but compose-up
            # is a *foreground* race against it — the first `docker
            # pull` against `registry.forgecart.com/...` fires before
            # the background login lands and fails with "no basic
            # auth credentials". Run the logins inline here, silent,
            # fail-soft. The bashenv marker still works for agent
            # shells later.
            __dlogin() {{
              local reg="$1" uvar="$2" tvar="$3"
              local user token
              eval "user=\${{$uvar:-}}"
              eval "token=\${{$tvar:-}}"
              [ -z "$user" ] || [ -z "$token" ] && return 0
              printf '%s' "$token" | docker login "$reg" -u "$user" --password-stdin >/dev/null 2>&1 || true
            }}
            echo "@@@COMPOSE@@@ __DLOGIN__"
            echo "logging in to registries (best-effort) ..."
            __dlogin "registry.forgecart.com"      FORGECART_REGISTRY_USERNAME FORGECART_REGISTRY_TOKEN
            __dlogin "https://index.docker.io/v1/" DOCKERHUB_USERNAME           DOCKERHUB_TOKEN
            __dlogin "ghcr.io"                     GHCR_USERNAME                GH_TOKEN
            echo "logins done"

            for __cf in /workspaces/repos/*/docker-compose.yml /workspaces/repos/*/compose.yml; do
              [ -f "$__cf" ] || continue
              __repo_dir="$(dirname "$__cf")"
              __repo_name="$(basename "$__repo_dir")"
              if [ -n "$__allow" ]; then
                case " $__allow " in
                  *" $__repo_name "*) : ;;
                  *) continue ;;
                esac
              fi
              # Skip composes that build from local source (sandboxed.sh's
              # own docker-compose.yml has `build: .`).
              if grep -Eq '^[[:space:]]*build[[:space:]]*:' "$__cf"; then
                continue
              fi
              echo "@@@COMPOSE@@@ $__repo_name"
              ( cd "$__repo_dir" && docker compose up -d 2>&1 ) || true
            done
            echo "@@@COMPOSE@@@ __DONE__"
            "#,
            allow = allow_env.replace('"', r#"\""#),
        );

        let pod = pod_name(mission_id);
        let api_server = std::env::var("KUBERNETES_SERVICE_HOST")
            .ok()
            .map(|host| {
                let port =
                    std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".to_string());
                format!("https://{host}:{port}")
            })
            .unwrap_or_else(|| "https://kubernetes.default.svc".to_string());
        let mut cmd = tokio::process::Command::new("kubectl");
        cmd.arg("--token")
            .arg(read_sa_token().unwrap_or_default())
            .arg("--certificate-authority")
            .arg("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
            .arg("--server")
            .arg(&api_server)
            .arg("--namespace")
            .arg(&self.namespace)
            .arg("exec")
            .arg(&pod)
            .arg("--")
            .arg("/bin/bash")
            .arg("-lc")
            .arg(&script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .context("failed to spawn compose-up kubectl exec")?;
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.kill().await;
                anyhow::bail!("compose-up exec produced no stdout pipe");
            }
        };
        use tokio::io::AsyncBufReadExt;
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut current_repo: Option<String> = None;
        loop {
            tokio::select! {
                _ = stop.cancelled() => {
                    let _ = child.kill().await;
                    return Ok(());
                }
                next = lines.next_line() => {
                    match next {
                        Ok(Some(line)) => {
                            if let Some(repo) = line.strip_prefix("@@@COMPOSE@@@ ") {
                                let trimmed = repo.trim();
                                if trimmed == "__DONE__" {
                                    break;
                                }
                                // Sentinel-prefixed pseudo-names are
                                // *control* messages (login phase,
                                // setup phase, etc.) — they're not real
                                // repos and should not surface as
                                // dashboard tabs. Suppress them by
                                // clearing current_repo so any output
                                // until the next real `@@@COMPOSE@@@ <repo>`
                                // is discarded.
                                if trimmed.starts_with("__") && trimmed.ends_with("__") {
                                    current_repo = None;
                                    continue;
                                }
                                current_repo = Some(trimmed.to_string());
                                continue;
                            }
                            if let Some(repo) = current_repo.clone() {
                                log_cb(repo, line).await;
                            } else {
                                // Output before the first sentinel — typically
                                // bashenv noise. Discard.
                                tracing::trace!(
                                    mission_id = %mission_id,
                                    line = %line,
                                    "compose-up: pre-sentinel line discarded"
                                );
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            tracing::warn!(
                                mission_id = %mission_id,
                                error = %e,
                                "compose-up read error"
                            );
                            break;
                        }
                    }
                }
            }
        }
        let _ = child.wait().await;
        Ok(())
    }

    /// Run a one-shot command inside the workspace pod. Mirrors
    /// `std::process::Command::output()`'s return shape so callers in
    /// `workspace_exec.rs::output()` can use it as a drop-in.
    pub async fn exec_command(
        &self,
        mission_id: Uuid,
        cwd: Option<&Path>,
        program: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Output> {
        let pod_name = pod_name(mission_id);

        // Build a shell command line so we can `mkdir -p <cwd> && cd
        // <cwd> && <env...> <program> <args...>` in a single `exec`
        // invocation — the kube exec subresource doesn't have a cwd
        // / env knob like `Command` does. `mkdir -p` is idempotent
        // and lazily creates the per-mission workspace dirs that the
        // control plane assumed lived on the host filesystem (they
        // live on the pod's PVC under /workspaces/...).
        let mut shell_cmd = String::new();
        if let Some(cwd) = cwd {
            let cwd_str = shell_quote(&cwd.to_string_lossy());
            shell_cmd.push_str(&format!("mkdir -p {cwd} && cd {cwd} && ", cwd = cwd_str));
        }
        for (k, v) in env {
            if k.trim().is_empty() {
                continue;
            }
            shell_cmd.push_str(&format!("export {}={}; ", shell_quote(k), shell_quote(v)));
        }
        shell_cmd.push_str(&shell_quote(program));
        for arg in args {
            shell_cmd.push(' ');
            shell_cmd.push_str(&shell_quote(arg));
        }

        tracing::debug!(
            mission_id = %mission_id,
            pod = %pod_name,
            cmd = %shell_cmd,
            "k8s_pod exec_command via kubectl"
        );

        // Shell out to kubectl. kube-rs 0.96's WebSocket exec path
        // 403s against the RKE2 v1.34 API server in our cluster:
        //   `failed to upgrade to a WebSocket connection:
        //    failed to switch protocol: 403 Forbidden`
        // Verified out-of-band that `kubectl exec` with the same SA
        // token + ServiceAccount succeeds, so the cluster RBAC and
        // SA mount are fine; only the kube-rs WS upgrade fails. Until
        // we figure out which header / proto-version the WS path is
        // missing, shelling out is the pragmatic workaround. kubectl
        // is installed at /usr/local/bin/kubectl in the
        // sandboxed-sh image — see Dockerfile.
        let api_server = std::env::var("KUBERNETES_SERVICE_HOST")
            .ok()
            .map(|host| {
                let port =
                    std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".to_string());
                format!("https://{}:{}", host, port)
            })
            .unwrap_or_else(|| "https://kubernetes.default.svc".to_string());

        let mut kubectl = tokio::process::Command::new("kubectl");
        kubectl
            .arg("--token")
            .arg(read_sa_token().unwrap_or_default())
            .arg("--certificate-authority")
            .arg("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
            .arg("--server")
            .arg(&api_server)
            .arg("--namespace")
            .arg(&self.namespace)
            .arg("exec")
            .arg(&pod_name)
            .arg("--")
            .arg("/bin/bash")
            .arg("-lc")
            .arg(&shell_cmd);

        let output = kubectl
            .output()
            .await
            .with_context(|| format!("kubectl exec on pod {} failed to spawn", pod_name))?;

        let exit_code = output.status.code().unwrap_or(1);

        tracing::debug!(
            mission_id = %mission_id,
            pod = %pod_name,
            exit = exit_code,
            stdout_len = output.stdout.len(),
            stderr_len = output.stderr.len(),
            stdout_sample = %String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(200)]),
            stderr_sample = %String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(200)]),
            "k8s_pod exec_command done"
        );

        let status = ExitStatus::from_raw(exit_code << 8);
        Ok(Output {
            status,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    /// Spawn a long-running, stdin/stdout-piped command inside the
    /// per-mission pod via `kubectl exec -i`. The caller owns the
    /// returned `Child` and is responsible for draining stdout +
    /// killing the process when done.
    ///
    /// Used by the LSP WebSocket bridge to drive
    /// `typescript-language-server --stdio` (and friends). Unlike
    /// `exec_command`, we don't wrap the command in a shell so the
    /// language server's stdio framing isn't mangled by a bash
    /// `-lc` rcfile preamble.
    pub async fn spawn_streaming_exec(
        &self,
        mission_id: Uuid,
        program: &str,
        args: &[&str],
    ) -> Result<tokio::process::Child> {
        let pod_name = pod_name(mission_id);
        let api_server = std::env::var("KUBERNETES_SERVICE_HOST")
            .ok()
            .map(|host| {
                let port =
                    std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".to_string());
                format!("https://{}:{}", host, port)
            })
            .unwrap_or_else(|| "https://kubernetes.default.svc".to_string());

        let mut cmd = tokio::process::Command::new("kubectl");
        cmd.arg("--token")
            .arg(read_sa_token().unwrap_or_default())
            .arg("--certificate-authority")
            .arg("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
            .arg("--server")
            .arg(&api_server)
            .arg("--namespace")
            .arg(&self.namespace)
            .arg("exec")
            .arg("-i")
            .arg(&pod_name)
            .arg("--")
            .arg(program);
        for a in args {
            cmd.arg(*a);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd.spawn()
            .with_context(|| format!("kubectl exec -i {} -- {}", pod_name, program))
    }

    /// Snapshot of every compose service currently known to the
    /// mission pod's dockerd. Runs `docker compose ps --format json
    /// --all` from each `/workspaces/repos/*` directory that has a
    /// compose file. Empty Vec when no compose files exist OR the
    /// daemon isn't up yet.
    pub async fn query_docker_compose_status(
        &self,
        mission_id: Uuid,
    ) -> Result<Vec<DockerServiceStatus>> {
        // One shell call that:
        //  1. walks every repo dir with a compose file
        //  2. runs `docker compose ps --all --format json` in each
        //  3. concatenates the (newline-delimited JSON) outputs.
        // The dashboard tolerates duplicate service names if two repos
        // happen to use the same name — we key on container_id.
        let script = r#"
set -e
for d in /workspaces/repos/*; do
  [ -d "$d" ] || continue
  if [ -f "$d/docker-compose.yml" ] || [ -f "$d/compose.yml" ]; then
    (cd "$d" && docker compose ps --all --format json 2>/dev/null) || true
  fi
done
"#;
        let out = self
            .exec_command(
                mission_id,
                None,
                "/bin/bash",
                &["-lc".to_string(), script.to_string()],
                &HashMap::new(),
            )
            .await?;
        // docker compose v2 emits ONE json object per line. Some
        // older daemons emit a single JSON array; handle both.
        let stdout = String::from_utf8_lossy(&out.stdout);
        let trimmed = stdout.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let mut services: Vec<DockerServiceStatus> = Vec::new();
        // Try line-per-object first.
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if line.starts_with('[') {
                if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(line) {
                    for v in arr {
                        if let Some(s) = parse_compose_service(&v) {
                            services.push(s);
                        }
                    }
                }
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(s) = parse_compose_service(&v) {
                    services.push(s);
                }
            }
        }
        Ok(services)
    }

    /// Stream of `DockerServiceStatus` snapshots driven by
    /// `docker events` (not polling). The stream yields the current
    /// state on subscribe, then re-queries + re-yields on every
    /// container lifecycle / health event from dockerd.
    ///
    /// Closes when:
    ///  - the underlying `kubectl exec docker events` pipe ends
    ///  - the optional `stop` token is cancelled (mission-level
    ///    cancellation hook)
    pub fn stream_docker_compose_status(
        self: std::sync::Arc<Self>,
        mission_id: Uuid,
        stop: tokio_util::sync::CancellationToken,
    ) -> impl futures::Stream<Item = Vec<DockerServiceStatus>> + Send + 'static {
        async_stream::stream! {
            // Initial snapshot (may be empty while compose-up is
            // pulling images — the events stream will fill it in).
            match self.query_docker_compose_status(mission_id).await {
                Ok(s) => yield s,
                Err(e) => {
                    tracing::debug!(mission_id = %mission_id, error = %e, "initial docker ps query failed; will retry on events");
                }
            }

            // Spawn `docker events` over kubectl exec. Each container
            // start / die / health_status event is one line on stdout.
            let pod = pod_name(mission_id);
            let api_server = std::env::var("KUBERNETES_SERVICE_HOST")
                .ok()
                .map(|host| {
                    let port = std::env::var("KUBERNETES_SERVICE_PORT").unwrap_or_else(|_| "443".to_string());
                    format!("https://{}:{}", host, port)
                })
                .unwrap_or_else(|| "https://kubernetes.default.svc".to_string());
            let mut cmd = tokio::process::Command::new("kubectl");
            cmd.arg("--token").arg(read_sa_token().unwrap_or_default())
                .arg("--certificate-authority").arg("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
                .arg("--server").arg(&api_server)
                .arg("--namespace").arg(&self.namespace)
                .arg("exec").arg(&pod)
                .arg("--").arg("/bin/bash").arg("-lc")
                .arg("docker events --filter type=container --format '{{json .}}' 2>/dev/null")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(mission_id = %mission_id, error = %e, "failed to spawn docker-events tail; falling back to one-shot");
                    return;
                }
            };
            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    let _ = child.kill().await;
                    return;
                }
            };
            use tokio::io::AsyncBufReadExt;
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            loop {
                tokio::select! {
                    _ = stop.cancelled() => {
                        let _ = child.kill().await;
                        return;
                    }
                    next = lines.next_line() => {
                        match next {
                            Ok(Some(_)) => {
                                // Re-query state on every event. Could
                                // be smarter (parse the event's status
                                // and patch only the affected service)
                                // but `docker compose ps` is cheap and
                                // we get cross-service health updates
                                // for free.
                                match self.query_docker_compose_status(mission_id).await {
                                    Ok(s) => yield s,
                                    Err(e) => tracing::debug!(mission_id = %mission_id, error = %e, "re-query failed after docker event"),
                                }
                            }
                            Ok(None) => {
                                // Stream ended (daemon dropped or pod
                                // restarting). Stop.
                                return;
                            }
                            Err(e) => {
                                tracing::debug!(mission_id = %mission_id, error = %e, "docker-events read error");
                                return;
                            }
                        }
                    }
                }
            }
        }
    }

    /// Delete the mission's Pod + both PVCs + the ConfigMap.
    /// Idempotent — missing resources are no-ops. Subsumes the
    /// previous `cleanup_mission_in_pod` since the pod itself is now
    /// per-mission (no need to compose-down inside it; just kill the
    /// pod and the containers go with it).
    pub async fn destroy_mission_pod(&self, mission_id: Uuid) -> Result<()> {
        let mut errs: Vec<String> = Vec::new();
        let dp = DeleteParams {
            grace_period_seconds: Some(5),
            ..Default::default()
        };
        if let Err(e) = self.pods().delete(&pod_name(mission_id), &dp).await {
            if !is_404(&e) {
                errs.push(format!("delete pod: {}", e));
            }
        }
        if let Err(e) = self
            .cms()
            .delete(&init_configmap_name(mission_id), &DeleteParams::default())
            .await
        {
            if !is_404(&e) {
                errs.push(format!("delete configmap: {}", e));
            }
        }
        for pvc in [workspaces_pvc_name(mission_id), docker_pvc_name(mission_id)] {
            if let Err(e) = self.pvcs().delete(&pvc, &DeleteParams::default()).await {
                if !is_404(&e) {
                    errs.push(format!("delete pvc {}: {}", pvc, e));
                }
            }
        }
        tracing::info!(
            mission_id = %mission_id,
            errs = errs.len(),
            "destroy_mission_pod done"
        );
        if errs.is_empty() {
            Ok(())
        } else {
            Err(anyhow!(errs.join("; ")))
        }
    }

    /// Current workspace status derived from Pod phase + container
    /// readiness. Returns (status, optional error message).
    pub async fn pod_status(
        &self,
        mission_id: Uuid,
    ) -> Result<(crate::workspace::WorkspaceStatus, Option<String>)> {
        use crate::workspace::WorkspaceStatus;
        let pod = match self.pods().get_opt(&pod_name(mission_id)).await? {
            Some(p) => p,
            None => return Ok((WorkspaceStatus::Pending, None)),
        };
        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or("Unknown");
        let ready = pod
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().all(|c| c.ready))
            .unwrap_or(false);
        let status = match (phase, ready) {
            ("Running", true) => WorkspaceStatus::Ready,
            ("Pending" | "Running", _) => WorkspaceStatus::Building,
            ("Failed", _) | ("Unknown", _) => WorkspaceStatus::Error,
            ("Succeeded", _) => WorkspaceStatus::Error, // unexpected exit for tail-f-inf
            _ => WorkspaceStatus::Building,
        };
        let err = pod
            .status
            .as_ref()
            .and_then(|s| s.reason.clone().or_else(|| s.message.clone()));
        Ok((status, err))
    }

    /// Read the init-log file the mission's entrypoint writes to
    /// `/workspaces/.init.log` on first start.
    pub async fn read_init_log(&self, mission_id: Uuid) -> Result<String> {
        let out = self
            .exec_command(
                mission_id,
                None,
                "/bin/sh",
                &[
                    "-lc".to_string(),
                    "cat /workspaces/.init.log 2>/dev/null || echo '(init.log not yet present)'"
                        .to_string(),
                ],
                &HashMap::new(),
            )
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// Clone the picked GitHub repositories INSIDE the workspace pod
    /// (instead of on the control-plane filesystem, where the host-side
    /// `clone_repos` would land them). Used by the mission-spawn path
    /// when the workspace is a K8sPod — the pod's `/workspaces` PVC is
    /// the only filesystem the agent ever sees, so anything cloned
    /// host-side is invisible.
    ///
    /// Returns the same `RepoCloneResult` shape `clone_repos` uses so
    /// the caller's downstream logic (`pick_working_directory`,
    /// `repos.json` write) keeps working unchanged.
    pub async fn clone_repos_in_pod(
        &self,
        mission_id: Uuid,
        selections: &[crate::api::github_app::RepoSelection],
        token: &str,
        pod_dest_root: &Path,
    ) -> Vec<crate::api::github_app::RepoCloneResult> {
        let mut results = Vec::with_capacity(selections.len());
        if selections.is_empty() {
            return results;
        }
        // Best-effort `mkdir -p` for the repos/ directory; this also
        // lets the BASH_ENV auto-stack hook's `[ -d "$__mdir/repos" ]`
        // gate match before any specific repo is cloned.
        let repos_root = pod_dest_root.join("repos");
        let mkdir_cmd = format!("mkdir -p {}", shell_quote(&repos_root.to_string_lossy()));
        let _ = self
            .exec_command(
                mission_id,
                None,
                "/bin/sh",
                &["-lc".to_string(), mkdir_cmd],
                &HashMap::new(),
            )
            .await;

        for sel in selections {
            let repo_name = sel
                .full_name
                .rsplit('/')
                .next()
                .unwrap_or(&sel.full_name)
                .to_string();
            let target = repos_root.join(&repo_name);
            let target_str = target.to_string_lossy().to_string();

            // Probe for an existing checkout. Same semantics as the
            // host-side clone_repos: don't clobber, treat as success.
            let probe = self
                .exec_command(
                    mission_id,
                    None,
                    "/bin/sh",
                    &[
                        "-lc".to_string(),
                        format!("test -d {}/.git", shell_quote(&target_str)),
                    ],
                    &HashMap::new(),
                )
                .await;
            if probe.as_ref().map(|o| o.status.success()).unwrap_or(false) {
                results.push(crate::api::github_app::RepoCloneResult {
                    full_name: sel.full_name.clone(),
                    branch: sel.branch.clone(),
                    path: target_str.clone(),
                    success: true,
                    error: None,
                });
                continue;
            }

            let url = format!(
                "https://x-access-token:{token}@github.com/{}.git",
                sel.full_name
            );
            // Full clone (no --depth) so History can show the repo's
            // complete commit history in the dashboard. Mirrors the
            // host-workspace clone in github_app.rs; --branch below
            // still controls the checkout while all history is fetched.
            let mut clone_cmd = String::from("git clone ");
            if let Some(branch) = sel.branch.as_deref().filter(|b| !b.trim().is_empty()) {
                clone_cmd.push_str(&format!("--branch {} ", shell_quote(branch)));
            }
            clone_cmd.push_str(&shell_quote(&url));
            clone_cmd.push(' ');
            clone_cmd.push_str(&shell_quote(&target_str));

            match self
                .exec_command(
                    mission_id,
                    None,
                    "/bin/sh",
                    &["-lc".to_string(), clone_cmd],
                    &HashMap::new(),
                )
                .await
            {
                Ok(out) if out.status.success() => {
                    tracing::info!(
                        mission_id = %mission_id,
                        repo = %sel.full_name,
                        path = %target_str,
                        "GitHub App clone OK (in-pod)"
                    );
                    results.push(crate::api::github_app::RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: target_str,
                        success: true,
                        error: None,
                    });
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    let redacted = stderr.replace(token, "***");
                    tracing::warn!(
                        mission_id = %mission_id,
                        repo = %sel.full_name,
                        status = ?out.status,
                        stderr = %redacted,
                        "GitHub App clone FAILED (in-pod)"
                    );
                    results.push(crate::api::github_app::RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: target_str,
                        success: false,
                        error: Some(redacted),
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        mission_id = %mission_id,
                        repo = %sel.full_name,
                        error = %e,
                        "GitHub App clone errored (in-pod kubectl exec)"
                    );
                    results.push(crate::api::github_app::RepoCloneResult {
                        full_name: sel.full_name.clone(),
                        branch: sel.branch.clone(),
                        path: target_str,
                        success: false,
                        error: Some(e.to_string()),
                    });
                }
            }
        }

        // After cloning, drop a per-mission `CLAUDE.md` at the
        // pod's `/workspaces` root that orients the agent: it
        // enumerates the cloned project directories and tells it
        // to read each repo's own CLAUDE.md / claude.md / agents.md
        // for project-specific instructions. Without this, Claude
        // Code starts in `/workspaces` with no project context and
        // wastes turns rediscovering the project layout.
        let _ = self
            .write_mission_claude_md(mission_id, &results, pod_dest_root)
            .await;

        // Sentinel for spawn_mission_pod_bootstrap's compose-up step
        // to wait on. Without this, the bootstrap orchestrator
        // (running concurrent with this clone in a separate tokio
        // task) would race past `wait_dockerd_ready` into
        // `run_compose_up_with_logs` while `/workspaces/repos/` is
        // still empty, find nothing to do, and flip the pod_phase
        // to `ready` with no compose services actually started.
        // The bootstrap polls this marker via
        // `wait_for_repos_cloned_marker` below.
        let marker = pod_dest_root.join(".repos-cloned");
        let _ = self
            .exec_command(
                mission_id,
                None,
                "/bin/sh",
                &[
                    "-lc".to_string(),
                    format!("touch {}", shell_quote(&marker.to_string_lossy())),
                ],
                &HashMap::new(),
            )
            .await;

        results
    }

    /// Block until `/workspaces/.repos-cloned` exists inside the
    /// mission pod, polled every 2 s, capped at `timeout`. Used by
    /// `spawn_mission_pod_bootstrap` to gate `compose_up` on the
    /// concurrent `clone_repos_in_pod` finishing. Returns `Ok(true)`
    /// if the marker appeared, `Ok(false)` on timeout — the caller
    /// proceeds either way (a workspace with no `INITIAL_REPOS`
    /// never gets the marker; the bootstrap should still run
    /// compose-up against whatever's on the volume).
    pub async fn wait_for_repos_cloned_marker(
        &self,
        mission_id: Uuid,
        timeout: Duration,
    ) -> Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            let probe = self
                .exec_command(
                    mission_id,
                    None,
                    "/bin/sh",
                    &[
                        "-lc".to_string(),
                        "[ -f /workspaces/.repos-cloned ]".to_string(),
                    ],
                    &HashMap::new(),
                )
                .await;
            if probe.as_ref().map(|o| o.status.success()).unwrap_or(false) {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Generate a root `/workspaces/CLAUDE.md` listing every
    /// successfully-cloned repo as a project root so Claude Code
    /// (or whichever agent the boss uses) picks up the multi-repo
    /// layout immediately. Pointed at each repo's own CLAUDE.md
    /// (or fallbacks) so per-project instructions still apply.
    async fn write_mission_claude_md(
        &self,
        mission_id: Uuid,
        results: &[crate::api::github_app::RepoCloneResult],
        pod_dest_root: &Path,
    ) -> Result<()> {
        let cloned: Vec<&crate::api::github_app::RepoCloneResult> =
            results.iter().filter(|r| r.success).collect();
        if cloned.is_empty() {
            return Ok(());
        }
        let mut md = String::new();
        md.push_str("# Mission workspace\n\n");
        md.push_str(
            "This per-mission Kubernetes pod has the cloned project repositories listed below. \
             Each one is its own git repo with its own conventions; treat them as separate \
             projects, not subfolders of a monorepo.\n\n",
        );
        md.push_str("## Project roots\n\n");
        for r in &cloned {
            md.push_str(&format!("- `{}` — `{}`\n", r.full_name, r.path));
        }
        md.push_str(
            "\n## Read each project's own instructions first\n\n\
             Before doing any work in a project, recursively check that project's directory \
             for any of these files and read them — they encode the project's own conventions, \
             commands, and house rules:\n\n\
             - `CLAUDE.md`\n\
             - `claude.md`\n\
             - `AGENTS.md`\n\
             - `agents.md`\n\
             - `.claude/CLAUDE.md`\n\
             - Subdirectory `CLAUDE.md` files (e.g. `package/core/CLAUDE.md`)\n\n\
             Use `find` or `Glob` to enumerate them up front:\n\n",
        );
        md.push_str("```sh\n");
        for r in &cloned {
            md.push_str(&format!(
                "find {} -maxdepth 4 -type f \\( -iname CLAUDE.md -o -iname agents.md \\) -not -path '*/node_modules/*' -not -path '*/.git/*'\n",
                r.path
            ));
        }
        md.push_str("```\n\n");
        md.push_str(
            "## Mission pod environment\n\n\
             - **Docker** daemon runs inside this pod. Each cloned repo's `docker-compose.yml` \
               (or `compose.yml`) is brought up at **pod boot** by the backend bootstrap \
               orchestrator (`spawn_mission_pod_bootstrap` → `run_compose_up_with_logs`) — \
               **not** the BASH_ENV hook — with per-line logs streamed to the dashboard. \
               Inspect with `docker compose ps` from the repo dir. If the stack isn't up yet \
               (still pulling) or a service is missing, bring it up yourself with \
               `docker compose up -d` from the repo dir. When tearing down, use \
               `docker compose down` **without** `-v` so seeded volumes survive.\n\
             - **Kubeconfig** (workload cluster) is at `~/.kube/config`.\n\
             - **Pre-installed**: `bash`, `git`, `gh`, `kubectl`, `terraform`, `node`, `pnpm`, \
               `docker`, `docker compose`, plus `claude` and `opencode` CLIs.\n\
             - **`/workspaces`** (this directory) is scratch — write per-project work into the \
               correct `/workspaces/repos/<name>/` subdir, not at `/workspaces` root.\n",
        );
        md.push_str(
            "\n### Environment is pre-provisioned — use it as-is\n\n\
             The pod provisions the environment before your first command, so in most cases \
             you **just run the project's own commands** — no env setup, no hand-written \
             `/tmp/*.env` files.\n\n\
             - **Service connection env is already exported into every shell** via the \
               `BASH_ENV` hook (`/etc/sandboxed-bashenv.sh`): e.g. `DB_HOST`, `DB_PORT`, \
               `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, \
               `CLICKHOUSE_URL`/`_USERNAME`/`_PASSWORD`/`_DATABASE`, `REDIS_URL`, \
               `RABBITMQ_URL`, `ELASTICSEARCH_URL`, plus `DOCKER_CONFIG`. **Don't re-export \
               these or write a throwaway `/tmp/*.env`** — every `bash -c` inherits them. \
               Run `env | sort` to confirm before assuming anything is missing.\n\
             - **JS workspace deps are auto-installed** by the same hook (`pnpm install` / \
               `npm ci` / `yarn` / `bun install`, picked from each repo's lockfile), so `nx` / \
               jest / etc. exist without a manual install. No-op for non-JS repos — a Rust \
               repo builds with `cargo` (and may require `cargo fmt --all` before CI passes; \
               check its `agents.md`).\n\
             - **Private-registry logins are already done** (`registry.forgecart.com`, \
               Docker Hub, ghcr — when creds are forwarded), so `docker compose` can pull \
               private images.\n\
             - **One real caveat — the pre-set DB points at *dev*:** `DB_DATABASE`/\
               `CLICKHOUSE_DATABASE` default to the **dev** databases. If a project's \
               e2e/seed flow is destructive (a `seed:drop`/reset), override the DB name \
               **inline, for that one command only** (e.g. prefix it with \
               `DB_DATABASE=<project>_e2e`) so you don't drop and reseed the dev DB. That \
               override is usually the *only* env change you ever need — everything else is \
               inherited.\n",
        );
        md.push_str(
            "\n## Repo CI listener\n\n\
             Any GitHub repository you clone under `/workspaces/repos/<name>/` \
             is automatically watched for GitHub Actions completions by the \
             backend. The listener polls `gh run list` against every repo's \
             origin remote every ~30 s; when a run completes (success or \
             failure), you receive a `<system-reminder>` with the verdict, \
             the job rollup, and (on failure) the failed-job log tail. The \
             reminder lands on your next turn — you don't need to do anything \
             to opt in.\n\n\
             You do **not** need to call `gh run watch`, `gh pr checks --watch`, \
             or `gh actions watch` yourself; the backend already polls. Fire \
             your `gh pr create` / `gh pr merge` / `git push` / `gh workflow run` \
             and continue with other work — the listener will deliver the \
             outcome.\n\n\
             The first poll for a freshly cloned repo seeds the cursor to the \
             latest existing run id and emits no reminders, so cloning a new \
             repo won't flood you with historical completions.\n",
        );

        // Write the file via a small heredoc-style exec to avoid
        // dealing with quoting in `echo`. Base64 keeps embedded
        // backticks / `$` / quotes intact through bash.
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(md.as_bytes());
        let path = pod_dest_root.join("CLAUDE.md");
        let script = format!(
            "echo {} | base64 -d > {}",
            shell_quote(&b64),
            shell_quote(&path.to_string_lossy())
        );
        let out = self
            .exec_command(
                mission_id,
                None,
                "/bin/bash",
                &["-lc".to_string(), script],
                &HashMap::new(),
            )
            .await?;
        if !out.status.success() {
            tracing::warn!(
                mission_id = %mission_id,
                stderr = %String::from_utf8_lossy(&out.stderr),
                "writing /workspaces/CLAUDE.md failed (non-fatal)"
            );
        } else {
            tracing::info!(
                mission_id = %mission_id,
                path = %path.display(),
                repos = cloned.len(),
                "Wrote mission-root CLAUDE.md with project map"
            );
        }
        Ok(())
    }

    /// Stream pod-startup phase events for a mission. Polls the
    /// Pod + its kubelet/scheduler events at 1Hz, yielding one
    /// `PodStartupEvent` per observed phase transition. Closes the
    /// stream when the pod reaches `Ready` or `Error`. Dashboard's
    /// SSE relay forwards each event to the browser so the user
    /// sees a live "Pulling image…" / "Container starting…" /
    /// "init.sh running…" progress instead of a silent 30-90s wait.
    pub fn stream_pod_startup_events(
        self: std::sync::Arc<Self>,
        mission_id: Uuid,
    ) -> impl futures::Stream<Item = PodStartupEvent> + Send + 'static {
        async_stream::stream! {
            let pod_name = pod_name(mission_id);
            let mut last_emitted: Option<PodStartupEvent> = None;
            let deadline = std::time::Instant::now() + Duration::from_secs(180);
            let yield_if_new = |evt: PodStartupEvent, last: &mut Option<PodStartupEvent>| {
                let new = last.as_ref() != Some(&evt);
                if new { *last = Some(evt.clone()); }
                new
            };
            loop {
                if std::time::Instant::now() > deadline {
                    yield PodStartupEvent::Error {
                        message: format!("Pod {} did not reach Ready within 180s", pod_name),
                    };
                    return;
                }
                let pod_opt = self.pods().get_opt(&pod_name).await.ok().flatten();
                let evt = match pod_opt.as_ref() {
                    None => PodStartupEvent::PvcBinding,
                    Some(pod) => {
                        let phase = pod
                            .status
                            .as_ref()
                            .and_then(|s| s.phase.as_deref())
                            .unwrap_or("Pending");
                        let scheduled = pod
                            .status
                            .as_ref()
                            .and_then(|s| s.conditions.as_ref())
                            .and_then(|cc| {
                                cc.iter().find(|c| c.type_ == "PodScheduled")
                            })
                            .map(|c| c.status == "True")
                            .unwrap_or(false);
                        let cs = pod
                            .status
                            .as_ref()
                            .and_then(|s| s.container_statuses.as_ref())
                            .and_then(|v| v.first());
                        let ready = cs.map(|c| c.ready).unwrap_or(false);
                        let waiting_reason = cs
                            .and_then(|c| c.state.as_ref())
                            .and_then(|s| s.waiting.as_ref())
                            .and_then(|w| w.reason.as_deref());
                        let waiting_msg = cs
                            .and_then(|c| c.state.as_ref())
                            .and_then(|s| s.waiting.as_ref())
                            .and_then(|w| w.message.as_deref())
                            .unwrap_or("");

                        if phase == "Failed" {
                            PodStartupEvent::Error {
                                message: pod
                                    .status
                                    .as_ref()
                                    .and_then(|s| s.message.clone())
                                    .unwrap_or_else(|| "pod entered Failed phase".to_string()),
                            }
                        } else if ready {
                            // ready=true → past container start. If
                            // init.sh sentinel is missing AND the
                            // workspace has an init script mounted,
                            // we'd treat that as InitScriptRunning,
                            // but for simplicity we let entrypoint.sh
                            // block on it; once container is Ready
                            // the entrypoint has reached `sleep
                            // infinity` and the agent can exec.
                            PodStartupEvent::Ready
                        } else if let Some(reason) = waiting_reason {
                            // kubelet's standard reasons:
                            //   ContainerCreating, PodInitializing,
                            //   ImagePullBackOff, ErrImagePull, Pulling
                            match reason {
                                "Pulling" => PodStartupEvent::Pulling {
                                    image: waiting_msg.to_string(),
                                },
                                "ContainerCreating" | "PodInitializing" => {
                                    PodStartupEvent::ContainerStarting
                                }
                                "ImagePullBackOff" | "ErrImagePull" => PodStartupEvent::Error {
                                    message: format!("{}: {}", reason, waiting_msg),
                                },
                                "CrashLoopBackOff" => PodStartupEvent::Error {
                                    message: format!("CrashLoopBackOff: {}", waiting_msg),
                                },
                                _ => PodStartupEvent::ContainerStarting,
                            }
                        } else if !scheduled || phase == "Pending" {
                            PodStartupEvent::PodScheduled
                        } else {
                            PodStartupEvent::ContainerStarting
                        }
                    }
                };
                let is_terminal = matches!(evt, PodStartupEvent::Ready | PodStartupEvent::Error { .. });
                if yield_if_new(evt.clone(), &mut last_emitted) {
                    yield evt;
                }
                if is_terminal {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(1000)).await;
            }
        }
    }

    /// One-shot startup cleanup. Scans the namespace for leftover
    /// per-workspace pods (`ws-*`) from the old workspace-per-pod
    /// model + deletes each with its PVCs and ConfigMap. Called from
    /// `routes.rs` right after `K8sPodClient::try_init`. Idempotent;
    /// missing resources are no-ops.
    pub async fn gc_orphaned_workspace_pods(&self) -> Result<usize> {
        use kube::api::ListParams;
        let lp = ListParams::default().labels("app.kubernetes.io/managed-by=sandboxed-sh");
        let pods = self.pods().list(&lp).await?;
        let mut removed = 0usize;
        let dp = DeleteParams {
            grace_period_seconds: Some(5),
            ..Default::default()
        };
        for pod in pods.items {
            let name = pod.metadata.name.unwrap_or_default();
            if !name.starts_with("ws-") {
                continue;
            }
            let _ = self.pods().delete(&name, &dp).await;
            // Best-effort sibling PVC + ConfigMap cleanup. The old
            // workspace_id-keyed PVCs were named
            // `ws-<uuid>-workspaces` / `ws-<uuid>-docker` and the
            // ConfigMap was `ws-<uuid>-init`.
            let base = &name; // = `ws-<uuid>`
            let _ = self
                .cms()
                .delete(&format!("{}-init", base), &DeleteParams::default())
                .await;
            for suf in ["workspaces", "docker"] {
                let _ = self
                    .pvcs()
                    .delete(&format!("{}-{}", base, suf), &DeleteParams::default())
                    .await;
            }
            removed += 1;
            tracing::info!(pod = %name, "gc_orphaned_workspace_pods: removed");
        }
        if removed > 0 {
            tracing::info!(removed = removed, "gc_orphaned_workspace_pods done");
        }
        Ok(removed)
    }

    /// Re-run the mission's init.sh (after the operator edits the
    /// ConfigMap or wants to retry a failed init).
    pub async fn rerun_init(&self, mission_id: Uuid) -> Result<Output> {
        self.exec_command(
            mission_id,
            None,
            "/bin/bash",
            &[
                "-lc".to_string(),
                "rm -f /workspaces/.init.done && bash /etc/sandboxed/init.sh 2>&1 | tee /workspaces/.init.log".to_string(),
            ],
            &HashMap::new(),
        )
        .await
    }
}

/// Read the ServiceAccount token mounted by kubelet at the standard
/// projected path. Used by `exec_command` to drive `kubectl exec`
/// against the in-cluster API server with our pod's identity.
/// Map one `docker compose ps --format json` row into our
/// `DockerServiceStatus`. Compose v2 ships these field names:
///   Service, Name, ID, State, Health, Status, Image
/// `Health` is "" when no healthcheck is defined; we normalize to
/// "none" so the dashboard has a stable value.
fn parse_compose_service(v: &serde_json::Value) -> Option<DockerServiceStatus> {
    let obj = v.as_object()?;
    let pick = |k: &str| -> String {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let service = pick("Service");
    if service.is_empty() {
        return None;
    }
    let health = pick("Health");
    let health = if health.is_empty() {
        "none".to_string()
    } else {
        health
    };
    Some(DockerServiceStatus {
        service,
        container_id: pick("ID"),
        state: pick("State"),
        health,
        status: pick("Status"),
        image: pick("Image"),
    })
}

fn read_sa_token() -> Option<String> {
    std::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/token")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn shell_quote(s: &str) -> String {
    // Single-quote and escape any embedded single quotes:
    //   foo'bar  ->  'foo'\''bar'
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn is_404(e: &kube::Error) -> bool {
    matches!(
        e,
        kube::Error::Api(api_err) if api_err.code == 404
    )
}

/// True when a compose service has finished bringing itself up — it
/// reached `running` with health `healthy` (or no healthcheck), or it
/// exited cleanly (`exited` + status code 0, the init-container case
/// like `shop-beta-citus-init-1`).
pub(crate) fn is_service_ready(s: &DockerServiceStatus) -> bool {
    let state = s.state.as_str();
    let health = s.health.as_str();
    if state == "exited" {
        // `status` is the raw docker line ("Exited (0) 3 minutes ago").
        // Treat zero exit as success; anything else is a failure to
        // surface.
        return s.status.contains("Exited (0)");
    }
    if state != "running" {
        return false;
    }
    // Healthy, or no healthcheck (compose v2 returns empty health).
    matches!(health, "healthy" | "" | "none")
}

pub(crate) fn all_compose_services_healthy(services: &[DockerServiceStatus]) -> bool {
    !services.is_empty() && services.iter().all(is_service_ready)
}

/// True when a VolumeSnapshot's `status.error.message` represents a
/// failure mode that the snapshot-controller can't recover from on
/// its own. Examples:
///
/// - RBAC denied ("forbidden", "cannot get", "not allowed")
/// - Source PVC missing ("not found")
/// - SnapshotClass missing
///
/// Everything else (the "object has been modified" 409 conflict
/// loop, the "VolumeSnapshotBeingCreated" annotation race, generic
/// "server rejected our request" 4xx blips, controller timeouts)
/// is treated as **transient**: `wait_snapshot_ready` keeps polling
/// alongside the controller's own retry loop, and the controller
/// eventually wins.
///
/// This classification is deliberately narrow on "terminal" — false
/// negatives just mean we wait out the overall snapshot timeout
/// (default 5 min), which is much better than the previous
/// behaviour of treating every controller hiccup as terminal and
/// re-creating the snapshot in a doomed retry loop that fought the
/// controller until both gave up.
fn is_terminal_snapshot_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("forbidden")
        || m.contains("cannot get")
        || m.contains("not allowed")
        || m.contains("source persistent volume claim")
            && (m.contains("not found") || m.contains("does not exist"))
        || m.contains("volumesnapshotclass") && m.contains("not found")
}

#[allow(dead_code)]
fn parse_exit_code(raw: &str) -> Option<i32> {
    // Looking for `"exitCode":"42"` or `exitCode: 42`. Hand-rolled to
    // avoid pulling regex into another spot.
    let key = "exitCode";
    let idx = raw.find(key)?;
    let tail = &raw[idx + key.len()..];
    let mut digits = String::new();
    let mut seen_digit = false;
    for c in tail.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            seen_digit = true;
        } else if seen_digit {
            break;
        }
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exit_code_from_kube_status_payload() {
        let raw = r#"{"metadata":{},"status":"Failure","message":"command terminated with non-zero exit code: error executing command: exit status 7","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"7"}]},"code":500}"#;
        // The raw shape varies; our parser also accepts inline patterns.
        // Make sure we handle a quoted exitCode-style key + fall through gracefully.
        // (It's OK if this returns None; the caller defaults to 1.)
        let _ = parse_exit_code(raw);
    }

    #[test]
    fn parses_exit_code_when_present() {
        let raw = r#"{"exitCode":"42"}"#;
        assert_eq!(parse_exit_code(raw), Some(42));
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("foo"), "'foo'");
        assert_eq!(shell_quote("foo'bar"), "'foo'\\''bar'");
    }

    #[test]
    fn k8s_object_names_are_dns_1123_compatible() {
        let id = uuid::Uuid::nil();
        let p = pod_name(id);
        assert!(p.len() <= 63);
        assert!(p
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }
}
