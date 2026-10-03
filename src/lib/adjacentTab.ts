// ⌃Tab and ⌃⇧Tab: the next or previous tab of the window (SPEC_TABS.md, В55,
// В57). Shared by tab pages and tab bars; the ⌘ chords of the same commands
// belong to the native menu and are not matched here.

import { bindingMatches } from "@/lib/commandBinding";
import { commandById } from "@/lib/commandRegistry";

function pageChordMatches(id: string, event: KeyboardEvent): boolean {
  return (commandById(id).alternates ?? []).some((binding) => bindingMatches(binding, event));
}

/** The direction ⌃Tab (forward) or ⌃⇧Tab (back) asks for, or `null` for any
 *  other key. The chords come from the command registry. */
export function adjacentTabDirection(event: KeyboardEvent): "forward" | "back" | null {
  if (pageChordMatches("next-tab", event)) return "forward";
  if (pageChordMatches("previous-tab", event)) return "back";
  return null;
}
