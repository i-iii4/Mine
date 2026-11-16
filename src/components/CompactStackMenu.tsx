// TRIAL (PLAN 50.38, user's requests of 22.10.2026 and 23.10.2026): the
// narrow table's groups in the Display panel (src/lib/compactStack.ts),
// Sidebar style and Compact stack edge, postponed with it. List spacing and
// List style are fixed, Tight and Contents (user's decision of 15.11.2026).
// Once the user decides on the narrow table, these groups either go or the
// chosen look becomes the rule.

import { useId } from "react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  COMPACT_STACK_EDGES,
  COMPACT_STACK_EDGE_LABELS,
  COMPACT_STACK_EDGE_STORAGE_KEY,
  SIDEBAR_STYLES,
  SIDEBAR_STYLE_LABELS,
  SIDEBAR_STYLE_STORAGE_KEY,
  setCompactStackEdge,
  setSidebarStyle,
  useCompactStackEdge,
  useSidebarStyle,
} from "@/lib/compactStack";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import { DisplayGroupCaption } from "./DisplayMenu";

/** One captioned radio group of a trial, kept open between choices; the
 *  panel's other trials use it too (CardViewMenu.tsx). */
export function TrialRadios<T extends string>({
  value,
  choices,
  labels,
  caption,
  onChoose,
}: {
  value: T;
  choices: readonly T[];
  labels: Record<T, string>;
  caption: string;
  onChoose: (choice: T) => void;
}) {
  const labelId = useId();
  return (
    <>
      <DisplayGroupCaption id={labelId}>{caption}</DisplayGroupCaption>
      <DropdownMenuRadioGroup
        aria-labelledby={labelId}
        data-display-trial=""
        value={value}
        onValueChange={(next) => {
          const choice = choices.find((candidate) => candidate === next);
          if (choice) onChoose(choice);
        }}
      >
        {choices.map((choice) => (
          <DropdownMenuRadioItem
            key={choice}
            value={choice}
            // The panel stays open: the next choice is a click away.
            onSelect={(event) => event.preventDefault()}
          >
            {labels[choice]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** The trial groups of the Display panel for the narrow table, postponed
 *  (compactStack.ts, COMPACT_TABLE_POSTPONED; DisplayMenu.tsx shows them only
 *  once it is taken up again): Sidebar style and Compact stack edge, each
 *  named by its caption. */
export function CompactStackMenu() {
  const edge = useCompactStackEdge();
  const sidebarStyle = useSidebarStyle();
  return (
    <div data-compact-stack-menu="">
      <TrialRadios
        value={sidebarStyle}
        choices={SIDEBAR_STYLES}
        labels={SIDEBAR_STYLE_LABELS}
        caption="Sidebar style"
        onChoose={(choice) => {
          setSidebarStyle(choice);
          broadcastSettingsChange(SIDEBAR_STYLE_STORAGE_KEY);
        }}
      />
      <DropdownMenuSeparator />
      <TrialRadios
        value={edge}
        choices={COMPACT_STACK_EDGES}
        labels={COMPACT_STACK_EDGE_LABELS}
        caption="Compact stack edge"
        onChoose={(choice) => {
          setCompactStackEdge(choice);
          broadcastSettingsChange(COMPACT_STACK_EDGE_STORAGE_KEY);
        }}
      />
    </div>
  );
}
