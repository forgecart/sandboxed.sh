//! Native window wrapper around code.forgecart.com.
//!
//! The window URL points at the production dashboard (set in
//! `tauri.conf.json::app.windows[0].url`), so every deploy of the
//! dashboard immediately reaches the app — no rebuild needed for
//! UI changes. We do not expose any system APIs to the page; the
//! shell is intentionally inert so the web app's existing CSP
//! and auth path stay the source of truth.
//!
//! Plugins:
//!   - `tauri_plugin_shell`         — `Open in browser` for
//!     external links the user might invoke via the menu.
//!   - `tauri_plugin_window_state`  — remembers window size /
//!     position across launches.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running Forgecart Code desktop");
}
