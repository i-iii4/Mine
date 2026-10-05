#[cfg(feature = "desktop")]
mod asset_protocol;
#[cfg(feature = "desktop")]
pub mod bindings;
#[cfg(feature = "desktop")]
pub mod cli;
pub mod cli_mutations;
#[cfg(feature = "desktop")]
mod commands;
#[cfg(feature = "desktop")]
pub use commands::clipper_setup::{
    install_development_runtime, DevelopmentRuntimeInputs, DevelopmentRuntimeReport,
    RuntimeInstallationError,
};
pub mod app_config;
pub mod clipper_registration;
pub mod domain;
#[cfg(feature = "desktop")]
mod frame_context_menu;
#[cfg(feature = "desktop")]
mod import;
pub mod markdown_images;
#[cfg(feature = "desktop")]
pub mod mcp;
pub mod net;
pub mod runtime_installation;
pub mod runtime_protocol;
pub mod space_registry;
pub mod storage;
#[cfg(feature = "desktop")]
mod source_video_download;
#[cfg(feature = "desktop")]
mod swipe_gesture;
#[cfg(feature = "desktop")]
mod tabs;
#[cfg(feature = "desktop")]
pub mod update_activation;
#[cfg(feature = "desktop")]
pub mod updater;
pub mod util;
#[cfg(feature = "desktop")]
mod watcher;
#[cfg(feature = "desktop")]
mod youtube_embed;

#[cfg(feature = "desktop")]
use commands::state::AppState;
#[cfg(feature = "desktop")]
use commands::window_chrome::{MENU_ID_TOGGLE_SIDEBAR, MENU_ID_VIEW};
#[cfg(feature = "desktop")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "desktop")]
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
#[cfg(feature = "desktop")]
use tauri::Manager;

/// File and Window menu items about tabs and windows (SPEC_TABS.md, В57).
#[cfg(feature = "desktop")]
const MENU_ID_NEW_TAB: &str = "tabs-new-tab";
#[cfg(feature = "desktop")]
const MENU_ID_NEW_WINDOW: &str = "tabs-new-window";
#[cfg(feature = "desktop")]
const MENU_ID_CLOSE_TAB: &str = "tabs-close-tab";
#[cfg(feature = "desktop")]
const MENU_ID_CLOSE_WINDOW: &str = "tabs-close-window";
#[cfg(feature = "desktop")]
const MENU_ID_PREVIOUS_TAB: &str = "tabs-previous-tab";
#[cfg(feature = "desktop")]
const MENU_ID_NEXT_TAB: &str = "tabs-next-tab";
#[cfg(feature = "desktop")]
const MENU_ID_MOVE_TAB_TO_NEW_WINDOW: &str = "tabs-move-to-new-window";
/// `tabs-select-1` … `tabs-select-8` pick a tab by position, `tabs-select-9`
/// the last tab.
#[cfg(feature = "desktop")]
const MENU_ID_SELECT_TAB_PREFIX: &str = "tabs-select-";
#[cfg(feature = "desktop")]
const MENU_ID_FIND_CARDS: &str = "surface-search-find-cards";
#[cfg(feature = "desktop")]
const MENU_ID_FIND_CHANNELS: &str = "surface-search-find-channels";
/// App menu item opening the standalone settings window (`Cmd+,`).
#[cfg(feature = "desktop")]
const MENU_ID_SETTINGS: &str = "open-settings-window";
#[cfg(feature = "desktop")]
static SHORTCUT_CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "desktop")]
pub(crate) fn application_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    crate::asset_protocol::register(tauri::Builder::default())
        .manage(AppState::new())
        .manage(updater::UpdateService::default())
        .manage(youtube_embed::YoutubeEmbedServer::default())
        .manage(source_video_download::SourceVideoDownloads::default())
        // Article audio commands are registered only with the `article-audio`
        // feature; `generate_handler!` takes a flat list, so the gate lives on
        // this attribute rather than on individual entries.
        .invoke_handler(tauri::generate_handler![
            commands::tabs::get_tab_bootstrap,
            commands::tabs::get_tabbar_bootstrap,
            commands::tabs::report_tab_view,
            commands::tabs::tab_painted,
            commands::tabs::report_tab_history,
            commands::tabs::open_place,
            commands::tabs::set_chrome_rows,
            commands::tabs::step_tab_history,
            commands::tabs::activate_tab,
            commands::tabs::activate_adjacent_tab,
            commands::tabs::new_tab,
            commands::tabs::close_tab,
            commands::tabs::close_other_tabs,
            commands::tabs::move_tab,
            commands::tabs::set_window_sidebar,
            commands::tabs::start_window_drag,
            commands::tabs::report_window_surface,
            commands::tabs::show_space,
            commands::tabs::spaces_in_tabs,
            commands::tabs::dismiss_space_notice,
            commands::tabs::space_notice_dismissed,
            commands::tabs::move_tab_to_new_window,
            commands::tabs::begin_tab_drag,
            commands::tabs::report_drop_slot,
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
            commands::vault::selection_generation,
            commands::vault::get_vault_path,
            commands::vault::list_known_vaults,
            commands::vault::list_spaces,
            commands::vault::start_vault_sync,
            commands::startup::record_startup_milestone,
            commands::startup::start_startup_maintenance,
            commands::vault::rebuild_index,
            commands::vault::sweep_vault_thumbnails,
            commands::updates::get_update_status,
            commands::updates::check_for_updates,
            commands::updates::download_update,
            commands::updates::install_update,
            commands::updates::restore_previous_update,
            commands::icloud_progress::icloud_download_progress,
            commands::cloud_recommendation::cloud_recommendation_state,
            commands::cloud_recommendation::dismiss_cloud_recommendation,
            commands::vault::first_card_marker_pending,
            commands::vault::complete_first_card_marker,
            commands::vault::space_onboarding_pending,
            commands::clipper_setup::clipper_extension_folder,
            commands::vault::get_unavailable_vault,
            commands::vault::forget_unavailable_vault,
            commands::vault::get_vault_write_layout,
            commands::vault::set_vault_write_layout,
            commands::vault::organize_vault_layout,
            commands::vault_stats::get_vault_stats,
            commands::blocks::list_blocks,
            commands::blocks::list_grid_blocks,
            commands::blocks::get_grid_rows,
            commands::graph::list_graph_snapshot,
            commands::blocks::get_block,
            commands::blocks::resolve_note_link,
            commands::blocks::create_block,
            commands::blocks::extract_inline_media,
            commands::blocks::create_media_asset_card,
            commands::blocks::rename_media_asset,
            commands::blocks::prepare_delete_media_asset,
            commands::blocks::delete_media_asset,
            commands::blocks::remove_media_asset_from_card,
            commands::blocks::delete_source_video,
            commands::blocks::copy_media_asset_to_clipboard,
            commands::clipboard::read_clipboard_payload,
            commands::shortcuts::list_shortcut_overrides,
            commands::shortcuts::save_shortcut_overrides,
            commands::shortcuts::set_shortcut_capture_active,
            commands::blocks::extract_text_selection,
            commands::blocks::delete_text_selection,
            commands::blocks::rename_block_file,
            commands::blocks::check_block_rename,
            commands::blocks::prepare_delete_block,
            commands::blocks::delete_block,
            commands::blocks::delete_blocks,
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
            commands::channels::check_collection_name,
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
            commands::youtube_player::youtube_player_url,
            commands::source_video_download::start_source_video_download,
            commands::source_video_download::cancel_source_video_download,
            commands::source_video_download::source_video_download_status,
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Copying a path is a desktop operation, not a web one: WKWebView
        // refuses navigator.clipboard once the menu that triggered it takes
        // focus away, and the rejection is invisible.
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // Tab windows handle their own events (`crate::tabs`).
            if window.label() == "settings"
                && matches!(
                    event,
                    tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed
                )
            {
                let _ = set_shortcut_capture_menu(window.app_handle(), false);
            }
        })
        .setup(|app| {
            updater::initialize(app.handle());
            // The lock is keyed by the build's identifier: a side instance
            // (`bun run dev:side`, identifier `com.mine.app.dev`) runs next to
            // the installed app with its own lock and its own data directory.
            let instance_id = if commands::native_shell_smoke::enabled() {
                "com.mine.app.native-shell-smoke".to_string()
            } else {
                app.config().identifier.clone()
            };
            match crate::util::acquire_single_instance(&instance_id)? {
                crate::util::SingleInstanceAcquire::Primary(guard) => {
                    app.state::<AppState>().set_instance_guard(guard)?;
                    crate::util::reset_startup_trace(app.handle());
                    crate::util::append_startup_trace(app.handle(), "process", "started");
                    crate::util::append_startup_trace(app.handle(), "setup", "start");
                }
                crate::util::SingleInstanceAcquire::Secondary => {
                    log::warn!("second Mine instance suppressed");
                    std::process::exit(0);
                }
            }

            // The two-finger swipe is recognised here, where the system
            // describes its phases, and reaches the interface as a decision.
            swipe_gesture::install(app.handle().clone());

            // A right click inside the embedded video player opens Mine's
            // menu instead of WebKit's frame menu.
            frame_context_menu::install(app.handle());


            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ── Native macOS menu ────────────────────────────────────────
            //
            // Built from the same shortcut overrides the interface uses, and
            // rebuilt when they change: in macOS a menu accelerator consumes
            // the key event before the webview sees it, so a stale menu would
            // fire the old command or swallow the new one.
            let menu = build_app_menu(
                app.handle(),
                &commands::shortcuts::load_overrides(app.handle()),
            )?;
            app.set_menu(menu)?;

            // The tab windows (SPEC_TABS.md, В35). The native shell check
            // runs beside the person's Mine and keeps its hands off their
            // saved windows (В34).
            let saved_windows_dir = if commands::native_shell_smoke::enabled() {
                None
            } else {
                app.path().app_data_dir().ok()
            };
            app.manage(tabs::TabShell::new(saved_windows_dir));
            tabs::restore(app.handle())?;
            crate::util::append_startup_trace(app.handle(), "window", "created");

            crate::util::append_startup_trace(app.handle(), "setup", "done");

            Ok(())
        })
        .build(application_context())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => commands::app_open::receive(app, &urls),
            // Quitting keeps every window as it stands for the next launch
            // (SPEC_TABS.md, В33).
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(shell) = app.try_state::<tabs::TabShell>() {
                    shell.quit();
                }
            }
            _ => {}
        });
}

/// The application menu, with accelerators resolved from the user's overrides.
#[cfg(feature = "desktop")]
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

    // Tabs and windows (SPEC_TABS.md, В57, В58): the File items are Mine's
    // own, the stock close item would hold ⌘W for the whole window.
    let item = |id: &str, title: &str, keys: &str| -> anyhow::Result<tauri::menu::MenuItem<tauri::Wry>> {
        Ok(MenuItemBuilder::with_id(id, title).accelerator(keys).build(app)?)
    };
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&item(MENU_ID_NEW_TAB, "New Tab", "CmdOrCtrl+T")?)
        .item(&item(MENU_ID_NEW_WINDOW, "New Window", "CmdOrCtrl+N")?)
        .separator()
        .item(&item(MENU_ID_CLOSE_TAB, "Close Tab", "CmdOrCtrl+W")?)
        .item(&item(MENU_ID_CLOSE_WINDOW, "Close Window", "CmdOrCtrl+Shift+W")?)
        .build()?;

    let mut window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&item(MENU_ID_PREVIOUS_TAB, "Show Previous Tab", "CmdOrCtrl+Shift+[")?)
        .item(&item(MENU_ID_NEXT_TAB, "Show Next Tab", "CmdOrCtrl+Shift+]")?)
        .item(&MenuItemBuilder::with_id(MENU_ID_MOVE_TAB_TO_NEW_WINDOW, "Move Tab to New Window").build(app)?)
        .separator();
    for position in 1..=9 {
        let title = if position == 9 {
            "Select Last Tab".to_string()
        } else {
            format!("Select Tab {position}")
        };
        window_menu = window_menu.item(&item(
            &format!("{MENU_ID_SELECT_TAB_PREFIX}{position}"),
            &title,
            &format!("CmdOrCtrl+{position}"),
        )?);
    }
    let window_menu = window_menu.build()?;

    Ok(MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?)
}

/// The tab window a menu command acts on: the one in focus, else the last
/// one (SPEC_TABS.md, В21).
#[cfg(feature = "desktop")]
fn menu_window(app: &tauri::AppHandle) -> Option<domain::windows::WindowId> {
    tabs::focused_tab_window(app).or_else(|| tabs::last_window(app))
}

/// The visible tab of the window a menu command acts on.
#[cfg(feature = "desktop")]
fn menu_tab(app: &tauri::AppHandle) -> Option<domain::windows::TabId> {
    let window = menu_window(app)?;
    let snapshot = app.state::<tabs::TabShell>().snapshot();
    snapshot.window(&window).map(|saved| saved.active_tab.clone())
}

#[cfg(feature = "desktop")]
fn on_menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        // Menu commands act on the tab in use (SPEC_TABS.md, В21).
        MENU_ID_FIND_CARDS => {
            commands::space_events::emit_to_active_tab(app, "surface-search-shortcut", "main");
        }
        MENU_ID_FIND_CHANNELS => {
            commands::space_events::emit_to_active_tab(app, "surface-search-shortcut", "sidebar");
        }
        MENU_ID_TOGGLE_SIDEBAR => {
            if let Some(window) = menu_window(app) {
                tabs::toggle_sidebar(app, &window);
            }
        }
        MENU_ID_SETTINGS => {
            let _ = commands::settings::open_settings_window(app.clone(), None);
        }
        MENU_ID_NEW_TAB => {
            if let Some(window) = menu_window(app) {
                let space = menu_tab(app)
                    .and_then(|tab| {
                        app.state::<tabs::TabShell>()
                            .snapshot()
                            .tab(&tab)
                            .map(|saved| saved.space.clone())
                    })
                    .unwrap_or(domain::windows::TabSpace::Picker);
                tabs::new_tab(app, &window, space);
            }
        }
        MENU_ID_NEW_WINDOW => tabs::new_window(app, tabs::last_visible_space(app)),
        // With the settings window in front, ⌘W and ⇧⌘W close it (В58).
        MENU_ID_CLOSE_TAB | MENU_ID_CLOSE_WINDOW if tabs::other_window_focused(app).is_some() => {
            if let Some(window) = tabs::other_window_focused(app) {
                let _ = window.close();
            }
        }
        MENU_ID_CLOSE_TAB => {
            if let Some(tab) = menu_tab(app) {
                tabs::close_tab(app, &tab);
            }
        }
        MENU_ID_CLOSE_WINDOW => {
            if let Some(window) = menu_window(app) {
                tabs::close_window(app, &window);
            }
        }
        MENU_ID_PREVIOUS_TAB | MENU_ID_NEXT_TAB => {
            let forward = id == MENU_ID_NEXT_TAB;
            if let Some(tab) = menu_tab(app) {
                let next = app.state::<tabs::TabShell>().snapshot().adjacent(&tab, forward);
                if let Some(next) = next {
                    tabs::activate(app, &next);
                }
            }
        }
        MENU_ID_MOVE_TAB_TO_NEW_WINDOW => {
            if let Some(tab) = menu_tab(app) {
                tabs::move_tab_to_new_window(app, &tab);
            }
        }
        _ => {
            let Some(position) = id
                .strip_prefix(MENU_ID_SELECT_TAB_PREFIX)
                .and_then(|digit| digit.parse::<usize>().ok())
            else {
                return;
            };
            let Some(window) = menu_window(app) else {
                return;
            };
            let at = (position < 9).then(|| position - 1);
            let tab = app.state::<tabs::TabShell>().snapshot().tab_at(&window, at);
            if let Some(tab) = tab {
                tabs::activate(app, &tab);
            }
        }
    }
}

/// Rebuild the menu after the user rebinds a command.
#[cfg(feature = "desktop")]
pub fn refresh_app_menu(app: &tauri::AppHandle) {
    if SHORTCUT_CAPTURE_ACTIVE.load(Ordering::SeqCst) {
        return;
    }
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

/// The macOS app menu consumes its accelerators before the settings webview.
/// Remove it only while recording; rebuild from current overrides on exit.
#[cfg(feature = "desktop")]
pub fn set_shortcut_capture_menu(app: &tauri::AppHandle, active: bool) -> tauri::Result<()> {
    let was_active = SHORTCUT_CAPTURE_ACTIVE.swap(active, Ordering::SeqCst);
    if active && !was_active {
        if let Err(error) = app.remove_menu() {
            SHORTCUT_CAPTURE_ACTIVE.store(false, Ordering::SeqCst);
            return Err(error);
        }
    } else if !active && was_active {
        refresh_app_menu(app);
    }
    Ok(())
}
