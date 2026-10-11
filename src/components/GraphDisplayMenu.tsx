// The graph's panel of the Display button, shown in Graph (SPEC_GRAPH_VIEW.md,
// «Панель графа»). The same button and panel as the feed's (DisplayMenu.tsx);
// its one group switches the extra links between cards on and off.
// Collections and their membership edges are always drawn and have no switch.

import { useId } from "react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import {
  setGraphPreference,
  useGraphPreferences,
  type GraphLinkPreference,
} from "@/lib/graphPreferences";
import { DisplayGroupCaption, DisplayMenu } from "./DisplayMenu";

interface LinkChoice {
  key: GraphLinkPreference;
  label: string;
}

/** The extra links, in the order the Settings window lists them. */
const LINK_CHOICES: readonly LinkChoice[] = [
  { key: "include_wikilinks", label: "Wikilinks" },
  { key: "include_related_notes", label: "Related notes" },
];

/** The Display button and panel in Graph. */
export function GraphDisplayMenu() {
  const preferences = useGraphPreferences();
  const labelId = useId();

  return (
    <DisplayMenu panel="graph">
      <DisplayGroupCaption id={labelId}>Links</DisplayGroupCaption>
      <DropdownMenuGroup aria-labelledby={labelId}>
        {LINK_CHOICES.map((choice) => (
          <DropdownMenuCheckboxItem
            key={choice.key}
            checked={preferences[choice.key]}
            onCheckedChange={(checked) => setGraphPreference(choice.key, checked)}
            // The panel stays open: the switch applies at once and the next
            // one is a click away, as in the feed's panel (Д3).
            onSelect={(event) => event.preventDefault()}
          >
            {choice.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
    </DisplayMenu>
  );
}
