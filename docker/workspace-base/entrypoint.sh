#!/usr/bin/env bash
# Workspace pod entrypoint — runs at Pod start.
#
# Responsibilities:
#   1. Bring up dockerd in the background (k8s pods get RW /proc/sys,
#      so the bridge driver + iptables + ip_forward all work natively).
#   2. If a per-workspace init.sh is mounted at /etc/sandboxed/init.sh
#      (via a ConfigMap), run it once on the first boot and tee output
#      to /workspaces/.init.log. A sentinel file
#      /workspaces/.init.done blocks re-runs across pod restarts (PVC
#      survives the pod). `POST /workspaces/<id>/rerun-init` clears the
#      sentinel and re-execs this script.
#   3. Replace ourselves with `sleep infinity` so the pod stays alive
#      for `kube exec` (the data plane the control plane uses to run
#      commands inside the workspace).

set -u
set -o pipefail

WORKSPACES_DIR=${WORKSPACES_DIR:-/workspaces}
INIT_LOG=${INIT_LOG:-${WORKSPACES_DIR}/.init.log}
INIT_DONE=${INIT_DONE:-${WORKSPACES_DIR}/.init.done}
USER_INIT_SCRIPT=${USER_INIT_SCRIPT:-/etc/sandboxed/init.sh}

mkdir -p "$WORKSPACES_DIR"

start_dockerd() {
  if [ -S /var/run/docker.sock ]; then
    echo "[workspace-entrypoint] dockerd socket already present, skipping start" >&2
    return 0
  fi
  echo "[workspace-entrypoint] starting dockerd" >&2
  # /var/log/dockerd.log lives in the workspace's docker PVC bind
  # (mounted at /var/lib/docker by the control plane); /var/log/ is on
  # the pod's emptyDir. Either way the agent can `tail` it.
  nohup dockerd \
    --host=unix:///var/run/docker.sock \
    >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    [ -S /var/run/docker.sock ] && break
    sleep 1
  done
  if [ -S /var/run/docker.sock ]; then
    echo "[workspace-entrypoint] dockerd ready" >&2
  else
    echo "[workspace-entrypoint] WARNING: dockerd did not come up in 60s — see /var/log/dockerd.log" >&2
  fi
}

run_user_init() {
  if [ ! -f "$USER_INIT_SCRIPT" ]; then
    return 0
  fi
  if [ -f "$INIT_DONE" ]; then
    echo "[workspace-entrypoint] init.sh already ran ($(cat "$INIT_DONE")); skipping" >&2
    return 0
  fi
  echo "[workspace-entrypoint] running user init.sh (output -> $INIT_LOG)" >&2
  # Redirect output to log file AND stderr so dashboard's stream view
  # (which tails the file) sees it as it happens.
  if bash "$USER_INIT_SCRIPT" 2>&1 | tee -a "$INIT_LOG" >&2; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$INIT_DONE"
    echo "[workspace-entrypoint] init.sh OK" >&2
  else
    echo "[workspace-entrypoint] init.sh FAILED — see $INIT_LOG" >&2
    # Don't exit — the pod stays alive so we can debug via kube exec.
  fi
}

start_dockerd
run_user_init

echo "[workspace-entrypoint] sleeping; pod is ready for kube exec" >&2
exec sleep infinity
