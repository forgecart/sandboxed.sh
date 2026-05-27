// Avoid spawning a stub console window on Windows release builds.
// In dev we keep the console so println! / panics surface.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    forgecart_code_desktop_lib::run()
}
