// What each command does to a space, and the news the other tabs of that
// space get (SPEC_TABS.md, В15 по В17).
//
// The watcher drops the paths Mine writes itself, and a tab learns of its own
// change from the command's answer. Every other tab of the same space would
// keep showing the old state, so each command that changes the sources of a
// space tells them through `vault-changed`, as if the change came from
// outside. The list below names every registered command once; a test holds
// it to the handler list and to the commands' bodies.

use serde::Serialize;
use tauri::{AppHandle, Manager, Webview};

use super::space_events;
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
    ("rebuild_index", Effect::ChangesSources),
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
    ("organize_vault_layout", Effect::AnnouncesItself),
    ("get_vault_stats", Effect::Reads),
    ("list_blocks", Effect::Reads),
    ("list_grid_blocks", Effect::Reads),
    ("get_grid_rows", Effect::Reads),
    ("list_graph_snapshot", Effect::Reads),
    ("get_block", Effect::Reads),
    ("resolve_note_link", Effect::Reads),
    ("create_block", Effect::ChangesSources),
    ("extract_inline_media", Effect::ChangesSources),
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
    ("rename_block_file", Effect::ChangesSources),
    ("prepare_delete_block", Effect::Reads),
    ("delete_block", Effect::ChangesSources),
    ("delete_blocks", Effect::ChangesSources),
    ("merge_blocks", Effect::ChangesSources),
    ("list_tags", Effect::Reads),
    ("add_tag", Effect::ChangesSources),
    ("remove_tag", Effect::ChangesSources),
    ("rename_tag", Effect::ChangesSources),
    ("delete_tag_from_all", Effect::ChangesSources),
    ("search", Effect::Reads),
    ("search_grid_blocks", Effect::Reads),
    ("list_channels", Effect::Reads),
    ("list_taxonomy_snapshot", Effect::Reads),
    ("create_channel", Effect::ChangesSources),
    ("reorder_channels", Effect::ChangesSources),
    ("rename_channel", Effect::ChangesSources),
    ("delete_channel", Effect::ChangesSources),
    ("list_channel_previews", Effect::Reads),
    ("list_arena_channels", Effect::Reads),
    ("import_arena_channels", Effect::ChangesSources),
    ("save_thumb", Effect::AnnouncesItself),
    ("save_tile_poster", Effect::AnnouncesItself),
    ("list_pending_thumb_upgrades", Effect::Reads),
    ("list_vault_conflicts", Effect::Reads),
    ("resolve_vault_conflict", Effect::ChangesSources),
    ("open_settings_window", Effect::Reads),
    ("add_known_vault", Effect::Reads),
    ("forget_known_vault", Effect::Reads),
    ("reorder_known_vaults", Effect::Reads),
    ("space_stats", Effect::Reads),
    ("list_orphan_media", Effect::Reads),
    ("promote_orphan_media", Effect::ChangesSources),
    ("delete_orphan_media", Effect::ChangesSources),
    ("set_sidebar_menu_collapsed", Effect::Reads),
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
    ("activate_tab", Effect::Reads),
    ("activate_adjacent_tab", Effect::Reads),
    ("new_tab", Effect::Reads),
    ("close_tab", Effect::Reads),
    ("close_other_tabs", Effect::Reads),
    ("move_tab", Effect::Reads),
    ("set_window_sidebar", Effect::Reads),
    ("start_window_drag", Effect::Reads),
    ("report_window_surface", Effect::Reads),
    ("show_space", Effect::Reads),
    ("spaces_in_tabs", Effect::Reads),
    ("dismiss_space_notice", Effect::Reads),
    ("space_notice_dismissed", Effect::Reads),
    ("move_tab_to_new_window", Effect::Reads),
    ("begin_tab_drag", Effect::Reads),
    ("report_drop_slot", Effect::Reads),
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

/// The tab `webview` changed the sources of its space: tell the other tabs
/// of that space (В15). The calling tab knows from the command's answer.
pub fn space_changed_by_tab(webview: &Webview, renames: Vec<SpaceRename>) {
    let app = webview.app_handle();
    let state = app.state::<AppState>();
    let Some(space) = state.space_for(webview.label()) else {
        return;
    };
    let others: Vec<String> = state
        .tabs
        .labels_of(space.vault_id())
        .into_iter()
        .filter(|label| label != webview.label())
        .collect();
    announce(app, &space, others, renames);
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
    use super::{Effect, COMMAND_EFFECTS};
    use std::collections::BTreeSet;
    use std::path::Path;

    fn source(relative: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
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
        let modules: Vec<String> = std::fs::read_dir(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands"),
        )
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect();
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
                body.contains("space_changed_by_tab") || body.contains("space_changed_in"),
                "{name} changes sources but tells no other tab"
            );
        }
    }

    /// A command that writes waits for the space's lock and the index, which
    /// background work may hold for seconds. A synchronous Tauri command runs
    /// on the main thread and freezes every window meanwhile, so every
    /// command that writes runs off it: an `async fn`, or `async` in its
    /// attribute (SPEC_INTEGRATION.md, «Команды записи вне главного потока»).
    #[test]
    fn no_command_that_writes_runs_on_the_main_thread() {
        let modules: Vec<String> = std::fs::read_dir(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands"),
        )
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect();
        for (name, effect) in COMMAND_EFFECTS {
            if *effect == Effect::Reads {
                continue;
            }
            let off_main_thread = modules.iter().any(|text| {
                if text.contains(&format!("pub async fn {name}(")) {
                    return true;
                }
                let Some(start) = text.find(&format!("pub fn {name}(")) else {
                    return false;
                };
                let attribute = text[..start].rfind("#[tauri::command").map(|at| &text[at..start]);
                attribute.is_some_and(|attribute| attribute.starts_with("#[tauri::command(async"))
            });
            assert!(off_main_thread, "{name} writes but runs on the main thread");
        }
    }
}
