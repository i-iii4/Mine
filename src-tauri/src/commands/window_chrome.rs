//! Native window chrome commands.
//!
//! React owns the actual sidebar state. The native View menu mirrors that
//! state so its command title always describes the action that will happen.

use tauri::AppHandle;

use crate::commands::state::CommandError;

pub const MENU_ID_VIEW: &str = "view-menu";
pub const MENU_ID_TOGGLE_SIDEBAR: &str = "view-toggle-sidebar";

fn sidebar_menu_title(collapsed: bool) -> &'static str {
    if collapsed {
        "Show Sidebar"
    } else {
        "Hide Sidebar"
    }
}

#[tauri::command]
pub fn set_sidebar_menu_collapsed(app: AppHandle, collapsed: bool) -> Result<(), CommandError> {
    let menu = app
        .menu()
        .ok_or_else(|| CommandError::Internal("native application menu is unavailable".into()))?;
    let view_kind = menu
        .get(MENU_ID_VIEW)
        .ok_or_else(|| CommandError::Internal("native View menu is unavailable".into()))?;
    let view_menu = view_kind
        .as_submenu()
        .ok_or_else(|| CommandError::Internal("native View menu has an invalid type".into()))?;
    let toggle_kind = view_menu
        .get(MENU_ID_TOGGLE_SIDEBAR)
        .ok_or_else(|| CommandError::Internal("native sidebar menu item is unavailable".into()))?;
    let toggle_item = toggle_kind.as_menuitem().ok_or_else(|| {
        CommandError::Internal("native sidebar menu item has an invalid type".into())
    })?;

    toggle_item
        .set_text(sidebar_menu_title(collapsed))
        .map_err(|error| CommandError::Internal(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::sidebar_menu_title;

    #[test]
    fn sidebar_title_describes_the_next_action() {
        assert_eq!(sidebar_menu_title(false), "Hide Sidebar");
        assert_eq!(sidebar_menu_title(true), "Show Sidebar");
    }
}
