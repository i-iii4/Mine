// The graph's panel of the Display button, shown in Graph (SPEC_GRAPH_VIEW.md,
// «Панель графа»). The same button and panel as the feed's (DisplayMenu.tsx);
// its one group switches the extra links between cards on and off, described
// as data (src/lib/displayMenu.ts). Collections and their membership edges
// are always drawn and have no switch.

import { useCallback, useMemo } from "react";
import type { DisplayGroups } from "@/lib/displayMenu";
import {
  setGraphPreference,
  useGraphPreferences,
  type GraphLinkPreference,
} from "@/lib/graphPreferences";
import type { MenuAction, MenuEntry } from "@/types";
import { DisplayMenu } from "./DisplayMenu";

interface LinkChoice {
  key: GraphLinkPreference;
  label: string;
}

/** The extra links, in the order the Settings window lists them. */
const LINK_CHOICES: readonly LinkChoice[] = [
  { key: "include_wikilinks", label: "Wikilinks" },
  { key: "include_related_notes", label: "Related notes" },
];

/** The switch of a link in the panel's description. */
function linkId(key: GraphLinkPreference): string {
  return `links.${key}`;
}

/** The Display button and panel in Graph. */
export function GraphDisplayMenu() {
  const preferences = useGraphPreferences();

  const groups = useMemo((): MenuEntry[][] => [[
    { kind: "caption", text: "Links" },
    ...LINK_CHOICES.map((choice): MenuEntry => ({
      kind: "checkbox",
      id: linkId(choice.key),
      label: choice.label,
      checked: preferences[choice.key],
    })),
  ]], [preferences]);

  // The panel stays open: the switch applies at once and the next one is a
  // click away, as in the feed's panel (Д3).
  const apply = useCallback((action: MenuAction): boolean => {
    if (action.kind !== "check") return false;
    const choice = LINK_CHOICES.find((candidate) => linkId(candidate.key) === action.id);
    if (choice === undefined) return false;
    setGraphPreference(choice.key, action.checked);
    return true;
  }, []);

  const view = useMemo<DisplayGroups>(() => ({ groups, largest: groups, apply }), [groups, apply]);
  return <DisplayMenu panel="graph" view={view} />;
}
