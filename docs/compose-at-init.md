# Compose at pod init (with log streaming)

## Setup checklist for a workspace

To make compose-at-init useful on a workspace, set two env vars
in the workspace's secret (e.g. `sandboxed-sh-env` for the
default workspace, or whatever the per-workspace env_vars
mechanism is in your deployment):

| Var | Example | Effect |
|-----|---------|--------|
| `INITIAL_REPOS` | `forgecart/shop-beta,forgecart/sandboxed.sh` | Every fresh mission created via `POST /api/control/missions` *without* an explicit `initial_repos` field gets these cloned into `/workspaces/repos/` before compose-up runs. Tokens accept `owner/repo` or `owner/repo#branch`. |
| `SANDBOXED_AUTOSTACK_REPOS` | `shop-beta` | Subset of repos under `/workspaces/repos/` whose `docker-compose.yml` should be brought up. Unset = every repo with a compose file. |

Both vars are read by the backend at *mission create* time.
Updating them only affects newly-created missions; existing
ones keep their seeded list.

## Image freshness

Mission pods set `imagePullPolicy: Always` (`src/k8s_pod.rs`
build_pod_spec). The reason: the workspace image
(`SANDBOXED_SH_K8S_WORKSPACE_IMAGE`) defaults to a mutable
`:latest` tag. `IfNotPresent` would let nodes pin a stale
digest forever — verified live when the
`/etc/docker/daemon.json` change never propagated. With
`Always`, kubelet does one manifest HEAD per pod create and
re-pulls only the layers that changed; the bulk of the layers
stay cached on the node.



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
| `docker/workspace-base/bashenv.sh` | The old autostack compose-up block is gone. Docker login + JS dep install pass remain. |
| `src/k8s_pod.rs::run_compose_up_with_logs` | The new owner. One `kubectl exec` runs a bash script that walks `/workspaces/repos/*/`, applies the `SANDBOXED_AUTOSTACK_REPOS` allowlist, skips composes with `build:` directives, and `docker compose up -d 2>&1` per repo. Per-line stdout streams through a `(repo, line) -> Fut` callback. |
| `src/api/control.rs::spawn_mission_pod_bootstrap` | Inserts a `run_compose_up_with_logs` call between `dockerd_starting` and `wait_compose_healthy` for fresh K8sPod missions. |
| `src/api/control.rs::AgentEvent::MissionComposeLog` | New SSE variant — `{ mission_id, repo, line }`. |
| `dashboard/src/app/control/control-client.tsx` | `composeLogsByMission` state + `mission_compose_log` SSE handler (200-line ring buffer per repo). |
| `dashboard/src/components/fork-progress-overlay.tsx` | `LogTail` renders the last 30 lines per repo beneath `compose_starting` row. Auto-scrolls on update. |

## Registry auth

The in-pod dockerd has no `daemon.json` and no Nexus
`registry-mirrors` — pulls go to the upstream registries directly
(Docker Hub, ghcr.io, quay.io, `registry.forgecart.com`). For
private registries (`registry.forgecart.com/forgecart/*`), the
backend's `run_compose_up_with_logs` script does a foreground
`docker login` (silent, fail-soft) for each registry whose
`*_USERNAME` + `*_TOKEN` env vars are set on the workspace before
running `docker compose up -d`. This avoids the race that bit us
when `bashenv.sh` ran the same logins in a backgrounded subshell.

Recognised env-var pairs:

| Registry | Username var | Token var |
|----------|--------------|-----------|
| `registry.forgecart.com` | `FORGECART_REGISTRY_USERNAME` | `FORGECART_REGISTRY_TOKEN` |
| `index.docker.io` | `DOCKERHUB_USERNAME` | `DOCKERHUB_TOKEN` |
| `ghcr.io` | `GHCR_USERNAME` | `GH_TOKEN` |

## Verification

1. CI builds + rolls a new workspace-base image with the
   `imagePullPolicy: Always` + bashenv autostack changes.
2. Create a fresh K8sPod mission against a workspace with
   `INITIAL_REPOS` set.
3. Open the mission immediately. Within ~20 s of pod scheduling
   the `compose_starting` row should appear in the overlay with:
   - Per-service status rows from `pod_message.services`.
   - One log block per repo showing the last 30 lines of
     `docker compose up -d` output, with a small tab strip if
     multiple repos brought compose stacks up.
4. Composer is hard-blocked until phase=ready.
5. After ready, send a message. Verify the agent's `bash` shell
   does **not** re-trigger compose-up — the autostack block in
   bashenv.sh is gone.

## Failure modes

| Symptom | Cause | Mitigation |
|---------|-------|------------|
| `compose_starting` row appears but log tail stays empty | `kubectl exec` for the bash script failed; check backend warn log `compose-up exec failed during bootstrap` | Re-roll the deploy or inspect the pod with `kubectl describe`. |
| Pull error `no basic auth credentials` for `registry.forgecart.com/...` | The matching `_USERNAME` / `_TOKEN` env vars aren't forwarded to the workspace pod | Add them to the workspace's env_vars (visible to the pod). |
