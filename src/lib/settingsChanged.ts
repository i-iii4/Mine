// Cross-window settings synchronization contract. The settings window writes
// localStorage (shared per origin) and emits this Tauri event; the main window
// re-reads the changed key. A Tauri event is used instead of the DOM "storage"
// event because the latter is not guaranteed across Tauri webviews.

export const SETTINGS_CHANGED_EVENT = "settings-changed";

export interface SettingsChangedPayload {
  key: string;
}
