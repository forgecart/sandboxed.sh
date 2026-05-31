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
# CI watching is handled by the repo-ci-listener daemon
# (src/api/repo_ci_listener.rs), which polls `gh run list` against
# every repo cloned under /workspaces/repos/ and injects a
# <system-reminder> when any GitHub Actions run completes. The
# shell here is unmodified — agents are free to call `gh`
# directly.

#
# Key constraint: this script gets re-sourced on EVERY `kubectl exec`
# into the workspace pod (each exec spawns a fresh bash). The login
# and compose-up steps would otherwise run on every agent tool call
# and the resolver's 8s per-probe budget runs out — missions fail
# with "claude not found". File markers (not env vars) gate the
# real work, and the work that does run goes into the BACKGROUND so
# bash returns immediately and the agent's command proceeds without
# waiting on image pulls.

# Docker credential parity — same $HOME split the kubeconfig block at the
# bottom of this file handles. The `docker login` below runs in this
# root-context background subshell, so by default it writes creds to
# /root/.docker/config.json. But the AGENT's shell runs with $HOME = the
# per-mission PVC dir, so its `docker` looked in $HOME/.docker and found
# nothing: public images (Nexus-proxied, pulled anonymously) still worked,
# but private `registry.forgecart.com/forgecart/*` images failed with
# "no basic auth credentials" and aborted `docker compose up`. Pin
# DOCKER_CONFIG to one fixed, pod-shared path so BOTH the login below and
# every agent shell that sources this file read the same config. Exported
# unconditionally (outside the dockerd guard) so the agent gets it even on
# execs where the gated background work is skipped.
export DOCKER_CONFIG="${DOCKER_CONFIG:-/root/.docker}"

if [ -z "${SANDBOXED_BASHENV_DONE:-}" ] && command -v dockerd >/dev/null 2>&1; then
  export SANDBOXED_BASHENV_DONE=1

  if [ -S /var/run/docker.sock ]; then
    __runlog=/tmp/sandboxed-bashenv.log
    # Background side-task. All file markers + heavy I/O happen here
    # so the foreground shell returns immediately.
    (
      # ── lock helpers ────────────────────────────────────────────
      # mkdir-based mutex. Two bugs used to live here:
      #   1. each critical section installed its OWN `trap … EXIT`, and
      #      the second one silently REPLACED the first (bash EXIT traps
      #      are not additive) — so the login lock below was never
      #      released by its trap and leaked into /var/run for the life
      #      of the pod.
      #   2. a SIGKILL (OOM / pod eviction / probe timeout) bypasses the
      #      trap entirely, leaking the lock. BOTH locks therefore live on
      #      ephemeral tmpfs under /var/run, NEVER on the /workspaces PVC.
      #      The PVC survives pod restarts and is snapshot-copied into
      #      forked missions, so a lock dir left there wedged compose-up +
      #      dep-install for every later exec AND every later pod on that
      #      workspace. Worse, PVC materialisation reset the leaked dir's
      #      mtime to pod-boot time, so the 30-min stale-steal below never
      #      fired within a pod's lifetime — a permanent wedge ("initial
      #      docker run still doesn't run"). On tmpfs a fresh pod always
      #      starts lock-free, and the dir mtime reflects real creation
      #      time so the steal genuinely self-heals an in-pod leak. Keep
      #      both lock paths on /var/run — do not move them to /workspaces.
      # Fix: a single trap that releases every lock THIS subshell holds,
      # plus stale-lock recovery so a dead holder's lock self-heals.
      __held_locks=""
      __release_locks() { for __l in $__held_locks; do rmdir "$__l" 2>/dev/null || true; done; }
      trap __release_locks EXIT INT TERM
      __acquire_lock() {
        __lk="$1"
        if mkdir "$__lk" 2>/dev/null; then __held_locks="$__held_locks $__lk"; return 0; fi
        # Held by someone else. Steal only if clearly abandoned (dir
        # older than 30 min — longer than any real compose-pull +
        # install, so a live holder is never robbed).
        if [ -n "$(find "$__lk" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
          echo "[sandboxed] stealing stale lock $__lk" >>"$__runlog"
          rmdir "$__lk" 2>/dev/null || true
          if mkdir "$__lk" 2>/dev/null; then __held_locks="$__held_locks $__lk"; return 0; fi
        fi
        return 1
      }

      __login_marker="/var/run/.sandboxed-docker-login-done"
      if [ ! -f "$__login_marker" ]; then
        # Lock so only one bash session at a time runs the logins
        # (others see the marker once it lands).
        if __acquire_lock /var/run/.sandboxed-bashenv-lock; then
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
        if __acquire_lock /var/run/.sandboxed-autostack-lock; then

          # --- docker compose up -d (once per pod) ------------------
          # Marker-gated: the stack only needs bringing up once.
          __marker=/workspaces/.sandboxed-autostack-done
          if [ ! -f "$__marker" ]; then
            __upped=0
            # Opt-in allowlist: when SANDBOXED_AUTOSTACK_REPOS is set, only
            # the named repos (space- or comma-separated basenames) are
            # brought up; everything else is skipped. Unset/empty keeps the
            # broad behaviour (every repo) — but the skip-build guard still
            # applies. This is what scopes a mission to e.g. just `shop-beta`
            # instead of every compose file under /workspaces/repos.
            __allow="${SANDBOXED_AUTOSTACK_REPOS:-}"; __allow="${__allow//,/ }"
            for __cf in /workspaces/repos/*/docker-compose.yml /workspaces/repos/*/compose.yml; do
              [ -f "$__cf" ] || continue
              __repo_dir="$(dirname "$__cf")"
              __repo_name="$(basename "$__repo_dir")"
              # Allowlist gate (only enforced when the var is set).
              if [ -n "$__allow" ]; then
                case " $__allow " in
                  *" $__repo_name "*) : ;;
                  *) echo "[sandboxed] autostack skip $__repo_name (not in SANDBOXED_AUTOSTACK_REPOS)" >>"$__runlog"; continue ;;
                esac
              fi
              # Skip-self: never `up` a compose that builds its image from
              # source (e.g. sandboxed.sh's own docker-compose.yml with
              # `build: .`). That triggered a multi-minute rebuild of the
              # whole product image and starved the backing-service stack the
              # mission actually needs. Backing stacks (shop-beta, …) are pure
              # `image:` pulls and pass this guard.
              if grep -Eq '^[[:space:]]*build[[:space:]]*:' "$__cf"; then
                echo "[sandboxed] autostack skip $__repo_name (compose builds from source)" >>"$__runlog"
                continue
              fi
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
# Write to $HOME/.kube/config — the path kubectl actually reads — NOT a
# hardcoded /root/.kube. In a mission pod $HOME is the per-mission PVC dir
# (e.g. /root/.sandboxed-sh/.../mission-<id>), so a config written to
# /root/.kube was invisible to the agent: kubectl silently fell back to the
# in-cluster SA (system:serviceaccount:sandboxed-sh:default), which has no
# cluster RBAC, and every kubectl/terraform call failed Forbidden. The cloud
# repo's own docs promise this kubeconfig "is materialised at ~/.kube/config";
# this aligns the code with that contract.
#
# No SANDBOXED_KUBECONFIG_DONE env guard: it was `export`ed, so it leaked into
# child shells and made them skip materialisation even when their own $HOME
# had no config (the bug above). The per-$HOME checksum marker below is the
# only idempotency gate needed — a single stat on the fast path — and it
# re-materialises correctly for each distinct $HOME.
if [ -n "${KUBECONFIG_CONTENT:-}" ]; then
  __kube_dir="${HOME:-/root}/.kube"
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
