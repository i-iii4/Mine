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

/** What a tab's tooltip says: its label, and for a tab whose page or window
 *  could not be made, why and what to do (SPEC_TABS.md, «Ошибки»;
 *  SPEC_DEEP_AUDIT.md, Е2.9). The backend's reason starts lowercase. */
export function tabTitle(tab: Pick<TabBarTab, "space_name" | "place" | "card" | "error">): string {
  const label = tabLabel(tab);
  if (!tab.error) return label;
  const reason = tab.error.charAt(0).toUpperCase() + tab.error.slice(1);
  return `${label}\n${reason}. Select the tab to try again.`;
}
