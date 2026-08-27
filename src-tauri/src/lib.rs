#[cfg(feature = "desktop")]
mod asset_protocol;
mod swipe_gesture;
#[cfg(feature = "desktop")]
pub mod bindings;
#[cfg(feature = "desktop")]
mod commands;
pub mod cli;
pub mod domain;
#[cfg(feature = "desktop")]
mod import;
pub mod net;
pub mod storage;
pub mod util;
#[cfg(feature = "desktop")]
mod watcher;

#[cfg(feature = "desktop")]
use commands::state::AppState;
#[cfg(feature = "desktop")]
use commands::window_chrome::{MENU_ID_TOGGLE_SIDEBAR, MENU_ID_VIEW};
#[cfg(feature = "desktop")]
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
#[cfg(feature = "desktop")]
use tauri::Emitter;
#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
const MENU_ID_FIND_CARDS: &str = "surface-search-find-cards";
#[cfg(feature = "desktop")]
const MENU_ID_FIND_CHANNELS: &str = "surface-search-find-channels";
/// App menu item opening the standalone settings window (`Cmd+,`).
const MENU_ID_SETTINGS: &str = "open-settings-window";

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::asset_protocol::register(tauri::Builder::default())
        .manage(AppState::new())
        // Article audio commands are registered only with the `article-audio`
        // feature; `generate_handler!` takes a flat list, so the gate lives on
        // this attribute rather than on individual entries.
        .invoke_handler(tauri::generate_handler![
            #[cfg(feature = "article-audio")]
            commands::article_audio::get_article_audio_state,
            #[cfg(feature = "article-audio")]
            commands::article_audio::generate_article_audio,
            #[cfg(feature = "article-audio")]
            commands::article_audio::delete_article_audio,
            #[cfg(feature = "article-audio")]
            commands::article_audio::set_article_audio_position,
            commands::vault::select_vault,
            commands::vault::open_vault,
            commands::vault::get_vault_path,
            commands::vault::list_known_vaults,
            commands::vault::start_vault_sync,
            commands::vault::rebuild_index,
            commands::vault::sweep_vault_thumbnails,
            commands::clipper_setup::get_clipper_setup_status,
            commands::icloud_progress::icloud_download_progress,
            commands::cloud_recommendation::cloud_recommendation_state,
            commands::cloud_recommendation::dismiss_cloud_recommendation,
            commands::vault::first_card_marker_pending,
            commands::vault::complete_first_card_marker,
            commands::clipper_setup::install_clipper_host,
            commands::vault::preview_vault_folder,
            commands::vault::get_unavailable_vault,
            commands::vault::forget_unavailable_vault,
            commands::vault::get_vault_write_layout,
            commands::vault::set_vault_write_layout,
            commands::vault::organize_vault_layout,
            commands::vault_stats::get_vault_stats,
            commands::blocks::list_blocks,
            commands::blocks::list_grid_blocks,
            commands::graph::list_graph_snapshot,
            commands::blocks::get_block,
            commands::blocks::create_block,
            commands::blocks::extract_inline_media,
            commands::blocks::create_media_asset_card,
            commands::blocks::rename_media_asset,
            commands::blocks::prepare_delete_media_asset,
            commands::blocks::delete_media_asset,
            commands::blocks::remove_media_asset_from_card,
            commands::blocks::copy_media_asset_to_clipboard,
            commands::clipboard::read_clipboard_payload,
            commands::shortcuts::list_shortcut_overrides,
            commands::shortcuts::save_shortcut_overrides,
            commands::blocks::extract_text_selection,
            commands::blocks::delete_text_selection,
            commands::blocks::rename_block_file,
            commands::blocks::prepare_delete_block,
            commands::blocks::delete_block,
            commands::blocks::merge_blocks,
            commands::tags::list_tags,
            commands::tags::add_tag,
            commands::tags::remove_tag,
            commands::tags::rename_tag,
            commands::tags::delete_tag_from_all,
            commands::search::search,
            commands::search::search_grid_blocks,
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
            commands::thumbnails::save_tile_poster,
            commands::thumbnails::list_pending_thumb_upgrades,
            commands::conflicts::list_vault_conflicts,
            commands::conflicts::resolve_vault_conflict,
            commands::settings::open_settings_window,
            commands::settings::add_known_vault,
            commands::settings::forget_known_vault,
            commands::settings::reorder_known_vaults,
            commands::settings::space_stats,
            commands::settings::list_orphan_media,
            commands::settings::promote_orphan_media,
            commands::settings::delete_orphan_media,
            commands::window_chrome::set_sidebar_menu_collapsed,
            commands::native_shell_smoke::report_native_shell_smoke,
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Copying a path is a desktop operation, not a web one: WKWebView
        // refuses navigator.clipboard once the menu that triggered it takes
        // focus away, and the rejection is invisible.
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_ID_FIND_CARDS => {
                let _ = app.emit("surface-search-shortcut", "main");
            }
            MENU_ID_FIND_CHANNELS => {
                let _ = app.emit("surface-search-shortcut", "sidebar");
            }
            MENU_ID_TOGGLE_SIDEBAR => {
                let _ = app.emit("sidebar-toggle-shortcut", ());
            }
            MENU_ID_SETTINGS => {
                let _ = commands::settings::open_settings_window(app.clone(), None);
            }
            _ => {}
        })
        .setup(|app| {
            let instance_id = if commands::native_shell_smoke::enabled() {
                "com.mine.app.native-shell-smoke"
            } else {
                "com.mine.app"
            };
            match crate::util::acquire_single_instance(instance_id)? {
                crate::util::SingleInstanceAcquire::Primary(guard) => {
                    app.state::<AppState>().set_instance_guard(guard)?;
                }
                crate::util::SingleInstanceAcquire::Secondary => {
                    log::warn!("second Mine instance suppressed");
                    std::process::exit(0);
                }
            }

            // The two-finger swipe is recognised here, where the system
            // describes its phases, and reaches the interface as a decision.
            swipe_gesture::install(app.handle().clone());

            // An installed clipper must run this build's host, not the one it
            // was installed from.
            commands::clipper_setup::refresh_installed_host(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if commands::native_shell_smoke::enabled() {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| anyhow::anyhow!("native-shell smoke main window is missing"))?;
                let url = tauri::Url::parse(&format!(
                    "tauri://localhost/index.html?{}=1",
                    commands::native_shell_smoke::QUERY_FLAG,
                ))?;
                window.navigate(url)?;
            }

            // ── Native macOS menu ────────────────────────────────────────
            //
            // Built from the same shortcut overrides the interface uses, and
            // rebuilt when they change: in macOS a menu accelerator consumes
            // the key event before the webview sees it, so a stale menu would
            // fire the old command or swallow the new one.
            let menu = build_app_menu(app.handle(), &commands::shortcuts::load_overrides(app.handle()))?;
            app.set_menu(menu)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The application menu, with accelerators resolved from the user's overrides.
fn build_app_menu(
    app: &tauri::AppHandle,
    overrides: &commands::shortcuts::ShortcutOverrides,
) -> anyhow::Result<tauri::menu::Menu<tauri::Wry>> {
    // Menu ids that mirror a command in the registry. A rebound command takes
    // its accelerator from the override; the rest keep the shipped default.
    let accelerator = |command_id: &str, fallback: &str| -> String {
        overrides
            .get(command_id)
            .map(|binding| binding.accelerator())
            .unwrap_or_else(|| fallback.to_string())
    };

    let settings_item = MenuItemBuilder::with_id(MENU_ID_SETTINGS, "Settings…")
        .accelerator(accelerator("settings", "CmdOrCtrl+,"))
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Mine")
        .about(Some(AboutMetadata {
            name: Some("Mine".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            copyright: Some("2026".into()),
            credits: Some("Local-first visual bookmarking".into()),
            ..Default::default()
        }))
        .separator()
        .item(&settings_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let find_cards_item = MenuItemBuilder::with_id(MENU_ID_FIND_CARDS, "Find Elements")
        .accelerator(accelerator("find-elements", "CmdOrCtrl+F"))
        .build(app)?;
    let find_channels_item = MenuItemBuilder::with_id(MENU_ID_FIND_CHANNELS, "Find Collections")
        .accelerator(accelerator("find-collections", "CmdOrCtrl+Shift+F"))
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find_cards_item)
        .item(&find_channels_item)
        .build()?;

    let toggle_sidebar_item = MenuItemBuilder::with_id(MENU_ID_TOGGLE_SIDEBAR, "Hide Sidebar")
        .accelerator(accelerator("toggle-sidebar", "Ctrl+Cmd+S"))
        .build(app)?;
    let view_menu = SubmenuBuilder::with_id(app, MENU_ID_VIEW, "View")
        .item(&toggle_sidebar_item)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    Ok(MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
        .build()?)
}

/// Rebuild the menu after the user rebinds a command.
pub fn refresh_app_menu(app: &tauri::AppHandle) {
    let overrides = commands::shortcuts::load_overrides(app);
    match build_app_menu(app, &overrides) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                log::warn!("failed to apply rebuilt menu: {e}");
            }
        }
        Err(e) => log::warn!("failed to rebuild menu: {e:#}"),
    }
}
