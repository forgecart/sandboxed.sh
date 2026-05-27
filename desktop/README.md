# Forgecart Code Desktop

Tauri 2 native window wrapping [`code.forgecart.com`](https://code.forgecart.com).

The shell is a thin chrome around the existing dashboard URL — every web deploy
reaches the app instantly, no rebuild required. ~10 MB binary vs ~150 MB for an
equivalent Electron build.

## Prerequisites

- Rust 1.77+ (`rustup`)
- Node + bun/npm
- Platform deps for WebView:
  - **macOS** — preinstalled (WKWebView)
  - **Linux** — `apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows** — WebView2 runtime (auto-installed by Tauri's bootstrapper)

## Develop

```bash
cd desktop
bun install
bun run dev
```

`tauri dev` opens a window pointed at `https://code.forgecart.com/`. The Rust
shell is hot-rebuilt; the web page is whatever the production deploy is serving.

## Build

```bash
cd desktop
bun run build
```

Outputs platform binaries under `src-tauri/target/release/bundle/`:

| Platform | Artifacts |
|----------|-----------|
| macOS    | `.dmg`, `.app` |
| Windows  | `.msi`, `.exe` setup |
| Linux    | `.deb`, `.AppImage`, `.rpm` |

## Regenerate icons

The repo ships icons derived from `android_dashboard/metadata/icon.png`. To
regenerate from a fresh source:

```bash
bun run icons   # tauri-cli icon -> writes 32, 128, 128@2x, icns, ico
```

## How the URL is wired

`tauri.conf.json::app.windows[0].url` is `https://code.forgecart.com/`. Tauri 2
supports remote URLs natively. The `frontendDist` stub (`../frontend/index.html`)
is bundled in the binary as a fallback — if DNS / network is broken the user
sees a "Loading…" page with a link out to the browser; otherwise the window
goes straight to the production dashboard.

No system APIs are exposed to the web page beyond the default `core:webview` /
`core:window` / `core:event` set + `shell:allow-open` (so external links can
open in the OS browser) and the `window-state` plugin (so the window size /
position survive a restart). The web app's own CSP + auth stay the source of
truth.

## CI

`.github/workflows/desktop.yml` builds for macOS + Windows + Linux on every
push to `master` and uploads the artifacts to the workflow run. Tag a
`desktop-v*` ref to cut a GitHub Release with attached binaries.
