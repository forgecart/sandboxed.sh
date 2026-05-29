# =============================================================================
# sandboxed.sh — All-in-One Docker Image
# =============================================================================
# Multi-stage build: Rust backend + Next.js dashboard + runtime with AI CLIs
# Formerly known as "Open Agent"
#
# Build:   docker build -t sandboxed-sh .
# Run:     docker compose up
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Rust builder
# ---------------------------------------------------------------------------
FROM rust:1.91-bookworm AS rust-builder

WORKDIR /build

# Copy manifests first for better layer caching
COPY Cargo.toml ./

# Generate Cargo.lock if it doesn't exist in the context
RUN cargo generate-lockfile 2>/dev/null || true

# Create stub source so cargo can resolve deps
RUN mkdir -p src/bin \
    && echo "fn main() {}" > src/main.rs \
    && echo "fn main() {}" > src/bin/desktop_mcp.rs \
    && echo "fn main() {}" > src/bin/workspace_mcp.rs \
    && cargo build --release --lib 2>/dev/null || true \
    && cargo build --release 2>/dev/null || true

# Copy real source and build. bundled-library/ is required at the workspace
# root because src/library/mod.rs uses include_str!("../../bundled-library/…")
# to bake skill manifests + workspace templates into the binary at compile time.
COPY src/ src/
COPY bundled-library/ bundled-library/
RUN cargo build --release --bin sandboxed-sh --bin desktop-mcp --bin workspace-mcp --bin bg-watchd

# ---------------------------------------------------------------------------
# Stage 2: Dashboard builder
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS dashboard-builder

WORKDIR /build/dashboard

COPY dashboard/package.json dashboard/bun.lock ./
RUN bun install --frozen-lockfile

COPY dashboard/ .

# Empty API URL — the Caddyfile proxies /api to the backend at runtime
ENV NEXT_PUBLIC_API_URL=""
# standalone output for Docker (not needed for Vercel)
ENV STANDALONE=true
RUN bun run build

# ---------------------------------------------------------------------------
# Stage 3: Runtime (Ubuntu 24.04 for native debootstrap support)
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# -- Core system deps --------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq unzip openssh-client ca-certificates gnupg \
    # lsof: used by bg-watchd to discover which PID owns a backgrounded
    # bash task's .output file. procps gives us `ps` for the same
    # daemon's PID-stats path.
    lsof procps \
    # nspawn / container workspaces
    systemd-container debootstrap \
    # Desktop automation
    xvfb i3 x11-utils x11-xserver-utils xdotool scrot imagemagick \
    tesseract-ocr at-spi2-core \
    fonts-liberation fonts-dejavu fonts-noto \
    # Chromium
    chromium-browser \
    && rm -rf /var/lib/apt/lists/* \
    # Add plucky (25.04) script for future Ubuntu releases
    && ln -sf gutsy /usr/share/debootstrap/scripts/plucky

# -- Node.js 20 (for Next.js standalone runtime) ------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# -- Bun (preferred package manager for global installs + bunx) ---------------
RUN curl -fsSL https://bun.sh/install | bash \
    && install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun \
    && install -m 0755 /root/.bun/bin/bunx /usr/local/bin/bunx

# -- Caddy (reverse proxy) ---------------------------------------------------
RUN curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/ubuntu noble main" \
      > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/*

# -- kubectl (workspace pod exec/log/cp shellout) ----------------------------
# The K8sPod backend (src/k8s_pod.rs) drives workspace-pod exec by shelling
# out to kubectl rather than going through kube-rs's WebSocket exec path —
# kube-rs 0.96's WS upgrade hits a 403 against the RKE2 1.34 API server in
# our cluster, while kubectl handles it cleanly with the same SA token. The
# binary lives at /usr/local/bin/kubectl; the control plane invokes it with
# `--token` / `--certificate-authority` / `--server` pointing at the
# in-cluster ServiceAccount mount + KUBERNETES_SERVICE_HOST.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key \
       | gpg --batch --yes --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /" \
       > /etc/apt/sources.list.d/kubernetes.list \
    && apt-get update && apt-get install -y --no-install-recommends kubectl \
    && rm -rf /var/lib/apt/lists/*

# -- Copy Rust binaries from builder -----------------------------------------
COPY --from=rust-builder /build/target/release/sandboxed-sh /usr/local/bin/sandboxed-sh
COPY --from=rust-builder /build/target/release/desktop-mcp /usr/local/bin/desktop-mcp
COPY --from=rust-builder /build/target/release/workspace-mcp /usr/local/bin/workspace-mcp
COPY --from=rust-builder /build/target/release/bg-watchd /usr/local/bin/bg-watchd

# -- Copy dashboard standalone build ------------------------------------------
COPY --from=dashboard-builder /build/dashboard/.next/standalone /opt/dashboard
COPY --from=dashboard-builder /build/dashboard/.next/static /opt/dashboard/.next/static
COPY --from=dashboard-builder /build/dashboard/public /opt/dashboard/public

# -- Pre-install AI harness CLIs (optional — agents still work if these fail) -
# Uses bun for global installs (faster than npm, and our preferred package manager)
ENV PATH="/root/.bun/bin:/root/.cache/.bun/bin:${PATH}"
RUN bun install -g @anthropic-ai/claude-code@latest \
    && echo "[docker] Claude Code CLI installed: $(claude --version 2>/dev/null || echo 'unknown')" \
    || echo "[docker] WARNING: Claude Code CLI install failed (will be installed on first mission)"
RUN curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path \
    && install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && echo "[docker] OpenCode CLI installed: $(opencode --version 2>/dev/null || echo 'unknown')" \
    || echo "[docker] WARNING: OpenCode CLI install failed (will be installed on first mission)"
RUN curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/usr/local/bin bash \
    && echo "[docker] Grok Build CLI installed: $(grok --version 2>/dev/null || echo 'unknown')" \
    || echo "[docker] WARNING: Grok Build CLI install failed (will be installed on first mission)"

# -- RTK (CLI output compressor for token savings) --
RUN RTK_ARCH=$(case "$(uname -m)" in aarch64|arm64) echo "aarch64";; *) echo "x86_64";; esac) \
    && curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/rtk-${RTK_ARCH}-unknown-linux-gnu.tar.gz" \
    | tar xz -C /usr/local/bin rtk \
    && chmod +x /usr/local/bin/rtk \
    && echo "[docker] RTK installed: $(rtk --version 2>/dev/null || echo 'unknown')" \
    || echo "[docker] WARNING: RTK install failed (token savings will not be available)"

# -- i3 config (from install_desktop.sh) -------------------------------------
RUN mkdir -p /root/.config/i3
COPY docker/i3config /root/.config/i3/config

# -- Caddy config + entrypoint -----------------------------------------------
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# -- Working directories ------------------------------------------------------
RUN mkdir -p /root/.sandboxed-sh /root/.claude /root/work/screenshots

# -- Environment defaults -----------------------------------------------------
ENV HOST=127.0.0.1 \
    PORT=3000 \
    WORKING_DIR=/root \
    DEV_MODE=true \
    DESKTOP_ENABLED=true \
    DESKTOP_RESOLUTION=1920x1080 \
    GIT_TERMINAL_PROMPT=0

EXPOSE 80
VOLUME ["/root/.sandboxed-sh", "/root/.claude"]

ENTRYPOINT ["/entrypoint.sh"]
