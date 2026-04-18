#[cfg(feature = "desktop")]
mod asset_protocol;
#[cfg(feature = "desktop")]
mod commands;
pub mod domain;
#[cfg(feature = "desktop")]
mod import;
pub mod storage;
pub mod util;
#[cfg(feature = "desktop")]
mod watcher;

#[cfg(feature = "desktop")]
use commands::state::AppState;
#[cfg(feature = "desktop")]
use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::asset_protocol::register(tauri::Builder::default())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::vault::select_vault,
            commands::vault::open_vault,
            commands::vault::get_vault_path,
            commands::vault::list_known_vaults,
            commands::vault::start_vault_sync,
            commands::vault::rebuild_index,
            commands::blocks::list_blocks,
            commands::blocks::list_grid_blocks,
            commands::blocks::get_block,
            commands::blocks::create_block,
            commands::blocks::delete_block,
            commands::tags::list_tags,
            commands::tags::add_tag,
            commands::tags::remove_tag,
            commands::tags::rename_tag,
            commands::tags::delete_tag_from_all,
            commands::search::search,
            commands::channels::list_channels,
            commands::channels::list_taxonomy_snapshot,
            commands::channels::create_channel,
            commands::channels::reorder_channels,
            commands::channels::rename_channel,
            commands::channels::delete_channel,
            commands::channels::list_channel_previews,
            commands::import::list_arena_channels,
            commands::import::import_arena_channels,
            commands::thumbnails::save_thumb,
            commands::thumbnails::list_pending_thumb_upgrades,
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            match crate::util::acquire_single_instance("com.mine.app")? {
                crate::util::SingleInstanceAcquire::Primary(guard) => {
                    app.state::<AppState>().set_instance_guard(guard)?;
                }
                crate::util::SingleInstanceAcquire::Secondary => {
                    log::warn!("second Mine instance suppressed");
                    std::process::exit(0);
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ── Native macOS menu ────────────────────────────────────────
            let app_menu = SubmenuBuilder::new(app, "Mine")
                .about(Some(AboutMetadata {
                    name: Some("Mine".into()),
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
