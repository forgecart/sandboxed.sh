# Compose at pod init (with log streaming)

## Why

Before: `docker compose up -d` for each `/workspaces/repos/*/`
compose project ran in a background subshell inside
`bashenv.sh`. Because BASH_ENV only fires on `bash -lc`,
compose-up didn't actually start until something execed into the
pod — and the first exec is the resolver's CLI lookup, which
only happens *after* the user sends their first message. The
result was a confusing UX: user opens a fresh mission, types,
sends, and *only then* the compose stack starts pulling images.

After: compose-up is owned by the backend's mission-pod
bootstrap orchestrator. It runs immediately after
`wait_dockerd_ready` returns, streams each output line back to
the dashboard as `AgentEvent::MissionComposeLog` events, and
returns when the bash script exits (per-service health
convergence is handled by the subsequent `wait_compose_healthy`
call as before). The user opens the mission, sees real
"Pulling postgres", "Container forgecart-redis-1 Started" lines
in the `ForkProgressOverlay`, and the composer unlocks when
phase=ready — without ever having typed anything.

## Pieces

| Where | What |
|-------|------|
| `docker/workspace-base/daemon.json` | Pinned at build time. `registry-mirrors: ["http://nexus.nexus.svc.cluster.local:8089"]` + `insecure-registries`. Routes Docker-Hub pulls through the cluster-internal Nexus group repo. |
| `docker/workspace-base/Dockerfile` | `COPY` the daemon.json into `/etc/docker/`. No entrypoint changes — `dockerd` reads daemon.json on start. |
| `docker/workspace-base/bashenv.sh` | The old autostack compose-up block is gone. Docker login + JS dep install pass remain. |
| `src/k8s_pod.rs::run_compose_up_with_logs` | The new owner. One `kubectl exec` runs a bash script that walks `/workspaces/repos/*/`, applies the `SANDBOXED_AUTOSTACK_REPOS` allowlist, skips composes with `build:` directives, and `docker compose up -d 2>&1` per repo. Per-line stdout streams through a `(repo, line) -> Fut` callback. |
| `src/api/control.rs::spawn_mission_pod_bootstrap` | Inserts a `run_compose_up_with_logs` call between `dockerd_starting` and `wait_compose_healthy` for fresh K8sPod missions. |
| `src/api/control.rs::AgentEvent::MissionComposeLog` | New SSE variant — `{ mission_id, repo, line }`. |
| `dashboard/src/app/control/control-client.tsx` | `composeLogsByMission` state + `mission_compose_log` SSE handler (200-line ring buffer per repo). |
| `dashboard/src/components/fork-progress-overlay.tsx` | `LogTail` renders the last 30 lines per repo beneath `compose_starting` row. Auto-scrolls on update. |

## Nexus mirror behaviour

`registry-mirrors` only mirrors **Docker Hub** transparently. So:

| Compose image ref | Where Docker pulls it from |
|-------------------|---------------------------|
| `postgres:15` | Nexus 8089 (Hub proxy) |
| `redis:7-alpine` | Nexus 8089 (Hub proxy) |
| `clickhouse/clickhouse-server:24` | Nexus 8089 (Hub proxy) |
| `ghcr.io/foo/bar:1.0` | ghcr.io direct (bypasses Nexus) |
| `quay.io/x/y:2.3` | quay.io direct |
| `registry.forgecart.com/foo:bar` | registry.forgecart.com direct |

To capture non-Hub upstreams transparently you'd need a
containerd-based runtime with per-registry `hosts.toml` mirror
config. That's an explicit non-goal here — the Docker-Hub mirror
is the 80/20.

## Verification

1. Build + push workspace-base image with the new daemon.json:
   `gh workflow run build-and-publish.yml`.
2. `kubectl --kubeconfig=…workload -n sandboxed-sh rollout restart deploy/sandboxed-sh`.
3. Create a fresh K8sPod mission with compose repos cloned.
4. Open the mission immediately. Within ~20 s of pod scheduling
   the `compose_starting` row should appear in the overlay with:
   - Per-service status rows from `pod_message.services`.
   - One log block per repo showing the last 30 lines of
     `docker compose up -d` output.
5. Composer is hard-blocked until phase=ready.
6. After ready, send a message. Verify the agent's `bash` shell
   does **not** re-trigger compose-up — the autostack block in
   bashenv.sh is gone.

## Failure modes

| Symptom | Cause | Mitigation |
|---------|-------|------------|
| `compose_starting` row appears but log tail stays empty | `kubectl exec` for the bash script failed; check backend warn log `compose-up exec failed during bootstrap` | Re-roll the deploy or inspect the pod with `kubectl describe`. |
| Log lines show "no such host: nexus.nexus.svc.cluster.local" | Pod can't resolve in-cluster DNS — usually means CoreDNS is down, not a daemon.json issue | Check `kubectl -n kube-system get pods` |
| Slow first-time pulls despite mirror | First-ever Nexus pull populates Hub cache from upstream | Subsequent pulls hit the cache; latency is one-time per image |
| Compose log tail mentions ghcr.io / quay.io directly | Image ref is non-Hub — bypasses mirror by design | Replace with Hub-shaped tag if possible, or accept the egress |
