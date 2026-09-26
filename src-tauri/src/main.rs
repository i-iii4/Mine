// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "desktop")]
    if mine_lib::updater::handle_helper_mode() {
        return;
    }
    mine_lib::util::mark_process_started();
    mine_lib::run();
}
