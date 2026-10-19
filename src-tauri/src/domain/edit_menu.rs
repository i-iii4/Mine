//! Undo, Redo and Select All of the Edit menu as data (SPEC_EDITING.md, Л12).
//!
//! A tab page is a child webview: wry answers `NO` to its key equivalents, so
//! ⌘Z, ⇧⌘Z and ⌘A reach the menu first, and the stock items send the system's
//! actions, whose undo knows nothing of the edits the note editor makes. Mine
//! has its own three items: a command goes to the page whose note editor
//! holds the focus, which carries it out in the editor; anywhere else it is
//! the system's action the stock item sent, so fields, the settings window
//! and the feed keep what they had.
//!
//! Pure: no menu, no window, no page. The shell finds the page in use and
//! applies the outcome.

use serde::{Deserialize, Serialize};

/// A command of the Edit menu that the note editor carries out itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EditMenuCommand {
    Undo,
    Redo,
    SelectAll,
}

impl EditMenuCommand {
    /// The three items, in the menu's order.
    pub const ALL: [Self; 3] = [Self::Undo, Self::Redo, Self::SelectAll];

    /// The id of the command's menu item.
    pub fn menu_id(self) -> &'static str {
        match self {
            Self::Undo => "edit-undo",
            Self::Redo => "edit-redo",
            Self::SelectAll => "edit-select-all",
        }
    }

    /// The command whose menu item has the id `id`.
    pub fn from_menu_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|command| command.menu_id() == id)
    }

    /// The item's title, the stock item's.
    pub fn title(self) -> &'static str {
        match self {
            Self::Undo => "Undo",
            Self::Redo => "Redo",
            Self::SelectAll => "Select All",
        }
    }

    /// The item's keys, the stock item's.
    pub fn accelerator(self) -> &'static str {
        match self {
            Self::Undo => "CmdOrCtrl+Z",
            Self::Redo => "CmdOrCtrl+Shift+Z",
            Self::SelectAll => "CmdOrCtrl+A",
        }
    }
}

/// What a page reports while its note editor holds the focus: whether its
/// history has a step to undo and a step to redo (`undoDepth`, `redoDepth`
/// of CodeMirror).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FocusedEditor {
    pub can_undo: bool,
    pub can_redo: bool,
}

/// Where a command of the Edit menu goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMenuRoute {
    /// To the page in use, whose note editor holds the focus.
    Editor,
    /// The system's action to the first responder, as the stock item sent.
    System,
}

/// Where a command goes when the page in use reported `focused` (`None`:
/// no note editor of it holds the focus, or no tab window is in focus).
pub fn route(focused: Option<FocusedEditor>) -> EditMenuRoute {
    match focused {
        Some(_) => EditMenuRoute::Editor,
        None => EditMenuRoute::System,
    }
}

/// Whether the item of `command` is enabled. In the editor Undo and Redo
/// follow its history; elsewhere every item stays enabled, as the stock
/// items are (muda builds menus without automatic enabling).
pub fn enabled(command: EditMenuCommand, focused: Option<FocusedEditor>) -> bool {
    match (command, focused) {
        (_, None) | (EditMenuCommand::SelectAll, Some(_)) => true,
        (EditMenuCommand::Undo, Some(editor)) => editor.can_undo,
        (EditMenuCommand::Redo, Some(editor)) => editor.can_redo,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY: FocusedEditor = FocusedEditor {
        can_undo: false,
        can_redo: false,
    };
    const UNDO_ONLY: FocusedEditor = FocusedEditor {
        can_undo: true,
        can_redo: false,
    };
    const REDO_ONLY: FocusedEditor = FocusedEditor {
        can_undo: false,
        can_redo: true,
    };

    /// Л12: with the note editor in focus the command goes to its page,
    /// anywhere else to the system as before.
    #[test]
    fn a_command_goes_to_the_focused_editor_and_to_the_system_elsewhere() {
        assert_eq!(route(Some(EMPTY)), EditMenuRoute::Editor);
        assert_eq!(route(Some(UNDO_ONLY)), EditMenuRoute::Editor);
        assert_eq!(route(None), EditMenuRoute::System);
    }

    /// Л12: Undo and Redo follow the editor's history; Select All always
    /// works; outside the editor every item stays enabled.
    #[test]
    fn the_items_follow_the_editors_history() {
        assert!(enabled(EditMenuCommand::Undo, Some(UNDO_ONLY)));
        assert!(!enabled(EditMenuCommand::Redo, Some(UNDO_ONLY)));
        assert!(!enabled(EditMenuCommand::Undo, Some(REDO_ONLY)));
        assert!(enabled(EditMenuCommand::Redo, Some(REDO_ONLY)));
        assert!(!enabled(EditMenuCommand::Undo, Some(EMPTY)));
        assert!(!enabled(EditMenuCommand::Redo, Some(EMPTY)));
        assert!(enabled(EditMenuCommand::SelectAll, Some(EMPTY)));
        for command in EditMenuCommand::ALL {
            assert!(enabled(command, None), "{command:?}");
        }
    }

    /// The items keep the stock items' titles and keys, and each id names
    /// its command back.
    #[test]
    fn the_items_keep_the_stock_titles_and_keys() {
        let items: Vec<_> = EditMenuCommand::ALL
            .into_iter()
            .map(|command| (command.title(), command.accelerator()))
            .collect();
        assert_eq!(
            items,
            [
                ("Undo", "CmdOrCtrl+Z"),
                ("Redo", "CmdOrCtrl+Shift+Z"),
                ("Select All", "CmdOrCtrl+A"),
            ]
        );
        for command in EditMenuCommand::ALL {
            assert_eq!(EditMenuCommand::from_menu_id(command.menu_id()), Some(command));
        }
        assert_eq!(EditMenuCommand::from_menu_id("edit-cut"), None);
    }

    /// The page hears the command as a word and reports its editor by these
    /// names (the bindings carry the same shape).
    #[test]
    fn the_command_and_the_report_cross_the_ipc_by_their_names() {
        assert_eq!(serde_json::to_string(&EditMenuCommand::SelectAll).unwrap(), "\"select_all\"");
        assert_eq!(serde_json::to_string(&EditMenuCommand::Undo).unwrap(), "\"undo\"");
        let report: FocusedEditor = serde_json::from_str(r#"{"can_undo":true,"can_redo":false}"#).unwrap();
        assert_eq!(report, UNDO_ONLY);
    }
}
