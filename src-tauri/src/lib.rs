mod commands;
mod domain;
mod storage;
mod watcher;

use commands::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::vault::select_vault,
            commands::vault::get_vault_path,
            commands::blocks::list_blocks,
            commands::blocks::get_block,
            commands::blocks::create_block,
            commands::blocks::delete_block,
            commands::tags::list_tags,
            commands::tags::add_tag,
            commands::tags::remove_tag,
            commands::search::search,
            commands::channels::list_channels,
            commands::channels::create_channel,
            commands::channels::delete_channel,
        ])
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
