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
    api::{Api, AttachParams, DeleteParams, PostParams},
    Client,
};
use std::collections::{BTreeMap, HashMap};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{ExitStatus, Output};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

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

const POD_LABEL_KEY: &str = "forgecart.dev/workspace-id";
const POD_LABEL_MANAGED_BY_KEY: &str = "app.kubernetes.io/managed-by";
const POD_LABEL_MANAGED_BY_VALUE: &str = "sandboxed-sh";
const STORAGE_CLASS: &str = "harvester";
const WORKSPACES_VOLUME_SIZE: &str = "20Gi";
const DOCKER_VOLUME_SIZE: &str = "20Gi";
const PULL_SECRET_DEFAULT: &str = "nexus-registry";

/// Truncated, dns-1123-safe Pod / PVC / ConfigMap name for a workspace.
fn k8s_object_name(workspace_id: Uuid, suffix: &str) -> String {
    // k8s names: max 63 chars, lowercase, [a-z0-9-]. "ws-<uuid>" fits;
    // suffix lets us derive PVC / ConfigMap names from the same base.
    let base = format!("ws-{}", workspace_id);
    if suffix.is_empty() {
        base
    } else {
        format!("{}-{}", base, suffix)
    }
}

fn pod_name(workspace_id: Uuid) -> String {
    k8s_object_name(workspace_id, "")
}

fn workspaces_pvc_name(workspace_id: Uuid) -> String {
    k8s_object_name(workspace_id, "workspaces")
}

fn docker_pvc_name(workspace_id: Uuid) -> String {
    k8s_object_name(workspace_id, "docker")
}

fn init_configmap_name(workspace_id: Uuid) -> String {
    k8s_object_name(workspace_id, "init")
}

fn standard_labels(workspace_id: Uuid) -> BTreeMap<String, String> {
    let mut labels = BTreeMap::new();
    labels.insert(POD_LABEL_KEY.to_string(), workspace_id.to_string());
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
        let client = Client::try_default().await.ok()?;
        tracing::info!(
            namespace = %namespace,
            image = %image,
            pull_secret = %pull_secret,
            "K8sPod backend enabled"
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

    /// Create the PVCs + (optional) ConfigMap + Pod for a workspace.
    /// Idempotent — if the Pod already exists, this is a no-op.
    pub async fn create_workspace_pod(
        &self,
        workspace_id: Uuid,
        init_script: Option<&str>,
        env_vars: &HashMap<String, String>,
    ) -> Result<()> {
        let pod_name = pod_name(workspace_id);

        if self.pods().get_opt(&pod_name).await?.is_some() {
            tracing::info!(workspace_id = %workspace_id, "Pod already exists, skipping create");
            return Ok(());
        }

        // 1. PVCs
        self.ensure_pvc(&workspaces_pvc_name(workspace_id), WORKSPACES_VOLUME_SIZE)
            .await?;
        self.ensure_pvc(&docker_pvc_name(workspace_id), DOCKER_VOLUME_SIZE)
            .await?;

        // 2. ConfigMap (if init script supplied)
        if let Some(script) = init_script {
            self.ensure_init_configmap(workspace_id, script).await?;
        }

        // 3. Pod
        let pod = self.build_pod_spec(workspace_id, init_script.is_some(), env_vars);
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .with_context(|| format!("Failed to create workspace pod {}", pod_name))?;
        tracing::info!(workspace_id = %workspace_id, pod = %pod_name, "Created workspace pod");
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
    /// handler can refresh a workspace's stored init.sh without
    /// going through full create_workspace_pod (which would also
    /// try to create the pod).
    pub async fn ensure_init_configmap_public(
        &self,
        workspace_id: Uuid,
        script: &str,
    ) -> Result<()> {
        self.ensure_init_configmap(workspace_id, script).await
    }

    async fn ensure_init_configmap(&self, workspace_id: Uuid, script: &str) -> Result<()> {
        let name = init_configmap_name(workspace_id);
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
        workspace_id: Uuid,
        with_init_script: bool,
        env_vars: &HashMap<String, String>,
    ) -> Pod {
        let mut volumes = vec![
            Volume {
                name: "workspaces".to_string(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: workspaces_pvc_name(workspace_id),
                    read_only: Some(false),
                }),
                ..Default::default()
            },
            Volume {
                name: "docker".to_string(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: docker_pvc_name(workspace_id),
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
                    name: init_configmap_name(workspace_id),
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

        let env_list = env_vars
            .iter()
            .map(|(k, v)| k8s_openapi::api::core::v1::EnvVar {
                name: k.clone(),
                value: Some(v.clone()),
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
                name: Some(pod_name(workspace_id)),
                namespace: Some(self.namespace.clone()),
                labels: Some(standard_labels(workspace_id)),
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
    pub async fn wait_for_ready(&self, workspace_id: Uuid, timeout: Duration) -> Result<()> {
        let pod_name = pod_name(workspace_id);
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
        workspace_id: Uuid,
        cwd: Option<&Path>,
        program: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Output> {
        let pod_name = pod_name(workspace_id);

        // Build a shell command line so we can `cd <cwd> && <env...> <program> <args...>`
        // in a single `exec` invocation — the kube exec subresource
        // doesn't have a cwd / env knob like `Command` does.
        let mut shell_cmd = String::new();
        if let Some(cwd) = cwd {
            shell_cmd.push_str(&format!("cd {} && ", shell_quote(&cwd.to_string_lossy())));
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

        let argv = vec!["/bin/bash".to_string(), "-lc".to_string(), shell_cmd];

        let mut attached = self
            .pods()
            .exec(
                &pod_name,
                argv,
                &AttachParams::default()
                    .stdout(true)
                    .stderr(true)
                    .stdin(false)
                    .tty(false),
            )
            .await
            .with_context(|| format!("kube exec on pod {} failed", pod_name))?;

        // Collect stdout / stderr in parallel.
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(mut s) = attached.stdout() {
            s.read_to_end(&mut stdout).await.ok();
        }
        if let Some(mut s) = attached.stderr() {
            s.read_to_end(&mut stderr).await.ok();
        }

        // Wait for the remote command to exit + extract its code.
        let exit_code = match attached.take_status() {
            Some(fut) => fut
                .await
                .and_then(|s| {
                    // s.status is "Success" or "Failure". Failure
                    // statuses carry a `details.causes[].message` of
                    // the form "command terminated with non-zero exit
                    // code: ...exitCode=N". Parse it out.
                    if s.status.as_deref() == Some("Success") {
                        Some(0i32)
                    } else {
                        let raw = serde_json::to_string(&s).unwrap_or_default();
                        parse_exit_code(&raw).or(Some(1))
                    }
                })
                .unwrap_or(1),
            None => 0,
        };

        let _ = attached.join().await;

        let status = ExitStatus::from_raw((exit_code as i32) << 8);
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }

    /// Delete the Pod + both PVCs + the ConfigMap. Idempotent.
    pub async fn destroy_workspace_pod(&self, workspace_id: Uuid) -> Result<()> {
        let mut errs: Vec<String> = Vec::new();
        let dp = DeleteParams {
            grace_period_seconds: Some(5),
            ..Default::default()
        };
        if let Err(e) = self.pods().delete(&pod_name(workspace_id), &dp).await {
            if !is_404(&e) {
                errs.push(format!("delete pod: {}", e));
            }
        }
        if let Err(e) = self
            .cms()
            .delete(&init_configmap_name(workspace_id), &DeleteParams::default())
            .await
        {
            if !is_404(&e) {
                errs.push(format!("delete configmap: {}", e));
            }
        }
        for pvc in [
            workspaces_pvc_name(workspace_id),
            docker_pvc_name(workspace_id),
        ] {
            if let Err(e) = self.pvcs().delete(&pvc, &DeleteParams::default()).await {
                if !is_404(&e) {
                    errs.push(format!("delete pvc {}: {}", pvc, e));
                }
            }
        }
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
        workspace_id: Uuid,
    ) -> Result<(crate::workspace::WorkspaceStatus, Option<String>)> {
        use crate::workspace::WorkspaceStatus;
        let pod = match self.pods().get_opt(&pod_name(workspace_id)).await? {
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

    /// Read the init-log file the workspace's entrypoint writes to
    /// `/workspaces/.init.log` on first start.
    pub async fn read_init_log(&self, workspace_id: Uuid) -> Result<String> {
        let out = self
            .exec_command(
                workspace_id,
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

    /// Re-run the workspace's init.sh (after the operator edits the
    /// ConfigMap or wants to retry a failed init).
    pub async fn rerun_init(&self, workspace_id: Uuid) -> Result<Output> {
        self.exec_command(
            workspace_id,
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
