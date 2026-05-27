#!/bin/bash
set -e

# =============================================================================
# Open Agent — Docker Entrypoint (DEV mode)
# Same as entrypoint.sh but runs Next.js via `next dev` from /opt/dashboard-src
# instead of `node server.js` from the standalone bundle. Gives full HMR +
# error overlay + original file paths in browser DevTools.
# Activate via the :dev image tag; ENV DASHBOARD_MODE=dev is set in the image.
# =============================================================================

cleanup() {
    echo "[entrypoint-dev] shutting down..."
    kill "$BACKEND_PID" "$DASHBOARD_PID" 2>/dev/null || true
    [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
    wait
}
trap cleanup SIGTERM SIGINT

# -- Git / SSH setup ----------------------------------------------------------
if [ -d /root/.ssh ]; then
    KNOWN_HOSTS="/root/.ssh/known_hosts"
    if ! touch "$KNOWN_HOSTS" 2>/dev/null; then
        KNOWN_HOSTS="/root/.ssh_known_hosts"
        cp /root/.ssh/known_hosts "$KNOWN_HOSTS" 2>/dev/null || true
        export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=$KNOWN_HOSTS"
    fi
    if ! grep -q "github.com" "$KNOWN_HOSTS" 2>/dev/null; then
        echo "[entrypoint-dev] adding GitHub/GitLab SSH host keys"
        ssh-keyscan -t ed25519,rsa github.com gitlab.com >> "$KNOWN_HOSTS" 2>/dev/null || true
    fi
fi

# -- Optional: Desktop (Xvfb + i3) -------------------------------------------
if [ "${DESKTOP_ENABLED:-false}" = "true" ]; then
    DISPLAY_NUM="${DESKTOP_DISPLAY:-:99}"
    RESOLUTION="${DESKTOP_RESOLUTION:-1920x1080}"
    echo "[entrypoint-dev] starting Xvfb on ${DISPLAY_NUM} at ${RESOLUTION}"
    Xvfb "$DISPLAY_NUM" -screen 0 "${RESOLUTION}x24" -ac +extension GLX +render -noreset &
    XVFB_PID=$!
    export DISPLAY="$DISPLAY_NUM"
    for i in $(seq 1 20); do
        if xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1; then break; fi
        sleep 0.2
    done
    echo "[entrypoint-dev] starting i3 window manager"
    i3 &
    xset s off 2>/dev/null || true
    xset -dpms 2>/dev/null || true
    xset s noblank 2>/dev/null || true
    xsetroot -solid "#1a1a2e" 2>/dev/null || true
fi

# -- Start Rust backend -------------------------------------------------------
echo "[entrypoint-dev] starting sandboxed-sh backend on ${HOST:-127.0.0.1}:${PORT:-3000}"
sandboxed-sh &
BACKEND_PID=$!

echo "[entrypoint-dev] waiting for backend health..."
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:${PORT:-3000}/api/health >/dev/null 2>&1; then
        echo "[entrypoint-dev] backend ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "[entrypoint-dev] WARNING: backend not healthy after 15s, continuing anyway"
    fi
    sleep 0.5
done

# -- Start Next.js dashboard in DEV mode --------------------------------------
# Full HMR + error overlay + original file paths in DevTools. Source lives
# at /opt/dashboard-src; node_modules baked in. We use `bun next dev` rather
# than `pnpm dev` because the runtime image ships bun, not pnpm.
echo "[entrypoint-dev] starting Next.js dashboard in DEV mode on port 3001"
cd /opt/dashboard-src
PORT=3001 HOSTNAME=127.0.0.1 NEXT_PUBLIC_API_URL="" \
    bun run next dev --port 3001 --hostname 127.0.0.1 &
DASHBOARD_PID=$!
cd /

# -- Start Caddy (foreground — PID 1) ----------------------------------------
echo "[entrypoint-dev] starting Caddy reverse proxy on :80"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
