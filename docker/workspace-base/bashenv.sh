# Sourced by every `bash -c` thanks to BASH_ENV=/etc/sandboxed-bashenv.sh,
# and by interactive shells via the line we append to /etc/bash.bashrc.
#
# Per-mission convenience: kicks off `docker login` for each
# forwarded-creds registry, then walks any cloned repo under
# /workspaces/repos/ and `docker compose up -d` each compose
# file. Marker files block re-runs. /workspaces is the per-mission
# pod's mission root (the whole pod = one mission), so the scan
# is rooted directly at /workspaces — no /workspaces/mission-*
# wrapper anymore.
#
# Also: a `gh()` shell function that intercepts agent-side CI watch
# commands so the backend's pr-ci-watcher
# (src/api/pr_ci_watcher.rs) has the only watch in flight. See the
# function definition at the bottom of this file for the rationale.

# ── CI-watch interception ────────────────────────────────────────────
# The sandboxed.sh backend already watches CI runs you've kicked off
# via `gh pr create`, `gh pr merge`, `gh run rerun`, `gh workflow
# run`, and `git push`, and will inject a <system-reminder> into your
# next turn with the verdict + checks + (on failure) log tail. You
# don't need to block on `gh run watch` / `gh pr checks --watch` /
# `gh actions watch` — and we don't let you, because doing so wastes
# minutes of context for no signal you don't already get.
#
# This function intercepts those subcommands and exits with a hint.
# Anything else is passed through to the real `gh`. Human operators
# who really need to watch interactively can bypass with
# `command gh ...`.
gh() {
  local s1="${1:-}" s2="${2:-}"
  local blocked=0
  if [ "$s1" = "run" ] && [ "$s2" = "watch" ]; then
    blocked=1
  elif [ "$s1" = "actions" ] && [ "$s2" = "watch" ]; then
    blocked=1
  elif [ "$s1" = "pr" ] && [ "$s2" = "checks" ] && \
       echo " $* " | grep -q ' --watch '; then
    blocked=1
  fi
  if [ "$blocked" -eq 0 ]; then
    command gh "$@"
    return $?
  fi
  cat >&2 <<'EOF'
[ci-watcher] This subcommand is intercepted. The sandboxed.sh
backend already watches CI runs you've kicked off via `gh pr
create`, `gh pr merge`, `gh run rerun`, `gh workflow run`, and
`git push`, and will inject a <system-reminder> with the result.
Don't block your turn here — continue with other work.
EOF
  return 2
}
export -f gh
#
# Key constraint: this script gets re-sourced on EVERY `kubectl exec`
# into the workspace pod (each exec spawns a fresh bash). The login
# and compose-up steps would otherwise run on every agent tool call
# and the resolver's 8s per-probe budget runs out — missions fail
# with "claude not found". File markers (not env vars) gate the
# real work, and the work that does run goes into the BACKGROUND so
# bash returns immediately and the agent's command proceeds without
# waiting on image pulls.

if [ -z "${SANDBOXED_BASHENV_DONE:-}" ] && command -v dockerd >/dev/null 2>&1; then
  export SANDBOXED_BASHENV_DONE=1

  if [ -S /var/run/docker.sock ]; then
    __runlog=/tmp/sandboxed-bashenv.log
    # Background side-task. All file markers + heavy I/O happen here
    # so the foreground shell returns immediately.
    (
      __login_marker="/var/run/.sandboxed-docker-login-done"
      if [ ! -f "$__login_marker" ]; then
        # Lock so only one bash session at a time runs the logins
        # (others see the marker once it lands).
        if mkdir /var/run/.sandboxed-bashenv-lock 2>/dev/null; then
          trap 'rmdir /var/run/.sandboxed-bashenv-lock 2>/dev/null || true' EXIT
          __dlogin() {
            __reg="$1"; __user_var="$2"; __token_var="$3"
            eval "__user=\${$__user_var:-}"
            eval "__token=\${$__token_var:-}"
            if [ -z "$__user" ] || [ -z "$__token" ]; then
              return 0
            fi
            if printf '%s' "$__token" | docker login "$__reg" -u "$__user" --password-stdin >>"$__runlog" 2>&1; then
              echo "[sandboxed] docker login $__reg ($__user) ok" >>"$__runlog"
            else
              echo "[sandboxed] docker login $__reg FAILED" >>"$__runlog"
            fi
            unset __user __token
          }
          __dlogin "registry.forgecart.com"      FORGECART_REGISTRY_USERNAME  FORGECART_REGISTRY_TOKEN
          __dlogin "https://index.docker.io/v1/" DOCKERHUB_USERNAME           DOCKERHUB_TOKEN
          __dlogin "ghcr.io"                     GHCR_USERNAME                GH_TOKEN
          : > "$__login_marker"
        fi
      fi

      if [ -d /workspaces/repos ]; then
        # One lock guards both the compose-up and the dependency
        # install passes so two parallel bashes don't race on the
        # same repo set. Acquired up-front (not behind the
        # compose-done marker) so the install pass still runs on
        # later execs after the stack is already up — e.g. when a
        # repo is cloned, or its lockfile changes, after the first
        # compose-up has already been marked done.
        if mkdir /workspaces/.sandboxed-autostack-lock 2>/dev/null; then
          trap 'rmdir /workspaces/.sandboxed-autostack-lock 2>/dev/null || true' EXIT

          # --- docker compose up -d (once per pod) ------------------
          # Marker-gated: the stack only needs bringing up once.
          __marker=/workspaces/.sandboxed-autostack-done
          if [ ! -f "$__marker" ]; then
            __upped=0
            for __cf in /workspaces/repos/*/docker-compose.yml /workspaces/repos/*/compose.yml; do
              [ -f "$__cf" ] || continue
              __repo_dir="$(dirname "$__cf")"
              echo "[sandboxed] compose up: $__repo_dir" >>"$__runlog"
              if (set -o pipefail; cd "$__repo_dir" && docker compose up -d >>"$__runlog" 2>&1); then
                __upped=$((__upped + 1))
              else
                echo "[sandboxed] compose up FAILED in $__repo_dir (continuing)" >>"$__runlog"
              fi
            done
            if [ "$__upped" -gt 0 ]; then
              touch "$__marker" 2>/dev/null || true
            fi
          fi

          # --- JS workspace dependency install ----------------------
          # `node_modules` isn't baked into the image and isn't part
          # of the clone, so `nx` / jest / etc. are missing until the
          # workspace deps are installed (the "nx: not found" class of
          # failure). For each cloned repo, pick the installer from
          # the lockfile it ships and run it. Gated on a sentinel
          # inside node_modules whose mtime is compared against the
          # lockfile (`-nt`): the install runs when node_modules is
          # absent or the lockfile is newer than the last successful
          # install (fresh clone, branch switch, dep bump,
          # `dev:env:pull`), and is a cheap stat-only skip otherwise.
          for __rd in /workspaces/repos/*/; do
            __rd="${__rd%/}"
            [ -d "$__rd" ] || continue
            __lock=""; __pm=""; __install=""
            if   [ -f "$__rd/pnpm-lock.yaml" ]    && command -v pnpm >/dev/null 2>&1; then
              __lock="$__rd/pnpm-lock.yaml";    __pm=pnpm; __install="pnpm install --frozen-lockfile"
            elif [ -f "$__rd/package-lock.json" ] && command -v npm  >/dev/null 2>&1; then
              __lock="$__rd/package-lock.json"; __pm=npm;  __install="npm ci"
            elif [ -f "$__rd/yarn.lock" ]         && command -v yarn >/dev/null 2>&1; then
              __lock="$__rd/yarn.lock";         __pm=yarn; __install="yarn install --frozen-lockfile"
            elif [ -f "$__rd/bun.lockb" ]         && command -v bun  >/dev/null 2>&1; then
              __lock="$__rd/bun.lockb";         __pm=bun;  __install="bun install --frozen-lockfile"
            else
              continue
            fi
            __sentinel="$__rd/node_modules/.sandboxed-install-done"
            [ "$__lock" -nt "$__sentinel" ] || continue
            echo "[sandboxed] $__pm install: $__rd" >>"$__runlog"
            if (cd "$__rd" && eval "$__install" >>"$__runlog" 2>&1); then
              touch "$__sentinel" 2>/dev/null || true
              echo "[sandboxed] $__pm install ok: $__rd" >>"$__runlog"
            else
              echo "[sandboxed] $__pm install FAILED: $__rd (continuing)" >>"$__runlog"
            fi
          done
        fi
      fi
    ) >/dev/null 2>&1 </dev/null &
    disown 2>/dev/null || true
    unset __runlog
  fi
fi

# Materialise kubeconfig from the forwarded `KUBECONFIG_CONTENT`
# env var so the agent can run kubectl / terraform against the
# user's cluster. The control plane forwards this env from its
# own deployment secret (see FORWARDED_FROM_CONTROL_PLANE in
# src/k8s_pod.rs); workspace-supplied env_vars override.
#
# `KUBECONFIG_CONTENT` is base64-encoded YAML — keeps multi-line
# config out of env-var quoting hell. Idempotent: a checksum-
# keyed marker blocks re-decodes on every bash exec, which would
# otherwise hammer the disk on every agent tool call. The
# marker is keyed on the SHA-256 of the env value so rotating
# the kubeconfig at the control plane forces a re-decode.
if [ -n "${KUBECONFIG_CONTENT:-}" ] && [ -z "${SANDBOXED_KUBECONFIG_DONE:-}" ]; then
  export SANDBOXED_KUBECONFIG_DONE=1
  __kube_dir=/root/.kube
  __kube_cfg="$__kube_dir/config"
  __cksum=$(printf '%s' "$KUBECONFIG_CONTENT" | sha256sum | awk '{print $1}')
  __marker="$__kube_dir/.sandboxed-kubeconfig-$__cksum"
  if [ ! -f "$__marker" ]; then
    mkdir -p "$__kube_dir"
    if printf '%s' "$KUBECONFIG_CONTENT" | base64 -d > "$__kube_cfg.tmp" 2>/dev/null; then
      mv -f "$__kube_cfg.tmp" "$__kube_cfg"
      chmod 600 "$__kube_cfg" 2>/dev/null || true
      rm -f "$__kube_dir"/.sandboxed-kubeconfig-* 2>/dev/null || true
      touch "$__marker" 2>/dev/null || true
    else
      rm -f "$__kube_cfg.tmp" 2>/dev/null || true
      if [ ! -f /tmp/.sandboxed-kubeconfig-warn ]; then
        echo "[sandboxed] KUBECONFIG_CONTENT failed to base64-decode; kubectl/terraform won't be wired" >&2
        touch /tmp/.sandboxed-kubeconfig-warn 2>/dev/null || true
      fi
    fi
  fi
  unset __kube_dir __kube_cfg __cksum __marker
fi
