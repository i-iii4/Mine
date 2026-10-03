// What a tab says (SPEC_TABS.md, В47): the deepest place open in it. The names
// come from the backend's registry and the tab's saved memory, so an unloaded
// tab is labelled without a page of its own.

import type { TabBarTab } from "@/types";

/** Label of a tab with no space to show. */
export const CHOOSE_SPACE_LABEL = "Choose Space";

/** The open card, else the collection, else the space on Everything; a tab
 *  without a space asks for one. */
export function tabLabel(tab: Pick<TabBarTab, "space_name" | "collection" | "card">): string {
  if (tab.space_name === null) return CHOOSE_SPACE_LABEL;
  return tab.card ?? tab.collection ?? tab.space_name;
}
