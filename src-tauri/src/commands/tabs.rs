//! Commands of tab pages, tab bars and the settings window about windows and
//! tabs (SPEC_TABS.md, «Команды»). Thin: the work is in `crate::tabs`.

use tauri::{AppHandle, Manager, Webview};

use super::state::CommandError;
use crate::domain::windows::{SidebarLayout, TabId, TabSpace, TabView};
use crate::tabs::{self, TabBarState, TabBootstrap};

/// What the calling tab page needs to start.
#[tauri::command]
pub fn get_tab_bootstrap(app: AppHandle, webview: Webview) -> Option<TabBootstrap> {
    tabs::bootstrap(&app, webview.label())
}

/// What the calling tab bar shows.
#[tauri::command]
pub fn get_tabbar_bootstrap(app: AppHandle, webview: Webview) -> Option<TabBarState> {
    let window = tabs::window_of_label(&app, webview.label())?;
    log::info!("tab bar started: {}", webview.label());
    tabs::bar_state(&app, &window)
}

/// The calling tab's memory (В31).
#[tauri::command]
pub fn report_tab_view(app: AppHandle, webview: Webview, view: TabView) {
    tabs::report_view(&app, webview.label(), view);
}

/// Where the calling tab can step through its places (В81).
#[tauri::command]
pub fn report_tab_history(app: AppHandle, webview: Webview, back: bool, forward: bool) {
    tabs::report_history(&app, webview.label(), tabs::TabHistory { back, forward });
}

/// The calling tab bar's back or forward button: its window's visible tab
/// steps through its places (В81).
#[tauri::command]
pub fn step_tab_history(app: AppHandle, webview: Webview, forward: bool) {
    tabs::step_history(&app, webview.label(), forward);
}

/// The calling tab drew its first frame since it was shown (В5).
#[tauri::command]
pub fn tab_painted(app: AppHandle, webview: Webview) {
    tabs::page_painted(&app, webview.label());
}

/// Show `tab_id` in its window.
#[tauri::command]
pub fn activate_tab(app: AppHandle, tab_id: TabId) {
    tabs::activate(&app, &tab_id);
}

/// Show the tab after (`forward`) or before the visible one of the calling
/// page's window, round the end (В55).
#[tauri::command]
pub fn activate_adjacent_tab(app: AppHandle, webview: Webview, forward: bool) {
    let Some(window) = tabs::window_of_label(&app, webview.label()) else {
        return;
    };
    let snapshot = app.state::<tabs::TabShell>().snapshot();
    let Some(visible) = snapshot.window(&window).map(|saved| saved.active_tab.clone()) else {
        return;
    };
    if let Some(next) = snapshot.adjacent(&visible, forward) {
        tabs::activate(&app, &next);
    }
}

/// Open a new tab in the calling page's window (В51): the space `vault_id`,
/// else the space of the window's visible tab.
#[tauri::command]
pub fn new_tab(app: AppHandle, webview: Webview, vault_id: Option<String>) -> Result<(), CommandError> {
    let window = tabs::window_of_label(&app, webview.label()).ok_or(CommandError::NoVault)?;
    let space = match vault_id {
        Some(vault_id) => TabSpace::Space { vault_id },
        None => {
            let snapshot = app.state::<tabs::TabShell>().snapshot();
            snapshot
                .window(&window)
                .and_then(|saved| snapshot.tab(&saved.active_tab))
                .map_or(TabSpace::Picker, |tab| tab.space.clone())
        }
    };
    tabs::new_tab(&app, &window, space);
    Ok(())
}

/// Close `tab_id` (В53).
#[tauri::command]
pub fn close_tab(app: AppHandle, tab_id: TabId) {
    tabs::close_tab(&app, &tab_id);
}

/// Close every tab of `tab_id`'s window but it (В50).
#[tauri::command]
pub fn close_other_tabs(app: AppHandle, tab_id: TabId) {
    tabs::close_other_tabs(&app, &tab_id);
}

/// Move `tab_id` to `index` within its window (В60).
#[tauri::command]
pub fn move_tab(app: AppHandle, tab_id: TabId, index: usize) {
    tabs::move_tab(&app, &tab_id, index);
}

/// Store and spread the sidebar of the calling page's window (В56).
#[tauri::command]
pub fn set_window_sidebar(app: AppHandle, webview: Webview, sidebar: SidebarLayout) {
    if let Some(window) = tabs::window_of_label(&app, webview.label()) {
        tabs::set_sidebar(&app, &window, sidebar);
    }
}

/// Start dragging the calling page's window by its chrome (В23).
#[tauri::command]
pub fn start_window_drag(app: AppHandle, webview: Webview) -> Result<(), CommandError> {
    let window = tabs::window_of_label(&app, webview.label())
        .and_then(|window| app.get_window(&window.label()))
        .ok_or(CommandError::NoVault)?;
    window
        .start_dragging()
        .map_err(|error| CommandError::Internal(format!("cannot drag the window: {error}")))
}

/// The chrome colour, `#rrggbb`, computed from the calling page's CSS (В25).
#[tauri::command]
pub fn report_window_surface(app: AppHandle, color: String) {
    tabs::set_window_surface(&app, color);
}

/// Show the space at `path` (В69): the tab of that space used last, or a new
/// tab in the last window. `go_everything` returns that tab to Everything,
/// as an opening from outside does (В72).
#[tauri::command]
pub fn show_space(app: AppHandle, path: String, go_everything: bool) {
    if go_everything {
        tabs::open_space_from_outside(&app, std::path::Path::new(&path));
    } else {
        tabs::show_space(&app, std::path::Path::new(&path));
    }
}

/// The identities of every space some tab shows (В69).
#[tauri::command]
pub fn spaces_in_tabs(app: AppHandle) -> Vec<String> {
    tabs::spaces_in_tabs(&app)
}

/// A notice of the calling tab's space was closed in this opening (В20).
#[tauri::command]
pub fn dismiss_space_notice(app: AppHandle, webview: Webview, notice: String) {
    let state = app.state::<super::state::AppState>();
    if let Some(space) = state.space_for(webview.label()) {
        space.dismiss_notice(&notice);
    }
}

/// Whether a notice of the calling tab's space was closed in this opening.
#[tauri::command]
pub fn space_notice_dismissed(app: AppHandle, webview: Webview, notice: String) -> bool {
    let state = app.state::<super::state::AppState>();
    state
        .space_for(webview.label())
        .is_some_and(|space| space.notice_dismissed(&notice))
}

/// Move `tab_id` into a window of its own (В50, В65).
#[tauri::command]
pub fn move_tab_to_new_window(app: AppHandle, tab_id: TabId) {
    tabs::move_tab_to_new_window(&app, &tab_id);
}

/// The calling tab bar saw `tab_id` pulled off at `grab_x`, `grab_y` (its own
/// logical points): the backend follows the pointer from here (В61 по В64).
#[tauri::command]
pub fn begin_tab_drag(app: AppHandle, tab_id: TabId, grab_x: f64, grab_y: f64) {
    tabs::drag::begin(&app, &tab_id, (grab_x, grab_y));
}

/// The calling tab bar reports the slot under a dragged tab, or none (В63).
#[tauri::command]
pub fn report_drop_slot(app: AppHandle, webview: Webview, index: Option<usize>) {
    if let Some(window) = tabs::window_of_label(&app, webview.label()) {
        tabs::drag::report_drop_slot(&window, index);
    }
}
