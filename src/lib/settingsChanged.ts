// Cross-window settings synchronization contract. The settings window writes
// localStorage (shared per origin) and emits this Tauri event; the main window
// re-reads the changed key. A Tauri event is used instead of the DOM "storage"
// event because the latter is not guaranteed across Tauri webviews.
//
// The event carries the stored value itself. Each window is its own WebKit
// process: a write in the settings window reaches the main window's storage
// later than the event does, so re-reading on arrival returned the old value
// and a switch turned off in Settings stayed on until the app restarted.

import { emit } from "@tauri-apps/api/event";

export const SETTINGS_CHANGED_EVENT = "settings-changed";

export interface SettingsChangedPayload {
  key: string;
  /** The value the sender stored; `null` when it removed the key. Absent
   *  from senders that predate this field. */
  value?: string | null;
}

export function broadcastSettingsChange(key: string) {
  const payload: SettingsChangedPayload = { key, value: readStored(key) };
  void emit(SETTINGS_CHANGED_EVENT, payload).catch((error) => {
    console.error("Failed to broadcast settings change:", error);
  });
}

/** Make this window's storage hold what the sender stored, before anything
 *  re-reads the key. */
export function adoptSettingsChange(payload: SettingsChangedPayload): void {
  if (payload.value === undefined) return;
  try {
    if (payload.value === null) {
      window.localStorage.removeItem(payload.key);
    } else if (window.localStorage.getItem(payload.key) !== payload.value) {
      window.localStorage.setItem(payload.key, payload.value);
    }
  } catch (error) {
    console.error("Failed to adopt settings change:", error);
  }
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
