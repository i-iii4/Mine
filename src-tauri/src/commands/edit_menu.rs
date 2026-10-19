//! Undo, Redo and Select All of the Edit menu (SPEC_EDITING.md, Л12): which
//! page's note editor holds the focus, the command sent to it, and the items
//! enabled by its history. Thin: the rules are in `domain::edit_menu`.
//!
//! A page reports with [`report_focused_editor`] whenever its note editor
//! takes or loses the focus and whenever its history changes. A command of
//! the menu goes to the visible tab of the tab window in focus as
//! `edit-menu-command` when that page reported its editor in focus; anywhere
//! else it is the system's action, as the stock items sent.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::{AppHandle, Manager, State, Webview};

use super::space_events;
use super::state::AppState;
use crate::domain::edit_menu::{self, EditMenuCommand, EditMenuRoute, FocusedEditor};

/// The event that asks a page to carry out a command of the Edit menu in its
/// note editor; the payload is the [`EditMenuCommand`].
pub const EDIT_MENU_EVENT: &str = "edit-menu-command";

/// The id of the Edit submenu.
pub const MENU_ID_EDIT: &str = "edit-menu";

/// The pages whose note editor holds the focus, with its history, by page
/// label.
#[derive(Debug, Default)]
pub struct FocusedEditors {
    pages: Mutex<BTreeMap<String, FocusedEditor>>,
}

impl FocusedEditors {
    fn pages(&self) -> MutexGuard<'_, BTreeMap<String, FocusedEditor>> {
        self.pages.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The page `label` reported its editor in focus with this history, or
    /// none in focus.
    pub fn report(&self, label: &str, focused: Option<FocusedEditor>) {
        let mut pages = self.pages();
        match focused {
            Some(editor) => {
                pages.insert(label.to_string(), editor);
            }
            None => {
                pages.remove(label);
            }
        }
    }

    /// What the page `label` reported last.
    pub fn of(&self, label: &str) -> Option<FocusedEditor> {
        self.pages().get(label).copied()
    }

    /// The page `label` closed or started again: it holds no focus.
    pub fn forget(&self, label: &str) {
        self.pages().remove(label);
    }
}

/// The page the Edit menu acts on: the visible tab of the tab window in
/// focus. `None` when another window (the settings) or none is in focus.
fn menu_page(app: &AppHandle) -> Option<String> {
    let window = crate::tabs::focused_tab_window(app)?;
    let snapshot = app.state::<crate::tabs::TabShell>().snapshot();
    snapshot.window(&window).map(|saved| saved.active_tab.label())
}

/// What the page in use reported, with its label.
fn focused_editor(app: &AppHandle) -> Option<(String, FocusedEditor)> {
    let label = menu_page(app)?;
    let focused = app.state::<AppState>().focused_editors.of(&label)?;
    Some((label, focused))
}

/// The item of `command` was chosen or its keys pressed.
pub fn run(app: &AppHandle, command: EditMenuCommand) {
    let focused = focused_editor(app);
    match (edit_menu::route(focused.as_ref().map(|(_, editor)| *editor)), focused) {
        (EditMenuRoute::Editor, Some((label, _))) => {
            space_events::emit_to_labels(app, [label], EDIT_MENU_EVENT, command);
        }
        _ => crate::tabs::native::send_system_edit_action(app, command),
    }
}

/// Enable the three items for the page in use (Л12). Called on every report
/// and when the menu is built anew.
pub fn reflect(app: &AppHandle) {
    let focused = focused_editor(app).map(|(_, editor)| editor);
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(edit) = menu.get(MENU_ID_EDIT).and_then(|kind| kind.as_submenu().cloned()) else {
        log::warn!("native Edit menu is unavailable");
        return;
    };
    for command in EditMenuCommand::ALL {
        let Some(item) = edit.get(command.menu_id()).and_then(|kind| kind.as_menuitem().cloned()) else {
            log::warn!("native Edit menu item {} is unavailable", command.menu_id());
            continue;
        };
        if let Err(error) = item.set_enabled(edit_menu::enabled(command, focused)) {
            log::warn!("cannot enable the Edit menu item {}: {error}", command.menu_id());
        }
    }
}

/// The calling page's note editor holds the focus with this history, or
/// none of its editors does (`None`). On the main thread, so a page's
/// reports keep their order.
#[tauri::command(rename_all = "snake_case")]
pub fn report_focused_editor(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    editor: Option<FocusedEditor>,
) {
    state.focused_editors.report(webview.label(), editor);
    reflect(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    const HISTORY: FocusedEditor = FocusedEditor {
        can_undo: true,
        can_redo: false,
    };

    /// Л12: a page's report stands until it reports again, loses the focus
    /// or goes; other pages keep theirs.
    #[test]
    fn a_report_stands_until_the_page_reports_again_or_goes() {
        let editors = FocusedEditors::default();
        assert_eq!(editors.of("tab-a"), None);
        editors.report("tab-a", Some(HISTORY));
        editors.report("tab-b", Some(FocusedEditor { can_undo: false, can_redo: true }));
        assert_eq!(editors.of("tab-a"), Some(HISTORY));
        editors.report("tab-a", Some(FocusedEditor { can_undo: false, can_redo: false }));
        assert_eq!(editors.of("tab-a"), Some(FocusedEditor { can_undo: false, can_redo: false }));
        editors.report("tab-a", None);
        assert_eq!(editors.of("tab-a"), None);
        assert!(editors.of("tab-b").is_some());
        editors.forget("tab-b");
        assert_eq!(editors.of("tab-b"), None);
    }
}
