# Mission Fork

`POST /api/control/missions/:id/fork` creates a brand-new mission
under a fresh pod, on the current `:latest` workspace image, while
preserving everything the source mission had built up:

- `/workspaces` — the full repo tree, dotfiles, node_modules, build
  caches.
- `/var/lib/docker` — the inner dockerd's image cache + container
  overlay layers, so docker-compose stacks come back instantly
  instead of re-pulling.
- Mission events — the entire conversation history, copied row-for-row
  into the new mission so the agent picks up exactly where the source
  left off.
- Workspace env_vars + init.sh — inherited because the fork stays in
  the same workspace.

The source mission keeps running. The fork links back via
`parent_mission_id` so the dashboard can show the lineage in a
future UI.

## When to use it

The headline use case: the source pod was created from an old
`workspace-base` build (e.g. `kubectl get pod m-... -o
jsonpath='{.spec.containers[0].imagePullPolicy}'` shows
`IfNotPresent` and the node has the stale digest cached) and you
want to land on the current image without losing your work. A plain
`kubectl delete pod` would re-pull but wipe `/var/lib/docker`.

Other situations:
- Branch a conversation (try a different strategy) without disturbing
  the source's work in progress.
- Snapshot the current state before doing something risky.

## Flow

```
POST /api/control/missions/<source>/fork
  body: { title?: string, after_sequence?: number }

backend
 ├─ 1. Validate source (must be a K8sPod workspace mission)
 ├─ 2. INSERT new mission row immediately:
 │       parent_mission_id = source.id
 │       workspace_id      = source.workspace_id  (env_vars inherited)
 │       title             = body.title ?? "Fork of <source title>"
 │       pod_phase         = "forking"
 ├─ 3. Respond 200 { mission_id, parent_mission_id }
 │
 └─ tokio::spawn:
     ├─ INSERT INTO mission_events SELECT ... FROM mission_events
     │     WHERE mission_id = <src>          ← *FIRST*, before any
     │     (REPLACE() rewrites embedded       disk path that might
     │      <src> uuid in content/metadata)   fail. See "Why events
     │                                        copy runs first" below.
     ├─ docker pause + sync inside source pod  (best-effort quiesce)
     ├─ VolumeSnapshot snap-<new_id>-workspaces ← m-<src>-workspaces
     ├─ VolumeSnapshot snap-<new_id>-docker     ← m-<src>-docker
     │     (with 3× retry on Harvester CSI transient API conflicts —
     │      the "VolumeSnapshotBeingCreated annotation" race)
     ├─ poll snapshots until status.readyToUse=true (5 min budget)
     ├─ docker unpause source dockerd
     ├─ create PVC m-<new_id>-workspaces with dataSource=snap-...
     ├─ create PVC m-<new_id>-docker     with dataSource=snap-...
     ├─ create Pod m-<new_id> with imagePullPolicy=Always
     ├─ wait_for_ready (5 min budget)
     └─ delete the two VolumeSnapshot CRs (new PVCs are now
        independent Longhorn volumes — snapshots no longer
        load-bearing)
```

### Why events copy runs first

The disk/docker clone path can fail in non-trivial ways — the
Harvester CSI's snapshot controller has a known race with its
`VolumeSnapshotBeingCreated` annotation that can wedge a snapshot
mid-flight, the pod can fail to schedule, etc. By copying events
before any of that, even a failed fork still carries the source's
conversation history. The operator navigates to the new mission,
sees the chat, and can retry the fork or delete the failed mission
with one click. Without this ordering, a failed fork is an empty
shell.

Events copy is a single `INSERT … SELECT` in SQLite, so the cost
up front (even on the happy path) is negligible.

`pod_phase` flips through `forking → pulling → container_starting →
ready` over the existing SSE stream, so the dashboard's workbench
overlay handles the loading state without any new transport.

## On failure

Any error mid-orchestration triggers rollback:

- `docker unpause` the source (always, even on success — defensive
  RAII guard).
- `destroy_mission_pod(new_id)` → deletes pod + both new PVCs.
- `delete_volume_snapshot` on both snapshots.
- New mission row's `status=failed` and `pod_phase=error` with a
  message.

Events are left in place — cheap to leave + useful for triage. The
source mission is never observably touched besides the brief
docker-pause window (~ seconds).

## Cost

Each fork costs the delta between snapshot time and live. Snapshots
on Longhorn v1 are copy-on-write, so a freshly-forked mission
consumes near-zero disk until either side diverges. A 20 Gi
`workspaces` PVC where the fork edits 100 MB costs ~100 MB on disk.

`imagePullPolicy: Always` on the fork pod means we pay a re-pull
(typically 30–60 s for the workspace-base image). That's the whole
point of forking — landing on the current digest.

## API surface

```bash
TOKEN=$(curl -sS -X POST https://code.forgecart.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$DASHBOARD_PASSWORD\"}" | jq -r .token)

# Bare fork
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  https://code.forgecart.com/api/control/missions/<source>/fork \
  -d '{}'
# → {"mission_id":"<new>","parent_mission_id":"<source>"}

# Custom title + fork from message N (backend supports this; UI is
# follow-up work).
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  https://code.forgecart.com/api/control/missions/<source>/fork \
  -d '{"title":"What if we used Redis instead","after_sequence":342}'
```

The dashboard surfaces this as a `Fork` button in the mission topbar
next to `Delete`. It calls the no-arg variant and navigates the user
to the new mission immediately.

## Cluster dependencies

The fork orchestrator assumes these exist in the workload cluster
(they do at time of writing):

- `StorageClass harvester` (default) — provisioner
  `driver.harvesterhci.io`.
- `VolumeSnapshotClass harvester-snapshot` (default) — same
  provisioner, `deletionPolicy: Delete`.
- Snapshot CRDs (`snapshot.storage.k8s.io/v1`) installed.

If `harvester-snapshot` ever gets renamed, the backend will surface
the failure as `Fork failed: create workspaces snapshot:
admissionwebhook ...`. Update the `SNAPSHOT_CLASS` constant in
`src/k8s_pod.rs` to match.

## Out of scope (follow-ups)

- **bg-watcher in the fork.** The pod-side `bg-watchd` daemon is
  shipped only in the dashboard backend image today, not in
  `workspace-base`. Forks therefore inherit the same broken
  bg-watcher behaviour the source has. Independent of fork; tracked
  separately (add bg-watchd to `docker/workspace-base/Dockerfile` +
  spawn it from `docker/workspace-base/entrypoint.sh`).
- **Fork-from-message-N UI.** Backend already takes
  `after_sequence`; the click-an-event-and-fork interaction in the
  dashboard is a follow-up.
- **Lineage visualisation.** `parent_mission_id` is set; a "forked
  from / forks of" tree view in the dashboard is a follow-up.
- **Auto-prune `fork_failed` rows.** Manual delete only for now.
- **Disk-headroom guard.** Today we'll attempt a fork even if
  Longhorn is near full. A pre-flight Longhorn API check is a
  follow-up if disk pressure becomes a real issue.

## Verification

End-to-end test against the live cluster (`code.forgecart.com`):

1. `cargo clippy --workspace --all-targets` clean.
2. `cd dashboard && bunx tsc --noEmit` clean.
3. Backend image rebuilds + deploys via the standard CI path.
4. Pick a mission with a known compose stack inside its pod (e.g.
   `m-d2425e2c-...`). Snapshot `docker ps -a` for the comparison.
5. From the dashboard, click the topbar's `Fork` button. Toast
   shows "Forking mission…", page navigates to the new mission.
6. Watch the new pod:
   ```bash
   kubectl --kubeconfig ~/.kube/config-workload -n sandboxed-sh \
     get pod m-<new_id> -w
   ```
   Confirm `imagePullPolicy=Always` and the image digest matches
   the registry's current `:latest`.
7. After it's Running:
   ```bash
   kubectl -n sandboxed-sh exec m-<new_id> -- ls /workspaces
   # ✓ same tree as source
   kubectl -n sandboxed-sh exec m-<new_id> -- docker ps -a
   # ✓ same containers (probably Exited until bashenv re-up's them;
   #   the .sandboxed-autostack-done marker on /workspaces makes the
   #   re-up idempotent — `rm /workspaces/.sandboxed-autostack-done`
   #   to force it now).
   ```
8. Dashboard at the new mission id shows the full conversation
   history; composer accepts a new turn that runs against the new
   pod.
9. `kubectl -n sandboxed-sh get volumesnapshot` → empty (snapshots
   reclaimed after PVCs provisioned).
10. Negative path: trigger a failure mid-fork by destroying the
    source pod (`kubectl delete pod m-<src>`). The fork's pod_phase
    flips to `error`, mission status to `failed`, the source's
    dockerd is unpaused, and no orphan snapshots / PVCs remain.

## Per-step progress UX

The dashboard's **`ForkProgressOverlay`**
(`dashboard/src/components/fork-progress-overlay.tsx`) replaces the
mission's chat pane with a granular checklist whenever
`mission.pod_phase` is anything in the fork taxonomy other than
`ready`. The composer is hard-disabled in this state — the
`shouldBlockComposer` helper exported from the overlay file gates
`canSubmitComposer` in `control-client.tsx`.

The phases walk strictly in order:

| `pod_phase` | UI row label | Typical duration |
|---|---|---|
| `events_copying` | Copy conversation history | < 1 s |
| `quiescing_source` | Pause source docker | < 5 s |
| `snapshotting` | Snapshot source disks (workspaces + docker) | 5–60 s |
| `pvc_provisioning` | Claim forked volumes from snapshots | 1–3 s |
| `pod_starting` | Start forked pod (image pull + PVC attach) | 30 s – 2 min |
| `dockerd_starting` | Start Docker daemon | ≤ 15 s |
| `compose_starting` | Start docker-compose services | 30 s – 3 min |
| `ready` | Ready — composer unlocked | — |

The orchestrator (`src/api/mission_fork.rs::run_fork`) stuffs a JSON
body into `pod_message` so the overlay can render per-item detail:

- During `snapshotting` / `pvc_provisioning`: the `items` array
  shows per-volume status (`pending → in_progress → done`).
- During `compose_starting`: the `services` array carries every
  compose container's `service`, `state`, `health`, and `status`
  — the overlay renders each as a sub-row with its own dot
  (spinner → green check on healthy; red triangle on a non-zero
  exit).

The overlay tolerates legacy (plain-string) `pod_message` values
by falling back to rendering the raw string — so non-fork
missions whose pod_phase is one of the older labels
(`pvc_binding`, `pod_scheduled`, `pulling`, …) still get a usable
`PodStartupBanner` rendered above the composer.

### Readiness probes

Two probes live in `src/k8s_pod.rs`:

- **`wait_dockerd_ready(mission_id, timeout)`** — execs
  `docker version` inside the pod every 2 s until the server
  version line is non-empty. Pod-`Running` is necessary but not
  sufficient: the workspace-base entrypoint spawns `dockerd` in
  the background, and there's a ~10 s tail before
  `/var/run/docker.sock` is bound. Without this probe, the
  fork's first `docker compose up -d` raced with dockerd's own
  init.

- **`wait_compose_healthy(mission_id, timeout, progress_cb)`** —
  polls `query_docker_compose_status` (same helper that drives
  the post-ready `DockerServicesPanel`) every 2 s. Returns when
  every service is `running + healthy` (or `running` with no
  healthcheck) or `exited(0)` (init containers like
  `citus-init`). On each tick, `progress_cb` fires so the
  orchestrator can stuff the latest service list into the
  mission's `pod_message`. A 30 s grace window covers the case
  where bashenv hasn't kicked its background `docker compose up -d`
  yet on the first tick.

Both probes are reused by `mission_runner` (the activation gate
at `mission_runner.rs:3194`) so non-fork K8sPod missions also
wait for dockerd readiness before the first claude-CLI resolver
call — the same race that produced the misleading
*"Claude Code CLI 'claude' not found and neither npm nor bun is
available"* error.

### Race fix

The original bug: a user sent their first message 7 s after
clicking Fork; `mission_runner` activated immediately, ran the
claude-CLI resolver via `kubectl exec` into the not-yet-Ready
pod, got `container not found ("workspace")`, fell into the
auto-install branch which then said "neither npm nor bun
available" — both checks failed for the same reason. The
`wait_dockerd_ready` addition + the dashboard composer-gate (the
user *can't send* a message until phase=ready) eliminate this
race end-to-end. The misleading error path is now dead code on
the happy path; on real failures the orchestrator surfaces a
coherent `error` row with the underlying cause in
`pod_message.error`.
