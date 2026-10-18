// What each command does to a space, and the news the other tabs of that
// space get (SPEC_TABS.md, В15 по В17).
//
// The watcher drops the paths Mine writes itself, and a tab learns of its own
// change from the command's answer. Every other tab of the same space would
// keep showing the old state, so each command that changes the sources of a
// space tells them through `vault-changed`, as if the change came from
// outside. The list below names every registered command once; a test holds
// it to the handler list and to the commands' bodies.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};

use super::space_events;
use super::spaces::TabRegistry;
use super::state::{AppState, OpenSpace};

/// What a command does to the space it acts on. The list is held to the
/// handler list and to the commands' bodies by the tests below.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Reads, or acts outside any space (settings, updates, the window).
    Reads,
    /// Changes derived state or a notice and sends its own event to the
    /// space's tabs (thumbnails, article audio, write layout).
    AnnouncesItself,
    /// Changes the sources of a space: the other tabs of the space hear of
    /// it through `vault-changed` (В15).
    ChangesSources,
}

/// Every registered command and its effect (В16).
#[cfg(test)]
pub const COMMAND_EFFECTS: &[(&str, Effect)] = &[
    ("get_article_audio_state", Effect::Reads),
    ("generate_article_audio", Effect::AnnouncesItself),
    ("delete_article_audio", Effect::AnnouncesItself),
    ("set_article_audio_position", Effect::Reads),
    ("select_vault", Effect::Reads),
    ("open_vault", Effect::Reads),
    ("selection_generation", Effect::Reads),
    ("get_vault_path", Effect::Reads),
    ("list_known_vaults", Effect::Reads),
    ("list_spaces", Effect::Reads),
    ("start_vault_sync", Effect::Reads),
    ("record_startup_milestone", Effect::Reads),
    ("start_startup_maintenance", Effect::Reads),
    ("sweep_vault_thumbnails", Effect::AnnouncesItself),
    ("get_update_status", Effect::Reads),
    ("check_for_updates", Effect::Reads),
    ("download_update", Effect::Reads),
    ("install_update", Effect::Reads),
    ("restore_previous_update", Effect::Reads),
    ("icloud_download_progress", Effect::Reads),
    ("cloud_recommendation_state", Effect::Reads),
    ("dismiss_cloud_recommendation", Effect::Reads),
    ("first_card_marker_pending", Effect::Reads),
    ("complete_first_card_marker", Effect::Reads),
    ("space_onboarding_pending", Effect::Reads),
    ("clipper_extension_folder", Effect::Reads),
    ("get_unavailable_vault", Effect::Reads),
    ("forget_unavailable_vault", Effect::Reads),
    ("get_vault_write_layout", Effect::Reads),
    ("set_vault_write_layout", Effect::AnnouncesItself),
    ("list_grid_blocks", Effect::Reads),
    ("get_grid_rows", Effect::Reads),
    ("list_graph_snapshot", Effect::Reads),
    ("get_block", Effect::Reads),
    ("list_card_associations", Effect::Reads),
    ("resolve_note_link", Effect::Reads),
    ("create_block", Effect::ChangesSources),
    ("create_media_asset_card", Effect::ChangesSources),
    ("rename_media_asset", Effect::ChangesSources),
    ("prepare_delete_media_asset", Effect::Reads),
    ("delete_media_asset", Effect::ChangesSources),
    ("remove_media_asset_from_card", Effect::ChangesSources),
    ("delete_source_video", Effect::ChangesSources),
    ("copy_media_asset_to_clipboard", Effect::Reads),
    ("read_clipboard_payload", Effect::Reads),
    ("list_shortcut_overrides", Effect::Reads),
    ("save_shortcut_overrides", Effect::Reads),
    ("set_shortcut_capture_active", Effect::Reads),
    ("extract_text_selection", Effect::ChangesSources),
    ("delete_text_selection", Effect::ChangesSources),
    ("toggle_task_item", Effect::ChangesSources),
    ("begin_note_edit", Effect::Reads),
    ("save_note_body", Effect::ChangesSources),
    ("note_body_state", Effect::Reads),
    // Edit sessions change no space: they are the pages' state in memory
    // (SPEC_EDITING.md, Л3.9).
    ("report_note_edits", Effect::Reads),
    ("end_note_edit", Effect::Reads),
    ("report_edits_flushed", Effect::Reads),
    ("rename_block_file", Effect::ChangesSources),
    ("check_block_rename", Effect::Reads),
    ("prepare_delete_block", Effect::Reads),
    ("prepare_delete_blocks", Effect::Reads),
    ("delete_block", Effect::ChangesSources),
    ("delete_blocks", Effect::ChangesSources),
    ("merge_blocks", Effect::ChangesSources),
    ("add_tag", Effect::ChangesSources),
    ("remove_tag", Effect::ChangesSources),
    ("set_blocks_membership", Effect::ChangesSources),
    ("search_grid_blocks", Effect::Reads),
    ("list_taxonomy_snapshot", Effect::Reads),
    ("create_channel", Effect::ChangesSources),
    ("reorder_channels", Effect::ChangesSources),
    ("rename_channel", Effect::ChangesSources),
    ("check_collection_name", Effect::Reads),
    ("collection_page_path", Effect::Reads),
    ("delete_channel", Effect::ChangesSources),
    ("list_channel_previews", Effect::Reads),
    ("list_arena_channels", Effect::Reads),
    ("import_arena_channels", Effect::ChangesSources),
    ("save_thumb", Effect::AnnouncesItself),
    ("save_tile_poster", Effect::AnnouncesItself),
    ("list_pending_thumb_upgrades", Effect::Reads),
    ("list_vault_conflict_paths", Effect::Reads),
    ("list_vault_conflicts", Effect::AnnouncesItself),
    ("resolve_vault_conflict", Effect::ChangesSources),
    ("open_settings_window", Effect::Reads),
    ("add_known_vault", Effect::Reads),
    ("forget_known_vault", Effect::Reads),
    ("reorder_known_vaults", Effect::Reads),
    ("space_stats", Effect::Reads),
    ("list_orphan_media", Effect::Reads),
    ("promote_orphan_media", Effect::ChangesSources),
    ("delete_orphan_media", Effect::ChangesSources),
    ("report_native_shell_smoke", Effect::Reads),
    ("youtube_player_url", Effect::Reads),
    ("start_source_video_download", Effect::Reads),
    ("cancel_source_video_download", Effect::Reads),
    ("source_video_download_status", Effect::Reads),
    // Windows and tabs change no space (SPEC_TABS.md, «Команды»).
    ("get_tab_bootstrap", Effect::Reads),
    ("get_tabbar_bootstrap", Effect::Reads),
    ("report_tab_view", Effect::Reads),
    ("tab_painted", Effect::Reads),
    ("report_tab_history", Effect::Reads),
    ("open_place", Effect::Reads),
    ("set_chrome_rows", Effect::Reads),
    ("step_tab_history", Effect::Reads),
    ("open_tab_search", Effect::Reads),
    ("activate_tab", Effect::Reads),
    ("activate_adjacent_tab", Effect::Reads),
    ("new_tab", Effect::Reads),
    ("close_tab", Effect::Reads),
    ("close_other_tabs", Effect::Reads),
    ("move_tab", Effect::Reads),
    ("set_window_sidebar", Effect::Reads),
    ("toggle_window_sidebar", Effect::Reads),
    ("report_sidebar_overlay", Effect::Reads),
    ("start_window_drag", Effect::Reads),
    ("report_window_surface", Effect::Reads),
    ("show_space", Effect::Reads),
    ("spaces_in_tabs", Effect::Reads),
    ("move_tab_to_new_window", Effect::Reads),
    ("begin_tab_drag", Effect::Reads),
    ("report_drop_slot", Effect::Reads),
];

/// The commands that run on the main thread, each with why it may: none of
/// them reads or writes the files of a space, opens an index or waits for a
/// space's lock. Every other registered command runs off the main thread,
/// where such a wait freezes no window (SPEC_INTEGRATION.md, «Команды вне
/// главного потока»). The tests below hold every registered command to this
/// list.
#[cfg(test)]
pub const MAIN_THREAD_COMMANDS: &[(&str, &str)] = &[
    ("selection_generation", "a counter in memory"),
    ("record_startup_milestone", "one line of the launch trace in the app's data"),
    ("start_startup_maintenance", "restores the saved windows; its work runs on its own thread"),
    ("clipper_extension_folder", "a path in the app's data"),
    ("forget_unavailable_vault", "the app's settings and the tabs"),
    ("read_clipboard_payload", "the system pasteboard"),
    ("list_shortcut_overrides", "the app's settings"),
    ("save_shortcut_overrides", "the app's settings and the app menu"),
    ("set_shortcut_capture_active", "the app menu"),
    ("open_settings_window", "creates a window"),
    ("forget_known_vault", "the app's settings and the tabs"),
    ("reorder_known_vaults", "the app's settings"),
    ("report_native_shell_smoke", "a diagnostics report outside any space"),
    ("youtube_player_url", "an address of the app's local player page"),
    // A page's reports keep the order it sent them in (SPEC_EDITING.md,
    // Л3.9): the pool would run two of them in any order.
    ("report_note_edits", "edit sessions in memory"),
    ("end_note_edit", "edit sessions and waiting previews in memory"),
    ("report_edits_flushed", "edit sessions in memory"),
    // Windows and tabs: the pages and their layers are made and ordered on
    // the main thread (SPEC_TABS.md, «Команды»).
    ("get_tab_bootstrap", "tabs in memory"),
    ("get_tabbar_bootstrap", "tabs in memory"),
    ("report_tab_view", "tabs in memory"),
    ("tab_painted", "tabs in memory"),
    ("report_tab_history", "tabs in memory"),
    ("open_place", "opens a tab or a window"),
    ("set_chrome_rows", "the window's layout"),
    ("step_tab_history", "tabs in memory"),
    ("open_tab_search", "tabs in memory"),
    ("activate_tab", "shows a tab's page"),
    ("activate_adjacent_tab", "shows a tab's page"),
    ("new_tab", "opens a tab"),
    ("close_tab", "closes a tab"),
    ("close_other_tabs", "closes tabs"),
    ("move_tab", "orders the tabs"),
    ("set_window_sidebar", "tabs in memory"),
    ("toggle_window_sidebar", "tabs in memory, or an event to the tab"),
    ("report_sidebar_overlay", "tabs in memory"),
    ("start_window_drag", "drags the window"),
    ("report_window_surface", "paints the windows"),
    ("show_space", "shows a tab or opens one"),
    ("spaces_in_tabs", "tabs in memory"),
    ("move_tab_to_new_window", "opens a window"),
    ("begin_tab_drag", "follows the pointer with the window"),
    ("report_drop_slot", "tabs in memory"),
];

/// What was renamed by a change, so a tab showing the old name follows it
/// (В17, В18).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RenamedKind {
    Collection,
    Card,
}

/// One rename made by a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct SpaceRename {
    pub kind: RenamedKind,
    pub from: String,
    pub to: String,
}

impl SpaceRename {
    /// A collection renamed from `from` to `to`.
    pub fn collection(from: &str, to: &str) -> Self {
        Self {
            kind: RenamedKind::Collection,
            from: from.to_string(),
            to: to.to_string(),
        }
    }

    /// A card renamed from the slug `from` to the slug `to`.
    pub fn card(from: &str, to: &str) -> Self {
        Self {
            kind: RenamedKind::Card,
            from: from.to_string(),
            to: to.to_string(),
        }
    }
}

/// `vault-changed`: the sources of the space at `path` changed. `renames`
/// lists what a command renamed; the watcher's news carries none.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct VaultChangedPayload {
    pub path: String,
    pub renames: Vec<SpaceRename>,
}

impl VaultChangedPayload {
    /// News of an outside change to the space at `path`.
    pub fn from_outside(path: String) -> Self {
        Self {
            path,
            renames: Vec::new(),
        }
    }
}

/// The news of a change a tab's command makes, addressed when the command
/// begins: to the other tabs of the space the tab showed then (В15). Until
/// 13.10.2026 the space was looked up after the command, and a tab that
/// switched space meanwhile sent the news of a deletion to the space it
/// showed by then, while the tabs of the changed space heard nothing
/// (SPEC_DEEP_AUDIT.md, Е2.12).
pub struct ChangeNews {
    app: AppHandle,
    caller: String,
    space: Option<Arc<OpenSpace>>,
}

impl ChangeNews {
    /// Note the space the tab `webview` shows, before its command runs.
    pub fn before(webview: &Webview) -> Self {
        let app = webview.app_handle().clone();
        let space = app.state::<AppState>().space_for(webview.label());
        Self {
            app,
            caller: webview.label().to_string(),
            space,
        }
    }

    /// The command changed the sources: tell the other tabs of the space it
    /// changed. The calling tab knows from the command's answer.
    pub fn send(&self, renames: Vec<SpaceRename>) {
        let Some(space) = &self.space else {
            return;
        };
        let others = news_recipients(&self.app.state::<AppState>().tabs, space.vault_id(), &self.caller);
        announce(&self.app, space, others, renames);
    }
}

/// Who hears of a change a tab's command made to the space `vault_id`: every
/// other tab of that space, whatever the calling tab shows now.
pub fn news_recipients(tabs: &TabRegistry, vault_id: &str, caller: &str) -> Vec<String> {
    tabs.labels_of(vault_id)
        .into_iter()
        .filter(|label| label != caller)
        .collect()
}

/// A window that is not a tab changed the sources of `space`: tell every tab
/// of that space.
pub fn space_changed_in(app: &AppHandle, space: &OpenSpace) {
    let tabs = app.state::<AppState>().tabs.labels_of(space.vault_id());
    announce(app, space, tabs, Vec::new());
}

fn announce(app: &AppHandle, space: &OpenSpace, labels: Vec<String>, renames: Vec<SpaceRename>) {
    let Some(root) = space.root() else {
        return;
    };
    space_events::emit_to_labels(
        app,
        labels,
        "vault-changed",
        VaultChangedPayload {
            path: root.to_string_lossy().into_owned(),
            renames,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{news_recipients, Effect, COMMAND_EFFECTS, MAIN_THREAD_COMMANDS};
    use crate::commands::spaces::{SelectionStamp, SpaceHost, TabRegistry};
    use std::collections::BTreeSet;
    use std::path::Path;

    /// Е2.12: the news of a change goes to the other tabs of the space the
    /// command changed, even when the calling tab shows another one by the
    /// time the command answers.
    #[test]
    fn the_news_of_a_change_goes_to_the_space_that_changed() {
        let host = SpaceHost::with_grace(std::time::Duration::from_millis(20));
        let tabs = TabRegistry::default();
        let bind = |label: &str, sequence: u64, space: &str| {
            let stamp = SelectionStamp { generation: 1, sequence };
            let stamp = tabs.begin_selection(label, stamp).unwrap();
            tabs.bind(label, stamp, host.lease(space)).unwrap();
        };
        bind("tab-a", 1, "space-x");
        bind("tab-b", 1, "space-x");
        bind("tab-c", 1, "space-y");
        // The command of tab-a began on space X...
        let changed = tabs.space_of("tab-a").unwrap();
        // ...and tab-a switched to space Y before it answered.
        bind("tab-a", 2, "space-y");
        assert_eq!(news_recipients(&tabs, changed.vault_id(), "tab-a"), vec!["tab-b".to_string()]);
        // Looked up after the command, as before 13.10.2026, the news went
        // to the space the tab shows now.
        let now = tabs.space_of("tab-a").unwrap();
        assert_eq!(news_recipients(&tabs, now.vault_id(), "tab-a"), vec!["tab-c".to_string()]);
    }

    fn source(relative: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    /// The text of every command module.
    fn command_modules() -> Vec<String> {
        std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands"))
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect()
    }

    /// Whether the command `name` runs off the main thread: an `async fn`,
    /// or `async` among the arguments of its `#[tauri::command]`. `None` when
    /// no module declares it.
    fn runs_off_main_thread(modules: &[String], name: &str) -> Option<bool> {
        modules.iter().find_map(|text| {
            if text.contains(&format!("pub async fn {name}(")) {
                return Some(true);
            }
            let start = text.find(&format!("pub fn {name}("))?;
            let attribute_start = text[..start].rfind("#[tauri::command")?;
            let attribute = &text[attribute_start..start];
            let attribute = &attribute[..attribute.find(']').unwrap_or(attribute.len())];
            let arguments = attribute
                .split_once('(')
                .map_or("", |(_, arguments)| arguments.trim_end_matches(')'));
            Some(arguments.split(',').any(|argument| argument.trim() == "async"))
        })
    }

    /// A command waits for the files of a space, its index or its lock, and
    /// background work may hold them for seconds; on the main thread every
    /// window freezes meanwhile (13.10.2026: Delete of a media file stood
    /// about 30 s with the spinning cursor in a space of 700 cards in
    /// iCloud). So every command runs off the main thread but those
    /// `MAIN_THREAD_COMMANDS` names with the reason it may.
    #[test]
    fn no_command_runs_on_the_main_thread_unless_listed() {
        let modules = command_modules();
        let listed: BTreeSet<&str> = MAIN_THREAD_COMMANDS.iter().map(|(name, _)| *name).collect();
        assert_eq!(listed.len(), MAIN_THREAD_COMMANDS.len(), "a command is listed twice");
        let mut unlisted = Vec::new();
        let mut stale = Vec::new();
        for (name, _) in COMMAND_EFFECTS {
            let off_main_thread = runs_off_main_thread(&modules, name)
                .unwrap_or_else(|| panic!("{name} not found"));
            match (listed.contains(name), off_main_thread) {
                (false, false) => unlisted.push(*name),
                (true, true) => stale.push(*name),
                _ => {}
            }
        }
        assert!(
            unlisted.is_empty(),
            "on the main thread: declare them `async`, or list them in MAIN_THREAD_COMMANDS with the reason they may: {unlisted:?}"
        );
        assert!(
            stale.is_empty(),
            "off the main thread: take them off MAIN_THREAD_COMMANDS: {stale:?}"
        );
        let registered: BTreeSet<&str> = COMMAND_EFFECTS.iter().map(|(name, _)| *name).collect();
        for name in &listed {
            assert!(registered.contains(name), "{name} is listed but not registered");
        }
    }

    /// The guard above reads the declarations right: a plain command is on
    /// the main thread, `async` in the attribute or the signature is off it.
    #[test]
    fn main_thread_guard_reads_the_declaration() {
        let modules = vec![[
            "#[tauri::command]\npub fn plain(a: u8) {}\n",
            "#[tauri::command(rename_all = \"snake_case\")]\npub fn renamed(a: u8) {}\n",
            "#[tauri::command(async, rename_all = \"snake_case\")]\npub fn pooled(a: u8) {}\n",
            "#[tauri::command(rename_all = \"snake_case\", async)]\npub fn pooled_late(a: u8) {}\n",
            "#[tauri::command]\npub async fn awaited(a: u8) {}\n",
        ]
        .concat()];
        assert_eq!(runs_off_main_thread(&modules, "plain"), Some(false));
        assert_eq!(runs_off_main_thread(&modules, "renamed"), Some(false));
        assert_eq!(runs_off_main_thread(&modules, "pooled"), Some(true));
        assert_eq!(runs_off_main_thread(&modules, "pooled_late"), Some(true));
        assert_eq!(runs_off_main_thread(&modules, "awaited"), Some(true));
        assert_eq!(runs_off_main_thread(&modules, "missing"), None);
    }

    /// The commands the app registers, by their last path segment.
    fn registered() -> BTreeSet<String> {
        let lib = source("src/lib.rs");
        let start = lib.find("generate_handler![").expect("a handler list");
        let block = &lib[start..lib[start..].find("])").map(|end| start + end).unwrap()];
        block
            .lines()
            .map(str::trim)
            .filter(|line| line.ends_with(',') && line.contains("::"))
            .map(|line| line.trim_end_matches(',').rsplit("::").next().unwrap().to_string())
            .collect()
    }

    #[test]
    fn every_registered_command_has_one_effect() {
        let listed: Vec<&str> = COMMAND_EFFECTS.iter().map(|(name, _)| *name).collect();
        let unique: BTreeSet<&str> = listed.iter().copied().collect();
        assert_eq!(unique.len(), listed.len(), "a command is listed twice");
        let listed: BTreeSet<String> = unique.into_iter().map(str::to_string).collect();
        assert_eq!(listed, registered());
    }

    #[test]
    fn every_command_that_changes_sources_tells_the_other_tabs() {
        let modules = command_modules();
        for (name, effect) in COMMAND_EFFECTS {
            if *effect != Effect::ChangesSources {
                continue;
            }
            let body = modules
                .iter()
                .find_map(|text| {
                    let start = text
                        .find(&format!("pub fn {name}("))
                        .or_else(|| text.find(&format!("pub async fn {name}(")))?;
                    let end = text[start..].find("\n}\n").map_or(text.len(), |end| start + end);
                    Some(text[start..end].to_string())
                })
                .unwrap_or_else(|| panic!("{name} not found"));
            assert!(
                body.contains("ChangeNews::before") || body.contains("space_changed_in"),
                "{name} changes sources but tells no other tab"
            );
        }
    }

    /// A command that writes waits for the space's lock and the index, which
    /// background work may hold for seconds. A synchronous Tauri command runs
    /// on the main thread and freezes every window meanwhile, so every
    /// command that writes runs off it: an `async fn`, or `async` in its
    /// attribute (SPEC_INTEGRATION.md, «Команды вне главного потока»), and
    /// none may be listed in `MAIN_THREAD_COMMANDS`.
    #[test]
    fn no_command_that_writes_runs_on_the_main_thread() {
        let modules = command_modules();
        for (name, effect) in COMMAND_EFFECTS {
            if *effect == Effect::Reads {
                continue;
            }
            assert_eq!(
                runs_off_main_thread(&modules, name),
                Some(true),
                "{name} writes but runs on the main thread"
            );
            assert!(
                !MAIN_THREAD_COMMANDS.iter().any(|(listed, _)| listed == name),
                "{name} writes: it may not be listed for the main thread"
            );
        }
    }
}
