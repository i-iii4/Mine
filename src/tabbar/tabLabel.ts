// What a tab says (SPEC_TABS.md, В47): the deepest place open in it. The names
// come from the backend's registry and the tab's saved memory, so an unloaded
// tab is labelled without a page of its own.

import type { TabBarTab } from "@/types";

/** Label of a tab with no space to show. */
export const CHOOSE_SPACE_LABEL = "Choose Space";

/** The open card, else the place (a collection or an author), else the
 *  space on Everything; a tab without a space asks for one. */
export function tabLabel(tab: Pick<TabBarTab, "space_name" | "place" | "card">): string {
  if (tab.space_name === null) return CHOOSE_SPACE_LABEL;
  return tab.card ?? tab.place ?? tab.space_name;
}

/** What a tab's tooltip says: its label. A tab whose page could not be made
 *  says nothing more; selecting it makes the page again, and why it failed
 *  is in the log (SPEC_TABS.md, «Ошибки»; decision of 14.10.2026). */
export function tabTitle(tab: Pick<TabBarTab, "space_name" | "place" | "card">): string {
  return tabLabel(tab);
}
