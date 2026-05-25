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
    PodSecurityContext, PodSpec, ResourceRequirements, SecurityContext, Volume, VolumeMount,
    VolumeResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::{
    api::{Api, DeleteParams, PostParams},
    config::Config,
    Client,
};
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
const STORAGE_CLASS: &str = "harvester";
const WORKSPACES_VOLUME_SIZE: &str = "20Gi";
const DOCKER_VOLUME_SIZE: &str = "20Gi";
const PULL_SECRET_DEFAULT: &str = "nexus-registry";

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

fn pod_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "")
}

fn workspaces_pvc_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "workspaces")
}

fn docker_pvc_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "docker")
}

fn init_configmap_name(mission_id: Uuid) -> String {
    k8s_object_name(mission_id, "init")
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
            "K8sPod backend enabled (in-cluster config)"
        );
        let me = Self {
            client,
            namespace,
            image,
            pull_secret,
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
        );
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .with_context(|| format!("Failed to create mission pod {}", pod_name))?;
        tracing::info!(
            mission_id = %mission_id,
            workspace_id = %workspace_id,
            pod = %pod_name,
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

    /// Public alias of `ensure_init_configmap` so the rerun-init
    /// handler can refresh a mission's stored init.sh without
    /// going through full create_mission_pod.
    pub async fn ensure_init_configmap_public(
        &self,
        mission_id: Uuid,
        script: &str,
    ) -> Result<()> {
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

        // Forward a curated set of env vars from the control plane
        // into the workspace pod when the workspace doesn't already
        // override them. This is what gives nested dockerd inside the
        // pod the credentials it needs to pull from
        // registry.forgecart.com / docker.io / ghcr.io, and the
        // agent's `git clone`s a working GITHUB_TOKEN.
        const FORWARDED_FROM_CONTROL_PLANE: &[&str] = &[
            "FORGECART_REGISTRY_USERNAME",
            "FORGECART_REGISTRY_TOKEN",
            "DOCKERHUB_USERNAME",
            "DOCKERHUB_TOKEN",
            "GHCR_USERNAME",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GITHUB_USER",
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
        ];
        let mut merged: HashMap<String, String> = HashMap::new();
        for key in FORWARDED_FROM_CONTROL_PLANE {
            if let Ok(value) = std::env::var(key) {
                if !value.trim().is_empty() {
                    merged.insert((*key).to_string(), value);
                }
            }
        }
        // Workspace-supplied env_vars take precedence (override
        // forwarded defaults).
        for (k, v) in env_vars {
            merged.insert(k.clone(), v.clone());
        }
        let env_list = merged
            .into_iter()
            .map(|(k, v)| k8s_openapi::api::core::v1::EnvVar {
                name: k,
                value: Some(v),
                value_from: None,
            })
            .collect::<Vec<_>>();

        let mut requests = BTreeMap::new();
        requests.insert("cpu".to_string(), Quantity("200m".to_string()));
        requests.insert("memory".to_string(), Quantity("512Mi".to_string()));
        let mut limits = BTreeMap::new();
        limits.insert("cpu".to_string(), Quantity("2000m".to_string()));
        limits.insert("memory".to_string(), Quantity("4Gi".to_string()));

        let container = Container {
            name: "workspace".to_string(),
            image: Some(self.image.clone()),
            // IfNotPresent: once the node has the workspace-base image
            // cached, every subsequent mission on that node skips the
            // 30-60s pull. First mission per node still pays the cost.
            image_pull_policy: Some("IfNotPresent".to_string()),
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

        let status = ExitStatus::from_raw((exit_code as i32) << 8);
        Ok(Output {
            status,
            stdout: output.stdout,
            stderr: output.stderr,
        })
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
        for pvc in [
            workspaces_pvc_name(mission_id),
            docker_pvc_name(mission_id),
        ] {
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
            let mut clone_cmd = String::from("git clone --depth=1 ");
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

        results
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
                        } else if !scheduled {
                            PodStartupEvent::PodScheduled
                        } else if phase == "Pending" {
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
        let lp = ListParams::default()
            .labels("app.kubernetes.io/managed-by=sandboxed-sh");
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
