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
