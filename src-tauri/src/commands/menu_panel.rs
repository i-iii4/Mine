// TRIAL (SPEC_MENU_WINDOW.md; DESIGN_SYSTEM.md, «Меню карточки в отдельном
// окне: проба»): the commands of the menu panel, a thin layer over
// crate::menu_panel. They run on the main thread: each one moves, shows or
// reads a window, the opening of a menu waits for no pool, and one thread is
// the one place that sets the order of what is said about a menu
// (SPEC_MENU_WINDOW.md, МО36).

use tauri::{AppHandle, Webview};

use crate::menu_panel::spec::{MenuAnswer, MenuSpec};
use crate::menu_panel::{
    self, MenuPanelCloseOutcome, MenuPanelCloseReason, MenuPanelOpenRequest, MenuPanelPageRequest, MenuPanelPaint,
    MenuPanelRefusal, MenuPanelStatus,
};

/// Make the panel unless it exists; whether it is ready. `page` is the load
/// of the page that asks.
#[tauri::command]
pub fn menu_panel_prepare(app: AppHandle, webview: Webview, page: String) -> MenuPanelStatus {
    menu_panel::prepare(&app, &webview, &page)
}

/// The Web mode: take the panel away.
#[tauri::command]
pub fn menu_panel_dispose(app: AppHandle) {
    menu_panel::dispose(&app);
}

/// The panel's page listens and has drawn its rest.
#[tauri::command]
pub fn menu_panel_ready(app: AppHandle, webview: Webview) {
    menu_panel::page_ready(&app, &webview);
}

/// A page opens its menu in the panel.
#[tauri::command]
pub fn menu_panel_open(app: AppHandle, webview: Webview, request: MenuPanelOpenRequest) -> Result<(), MenuPanelRefusal> {
    menu_panel::open(&app, &webview, request)
}

/// A page sends what changed in its open menu: the whole menu again, its
/// change number `number`.
#[tauri::command]
pub fn menu_panel_update(app: AppHandle, webview: Webview, menu: u32, number: u32, spec: MenuSpec) {
    menu_panel::update(&app, &webview, menu, number, spec);
}

/// A page answers the panel's request `request` of its open menu.
#[tauri::command]
pub fn menu_panel_answer(app: AppHandle, webview: Webview, menu: u32, request: u32, answer: MenuAnswer) {
    menu_panel::answer(&app, &webview, menu, request, answer);
}

/// A tab closes its menu `menu`; what the closing came to.
#[tauri::command]
pub fn menu_panel_close(app: AppHandle, webview: Webview, page: String, menu: u32, reason: MenuPanelCloseReason) -> MenuPanelCloseOutcome {
    menu_panel::close_from_source(&app, &webview, &page, menu, reason)
}

/// The panel's page asks for a choice to be carried out, for its menu to
/// close, or both.
#[tauri::command]
pub fn menu_panel_request(app: AppHandle, webview: Webview, request: MenuPanelPageRequest) {
    menu_panel::page_request(&app, &webview, &request);
}

/// The panel drew the menu: one line of the measurement in the app's log.
#[tauri::command]
pub fn menu_panel_painted(app: AppHandle, paint: MenuPanelPaint) {
    menu_panel::painted(&app, &paint);
}
