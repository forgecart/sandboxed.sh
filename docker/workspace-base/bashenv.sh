# Sourced by every `bash -c` thanks to BASH_ENV=/etc/sandboxed-bashenv.sh,
# and by interactive shells via the line we append to /etc/bash.bashrc.
#
# Per-mission convenience: kicks off `docker login` for each
# forwarded-creds registry, then walks any cloned repo under
# /workspaces/mission-*/repos/ and `docker compose up -d` each
# compose file. Marker files block re-runs.
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

      for __mdir in /workspaces/mission-*; do
        [ -d "$__mdir/repos" ] || continue
        __marker="$__mdir/.sandboxed-autostack-done"
        [ -f "$__marker" ] && continue
        # Per-mission lock so two parallel bashes don't both compose-up
        # the same repo set.
        if mkdir "$__mdir/.sandboxed-autostack-lock" 2>/dev/null; then
          trap 'rmdir "$__mdir/.sandboxed-autostack-lock" 2>/dev/null || true' EXIT
          __upped=0
          for __cf in "$__mdir/repos"/*/docker-compose.yml "$__mdir/repos"/*/compose.yml; do
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
      done
    ) >/dev/null 2>&1 </dev/null &
    disown 2>/dev/null || true
    unset __runlog
  fi
fi
