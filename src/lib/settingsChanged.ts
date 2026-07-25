// Cross-window settings synchronization contract. The settings window writes
// localStorage (shared per origin) and emits this Tauri event; the main window
// re-reads the changed key. A Tauri event is used instead of the DOM "storage"
// event because the latter is not guaranteed across Tauri webviews.

import { emit } from "@tauri-apps/api/event";

export const SETTINGS_CHANGED_EVENT = "settings-changed";

export interface SettingsChangedPayload {
  key: string;
}

export function broadcastSettingsChange(key: string) {
  const payload: SettingsChangedPayload = { key };
  void emit(SETTINGS_CHANGED_EVENT, payload).catch((error) => {
    console.error("Failed to broadcast settings change:", error);
  });
}
