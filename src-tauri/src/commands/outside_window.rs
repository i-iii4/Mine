// The commands of the outside window (SPEC_OUTSIDE_WINDOW.md, part В), a thin
// layer over crate::outside_window. They run on the main thread: each one
// reads or moves a window, and one thread is the one place that sets the order
// of what is said about a showing (НО7).

use tauri::{AppHandle, Webview};

use crate::outside_window::{
    self, OutsidePageReport, OutsideRefusal, OutsideWindowStatus, PreviewOpenRequest, PreviewStepRequest,
};

/// Make the outside window unless it exists; whether it is ready. `page` is
/// the load of the page that asks.
#[tauri::command]
pub fn outside_window_prepare(app: AppHandle, webview: Webview, page: String) -> OutsideWindowStatus {
    outside_window::prepare(&app, &webview, &page)
}

/// A page opens a showing of its preview outside its app window.
#[tauri::command]
pub fn outside_window_open_preview(
    app: AppHandle,
    webview: Webview,
    request: PreviewOpenRequest,
) -> Result<(), OutsideRefusal> {
    outside_window::open_preview(&app, &webview, request)
}

/// A step of a page's showing.
#[tauri::command]
pub fn outside_window_preview_step(app: AppHandle, webview: Webview, request: PreviewStepRequest) {
    outside_window::preview_step(&app, &webview, request);
}

/// The outside window's page reports.
#[tauri::command]
pub fn outside_window_report(app: AppHandle, webview: Webview, report: OutsidePageReport) {
    outside_window::page_report(&app, &webview, report);
}
