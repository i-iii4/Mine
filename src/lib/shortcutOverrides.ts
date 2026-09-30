/// Loading and saving shortcut overrides, and keeping the registry in step.
///
/// Both windows call `hydrateCommandOverrides` at startup and listen for
/// `shortcuts-changed`, so a rebind in Settings reaches the main window without
/// a restart.

import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import type { CommandBinding } from "./commandBinding";
import { getCommandOverrides, setCommandOverrides, type CommandOverrides } from "./commandRegistry";
import { listShortcutOverrides, saveShortcutOverrides } from "./commands";

/// Not awaited before the first render: that would put an IPC round trip on
/// the startup critical path (SPEC_STARTUP_PERFORMANCE.md), and every keydown
/// handler reads the registry at the keypress, so the loaded chords apply from
/// the moment they arrive.
export async function hydrateCommandOverrides(): Promise<void> {
  if (!isTauri()) return;
  const before = getCommandOverrides();
  try {
    const loaded = await listShortcutOverrides();
    // A rebind that reached this window while the file was being read is
    // newer than what was read; the stale answer must not undo it.
    if (getCommandOverrides() !== before) return;
    setCommandOverrides(loaded);
  } catch (error) {
    // A broken override file must not take the app down: defaults still work.
    console.error("Failed to load shortcut overrides:", error);
  }
}

export async function persistCommandOverrides(
  overrides: Readonly<Record<string, CommandBinding>>,
): Promise<void> {
  const previous = getCommandOverrides();
  setCommandOverrides(overrides as CommandOverrides);
  try {
    await saveShortcutOverrides(overrides);
  } catch (error) {
    setCommandOverrides(previous);
    throw error;
  }
}

/// Subscribe to rebinds made in the other window.
export function watchCommandOverrides(): () => void {
  if (!isTauri()) return () => {};
  const unlisten = listen<CommandOverrides>("shortcuts-changed", (event) => {
    setCommandOverrides(event.payload ?? {});
  });
  return () => { void unlisten.then((stop) => stop()); };
}
