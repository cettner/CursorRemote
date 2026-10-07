// Keeps a console window from appearing behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cursor_remote_desktop_lib::run()
}
