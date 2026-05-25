# Sourced by every `bash -c` thanks to BASH_ENV=/etc/sandboxed-bashenv.sh,
# and by interactive shells via the line we append to /etc/bash.bashrc.
#
# Per-mission convenience: walk any cloned repo under
# /workspaces/mission-*/repos/ and `docker compose up -d` it on the
# first shell that runs in a new mission. Marker file blocks re-runs.
# The set -o pipefail trick makes the subshell's exit reflect docker's
# real status, not sed's (sed always returns 0, masking failures).

if [ -z "${SANDBOXED_BASHENV_DONE:-}" ] && command -v dockerd >/dev/null 2>&1; then
  export SANDBOXED_BASHENV_DONE=1

  # `docker login` each registry whose creds are forwarded from the
  # control plane into the workspace pod's env. Without this, the
  # auto-stack `compose up -d` for shop-beta (and similar) aborts on
  # `pull access denied` from registry.forgecart.com and cancels
  # every other in-flight pull. One-shot per shell session.
  if [ -S /var/run/docker.sock ] && [ -z "${DOCKER_AUTOLOGIN_DONE:-}" ]; then
    export DOCKER_AUTOLOGIN_DONE=1
    __dlogin() {
      __reg="$1"; __user_var="$2"; __token_var="$3"
      eval "__user=\${$__user_var:-}"
      eval "__token=\${$__token_var:-}"
      if [ -z "$__user" ] || [ -z "$__token" ]; then
        return 0
      fi
      if printf '%s' "$__token" | docker login "$__reg" -u "$__user" --password-stdin >/dev/null 2>&1; then
        echo "[sandboxed] docker login $__reg ($__user) ok" >&2
      else
        echo "[sandboxed] docker login $__reg FAILED" >&2
      fi
      unset __user __token
    }
    __dlogin "registry.forgecart.com"      FORGECART_REGISTRY_USERNAME  FORGECART_REGISTRY_TOKEN
    __dlogin "https://index.docker.io/v1/" DOCKERHUB_USERNAME           DOCKERHUB_TOKEN
    __dlogin "ghcr.io"                     GHCR_USERNAME                GH_TOKEN
    unset -f __dlogin
    unset __reg __user_var __token_var
  fi

  if [ -S /var/run/docker.sock ]; then
    for __mdir in /workspaces/mission-*; do
      [ -d "$__mdir/repos" ] || continue
      __marker="$__mdir/.sandboxed-autostack-done"
      [ -f "$__marker" ] && continue
      __upped=0
      for __cf in "$__mdir/repos"/*/docker-compose.yml "$__mdir/repos"/*/compose.yml; do
        [ -f "$__cf" ] || continue
        __repo_dir="$(dirname "$__cf")"
        echo "[sandboxed] compose up: $__repo_dir" >&2
        if (set -o pipefail; cd "$__repo_dir" && docker compose up -d 2>&1 | sed "s/^/  /" >&2); then
          __upped=$((__upped + 1))
        else
          echo "[sandboxed] compose up FAILED in $__repo_dir (continuing)" >&2
        fi
      done
      if [ "$__upped" -gt 0 ]; then
        touch "$__marker" 2>/dev/null || true
      fi
    done
  fi
  unset __mdir __marker __cf __repo_dir __upped
fi
