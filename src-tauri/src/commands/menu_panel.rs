// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): the
// commands of the menu panel, a thin layer over crate::menu_panel. They run
// on the main thread: each one moves, shows or reads a window, and the
// opening of a menu waits for none of them longer than a frame.

use tauri::{AppHandle, Webview};

use crate::menu_panel::{
    self, MenuPanelCloseReason, MenuPanelOpenRequest, MenuPanelPaint, MenuPanelRefusal, MenuPanelSize,
    MenuPanelStatus, MenuPanelTicket, ScreenPoint,
};

/// Make the panel unless it exists; whether its page is ready.
#[tauri::command]
pub fn menu_panel_prepare(app: AppHandle, size: MenuPanelSize) -> MenuPanelStatus {
    menu_panel::prepare(&app, size)
}

/// The panel's page listens.
#[tauri::command]
pub fn menu_panel_ready(app: AppHandle, webview: Webview) {
    menu_panel::page_ready(&app, &webview);
}

/// A tab opens its card menu in the panel.
#[tauri::command]
pub fn menu_panel_open(app: AppHandle, webview: Webview, request: MenuPanelOpenRequest) -> Result<MenuPanelTicket, MenuPanelRefusal> {
    menu_panel::open(&app, &webview, request)
}

/// The panel's page laid the menu out: the panel shows at `origin`.
#[tauri::command]
pub fn menu_panel_show(app: AppHandle, webview: Webview, menu: u32, origin: ScreenPoint) -> Result<(), MenuPanelRefusal> {
    menu_panel::show(&app, &webview, menu, origin)
}

/// The tab or the panel closes the menu `menu`.
#[tauri::command]
pub fn menu_panel_close(app: AppHandle, menu: u32, reason: MenuPanelCloseReason) {
    menu_panel::close(&app, Some(menu), reason);
}

/// The panel drew its first frame of the menu: one line of the measurement
/// in the app's log.
#[tauri::command]
pub fn menu_panel_painted(app: AppHandle, paint: MenuPanelPaint) {
    menu_panel::painted(&app, &paint);
}
