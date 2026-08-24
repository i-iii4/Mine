/// Loading and saving shortcut overrides, and keeping the registry in step.
///
/// Both windows call `hydrateCommandOverrides` at startup and listen for
/// `shortcuts-changed`, so a rebind in Settings reaches the main window without
/// a restart.

import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import type { CommandBinding } from "./commandBinding";
import { setCommandOverrides, type CommandOverrides } from "./commandRegistry";
import { listShortcutOverrides, saveShortcutOverrides } from "./commands";

export async function hydrateCommandOverrides(): Promise<void> {
  if (!isTauri()) return;
  try {
    setCommandOverrides(await listShortcutOverrides());
  } catch (error) {
    // A broken override file must not take the app down: defaults still work.
    console.error("Failed to load shortcut overrides:", error);
  }
}

export async function persistCommandOverrides(
  overrides: Readonly<Record<string, CommandBinding>>,
): Promise<void> {
  setCommandOverrides(overrides as CommandOverrides);
  await saveShortcutOverrides(overrides);
}

/// Subscribe to rebinds made in the other window.
export function watchCommandOverrides(): () => void {
  if (!isTauri()) return () => {};
  const unlisten = listen<CommandOverrides>("shortcuts-changed", (event) => {
    setCommandOverrides(event.payload ?? {});
  });
  return () => { void unlisten.then((stop) => stop()); };
}
