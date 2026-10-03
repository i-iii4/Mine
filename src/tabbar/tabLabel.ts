// What a tab says (SPEC_TABS.md, В47). The names come from the backend's
// registry, so an unloaded tab is labelled without a page of its own.

import type { TabBarTab } from "@/types";

/** Label of a tab with no space to show. */
export const CHOOSE_SPACE_LABEL = "Choose Space";

/** Joins the two names in the tooltip, where colour cannot part them. */
const TITLE_SEPARATOR = " · ";

/** The visible parts of a tab's label and its full text for `title`. */
export interface TabLabel {
  /** Foreground text: the collection inside one, else the space. */
  primary: string;
  /** Muted text after `primary`: the space when inside a collection. */
  secondary: string | null;
  /** The whole label, shown by the system tooltip. */
  title: string;
}

/** Everything shows the space; a collection shows itself, then its space;
 *  a tab without a space asks for one. */
export function tabLabel(tab: Pick<TabBarTab, "space_name" | "collection">): TabLabel {
  if (tab.space_name === null) {
    return { primary: CHOOSE_SPACE_LABEL, secondary: null, title: CHOOSE_SPACE_LABEL };
  }
  if (tab.collection === null) {
    return { primary: tab.space_name, secondary: null, title: tab.space_name };
  }
  return {
    primary: tab.collection,
    secondary: tab.space_name,
    title: `${tab.collection}${TITLE_SEPARATOR}${tab.space_name}`,
  };
}
