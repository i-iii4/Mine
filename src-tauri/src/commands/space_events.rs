// Who hears which event (SPEC_TABS.md, В21).
//
// An event about a space reaches only the pages of the tabs showing that
// space. Pages subscribe through their own webview (`getCurrentWebview()
// .listen`), so the filter below decides; a page listening for any target
// would hear every event, which the frontend lint forbids (В22).

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use super::state::AppState;
use crate::domain::vault::VaultLayout;

/// The label of the settings window page.
pub const SETTINGS_LABEL: &str = "settings";

/// Whether `target` is one of `labels`.
pub fn targets_label(target: &EventTarget, labels: &BTreeSet<String>) -> bool {
    match target {
        EventTarget::Webview { label }
        | EventTarget::WebviewWindow { label }
        | EventTarget::Window { label }
        | EventTarget::AnyLabel { label } => labels.contains(label),
        _ => false,
    }
}

/// Send `event` to the pages `labels`.
pub fn emit_to_labels<S, I, L>(app: &AppHandle, labels: I, event: &str, payload: S)
where
    S: Serialize + Clone,
    I: IntoIterator<Item = L>,
    L: Into<String>,
{
    let labels: BTreeSet<String> = labels.into_iter().map(Into::into).collect();
    if labels.is_empty() {
        return;
    }
    if let Err(error) = app.emit_filter(event, payload, |target| targets_label(target, &labels)) {
        log::warn!("failed to send {event}: {error}");
    }
}

/// Send `event` to the tab in use: the visible tab of the last window
/// (SPEC_TABS.md, В21).
pub fn emit_to_active_tab<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Some(tab) = crate::tabs::last_visible_tab(app) {
        emit_to_labels(app, [tab.label()], event, payload);
    }
}

/// The labels of every tab showing `vault_id`.
pub fn space_labels(app: &AppHandle, vault_id: &str) -> Vec<String> {
    app.state::<AppState>().tabs.labels_of(vault_id)
}

/// Send `event` to every tab showing `vault_id`.
pub fn emit_to_space<S: Serialize + Clone>(app: &AppHandle, vault_id: &str, event: &str, payload: S) {
    emit_to_labels(app, space_labels(app, vault_id), event, payload);
}

/// Send `event` to every tab showing `vault_id` and to the settings window.
pub fn emit_to_space_and_settings<S: Serialize + Clone>(
    app: &AppHandle,
    vault_id: &str,
    event: &str,
    payload: S,
) {
    let mut labels = space_labels(app, vault_id);
    labels.push(SETTINGS_LABEL.to_string());
    emit_to_labels(app, labels, event, payload);
}

/// Send `event` to every tab showing the space whose folder is `root`.
/// Nothing is sent when no open space serves the folder any more.
pub fn emit_to_space_root<S: Serialize + Clone>(app: &AppHandle, root: &Path, event: &str, payload: S) {
    let space = app.state::<AppState>().spaces.by_root(root);
    if let Some(space) = space {
        emit_to_space(app, space.vault_id(), event, payload);
    }
}

/// [`emit_to_space_root`] for a root spelled as a string, as event payloads
/// carry it.
pub fn emit_to_space_path<S: Serialize + Clone>(app: &AppHandle, path: &str, event: &str, payload: S) {
    emit_to_space_root(app, Path::new(path), event, payload);
}

/// Send `event` to the lead tab of the space whose folder is `root`: the
/// visible tab of that space used last (SPEC_TABS.md, В19). Without a lead
/// the event is not sent: the work waits until a tab of the space is shown.
pub fn emit_to_lead<S: Serialize + Clone>(app: &AppHandle, root: &Path, event: &str, payload: S) {
    let state = app.state::<AppState>();
    let Some(space) = state.spaces.by_root(root) else {
        return;
    };
    if let Some(lead) = state.tabs.lead(space.vault_id()) {
        emit_to_labels(app, [lead], event, payload);
    }
}

/// Send `event` to every tab showing the space `vault` belongs to, passing
/// a failure to send back to the caller. A space no longer open has no tab
/// to tell, which is not a failure.
pub fn emit_to_vault<S: Serialize + Clone>(
    app: &AppHandle,
    vault: &VaultLayout,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let Some(space) = app.state::<AppState>().spaces.by_root(vault.root()) else {
        return Ok(());
    };
    let labels: BTreeSet<String> = space_labels(app, space.vault_id()).into_iter().collect();
    if labels.is_empty() {
        return Ok(());
    }
    app.emit_filter(event, payload, |target| targets_label(target, &labels))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_pages_are_targets() {
        let labels: BTreeSet<String> = ["tab-a".to_string()].into_iter().collect();
        let webview = |label: &str| EventTarget::Webview { label: label.to_string() };
        assert!(targets_label(&webview("tab-a"), &labels));
        assert!(!targets_label(&webview("tab-b"), &labels));
        assert!(!targets_label(&EventTarget::App, &labels));
        assert!(targets_label(
            &EventTarget::WebviewWindow { label: "tab-a".into() },
            &labels
        ));
    }
}
