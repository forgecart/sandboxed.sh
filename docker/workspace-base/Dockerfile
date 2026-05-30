# Workspace-base image — the rootfs every `workspace_type: k8s_pod`
# workspace boots into. It pre-installs the same toolchain the legacy
# nspawn-Container init.sh installs at build time (docker, node + pnpm,
# claude, gh, kubectl, terraform), so the pod is mission-ready ~5s
# after `Running` instead of ~3 min after debootstrap.
#
# The control-plane sandboxed-sh deployment references this image via
# the `SANDBOXED_SH_K8S_WORKSPACE_IMAGE` env var. CI builds + pushes it
# alongside the main `forgecart/sandboxed-sh` image. See
# `.github/workflows/build-and-publish.yml`.
#
# Build context = repo root (so the COPY of entrypoint.sh resolves).

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tools the workspace and agents need.
# `inotify-tools` ships `inotifywait`, used by the dashboard's
# /fs-events WebSocket to stream pod-side file changes for live
# editor updates.
# `jq` is relied on heavily by the agents for parsing JSON from the
# control-plane / dashboard HTTP API (see the cross-mission API
# snippets in cloud's CLAUDE.md) — without it agents fall back to
# ad-hoc python3 one-liners.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl gnupg lsb-release \
        git openssh-client \
        sudo less jq \
        iproute2 iptables \
        inotify-tools \
        tini \
    && rm -rf /var/lib/apt/lists/*

# --- docker (engine + cli + compose plugin) --------------------------------
# Installed from Docker's official apt repo. K8s pods get a writable
# /proc/sys for their own netns, so the bridge driver + ip_forward
# sysctls "just work" — no daemon.json hacks like the nspawn path.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
       | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# --- node + pnpm + claude --------------------------------------------------
# Pinned to the same version sandboxed.sh's resolver expects
# (`desired_claudecode_version()` in src/api/mission_runner.rs). Pinning
# avoids the "bun-fallback hang" path the resolver takes when
# /usr/local/bin/claude --version doesn't substring-match.
ARG CLAUDE_VERSION=2.1.140
# typescript-language-server runs alongside the agent so the dashboard's
# Monaco editor can connect over the LSP WebSocket bridge (see
# `/api/control/missions/:id/lsp`) and get real cross-file diagnostics,
# completions, etc. ~30 MB image bump, ~80 MB resident per pod. Pinned
# so a tsserver upgrade doesn't quietly break the LSP wire protocol.
ARG TS_VERSION=5.7.3
ARG TS_LSP_VERSION=4.4.0
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g --silent pnpm@latest \
    && npm install -g --silent "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm install -g --silent \
        "typescript@${TS_VERSION}" \
        "typescript-language-server@${TS_LSP_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

# --- gh ---------------------------------------------------------------------
RUN curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- kubectl ---------------------------------------------------------------
RUN curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key \
        | gpg --batch --yes --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /" \
        > /etc/apt/sources.list.d/kubernetes.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends kubectl \
    && rm -rf /var/lib/apt/lists/*

# --- terraform -------------------------------------------------------------
RUN curl -fsSL https://apt.releases.hashicorp.com/gpg \
        | gpg --batch --yes --dearmor -o /etc/apt/keyrings/hashicorp-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/hashicorp-archive-keyring.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com ${VERSION_CODENAME} main" \
        > /etc/apt/sources.list.d/hashicorp.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends terraform \
    && rm -rf /var/lib/apt/lists/*

# --- rust toolchain --------------------------------------------------------
# Mirrors CI's `dtolnay/rust-toolchain@stable` (.github/workflows/ci.yml) so a
# mission editing the sandboxed.sh crate can run the exact same gates locally:
#   cargo check / cargo test --locked --workspace
#   cargo clippy --locked --workspace -- -D clippy::all   (needs clippy)
#   cargo fmt --all -- --check                            (needs rustfmt)
# rustfmt + clippy are pulled as components to match CI's dedicated fmt/clippy
# jobs. `stable` (overridable via ARG) tracks CI rather than pinning, since the
# crate declares only an MSRV (rust-version = 1.91), no rust-toolchain.toml.
#
# Installed system-wide under /usr/local (RUSTUP_HOME/CARGO_HOME) instead of
# ~/.cargo so it's independent of HOME and survives the control plane's PVC
# bind-mounts onto /root. build-essential + pkg-config + libssl-dev are needed
# to *build*, not just install: the linker (cc) and openssl-sys's native
# OpenSSL probe (reqwest's default-tls / native-tls path is in Cargo.lock).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
ARG RUST_TOOLCHAIN=stable
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
       | sh -s -- -y --no-modify-path --profile minimal \
           --default-toolchain "${RUST_TOOLCHAIN}" \
           -c rustfmt -c clippy \
    && chmod -R a+w "${RUSTUP_HOME}" "${CARGO_HOME}" \
    && /usr/local/cargo/bin/rustc --version \
    && /usr/local/cargo/bin/cargo --version \
    && /usr/local/cargo/bin/cargo fmt --version \
    && /usr/local/cargo/bin/cargo clippy --version

# --- entrypoint + bashenv autostart ----------------------------------------
COPY docker/workspace-base/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Sourced by every `bash -c` thanks to BASH_ENV. Mirrors the same hook
# the nspawn-Container's init.sh writes — minus the daemon.json
# work-arounds, since k8s lets dockerd write to /proc/sys/net/* freely.
COPY docker/workspace-base/bashenv.sh /etc/sandboxed-bashenv.sh
RUN chmod 755 /etc/sandboxed-bashenv.sh \
    && printf '\n# sandboxed.sh: source BASH_ENV hook for interactive shells\n[ -r /etc/sandboxed-bashenv.sh ] && . /etc/sandboxed-bashenv.sh\n' >> /etc/bash.bashrc

# Mount points the control plane bind-mounts PVCs onto.
RUN mkdir -p /workspaces /var/lib/docker /etc/sandboxed

ENV BASH_ENV=/etc/sandboxed-bashenv.sh \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root

WORKDIR /workspaces

# tini handles PID-1 reaping so dockerd's child processes don't zombie.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
