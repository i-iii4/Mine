import { useSyncExternalStore } from "react";
import { getCommandOverrides, subscribeToCommands } from "@/lib/commandRegistry";

/// Re-render on a rebind, so every chord shown on screen follows the registry
/// the moment Settings changes it (SPEC_AUDIT_FIXES.md, Ф11). Keydown handlers
/// read the registry at the keypress and need no re-render; labels do.
export function useCommandOverrides() {
  return useSyncExternalStore(subscribeToCommands, getCommandOverrides, getCommandOverrides);
}
