mod commands;
pub mod domain;
mod import;
pub mod storage;
pub mod util;
mod watcher;

use commands::state::AppState;
use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::vault::select_vault,
            commands::vault::get_vault_path,
            commands::vault::rebuild_index,
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
            commands::channels::reorder_channels,
            commands::channels::delete_channel,
            commands::import::list_arena_channels,
            commands::import::import_arena_channels,
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

            // ── Native macOS menu ────────────────────────────────────────
            let app_menu = SubmenuBuilder::new(app, "Local Arena")
                .about(Some(AboutMetadata {
                    name: Some("Local Arena".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    copyright: Some("2026".into()),
                    credits: Some("Local-first visual bookmarking".into()),
                    ..Default::default()
                }))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .fullscreen()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
