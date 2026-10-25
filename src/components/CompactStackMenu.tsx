// TRIAL (PLAN 50.38, user's requests of 22.10.2026 and 23.10.2026): the
// sidebar's groups in the Display panel (src/lib/compactStack.ts): List
// spacing and List style, and, while the narrow table is not postponed,
// Sidebar style and Compact stack edge. Once the user decides, these groups
// either go or the chosen look becomes the rule.

import { useId } from "react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  COMPACT_STACK_EDGES,
  COMPACT_TABLE_POSTPONED,
  COMPACT_STACK_EDGE_LABELS,
  COMPACT_STACK_EDGE_STORAGE_KEY,
  LIST_SPACINGS,
  LIST_STYLES,
  LIST_STYLE_LABELS,
  LIST_STYLE_STORAGE_KEY,
  LIST_SPACING_LABELS,
  LIST_SPACING_STORAGE_KEY,
  SIDEBAR_STYLES,
  SIDEBAR_STYLE_LABELS,
  SIDEBAR_STYLE_STORAGE_KEY,
  setCompactStackEdge,
  setListSpacing,
  setListStyle,
  setSidebarStyle,
  useCompactStackEdge,
  useListSpacing,
  useListStyle,
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

/** The trial groups of the Display panel: the compact sidebar item's stack,
 *  each named by its caption. */
export function CompactStackMenu() {
  const edge = useCompactStackEdge();
  const sidebarStyle = useSidebarStyle();
  const listSpacing = useListSpacing();
  const listStyle = useListStyle();
  return (
    <div data-compact-stack-menu="">
      {/* POSTPONED (compactStack.ts, COMPACT_TABLE_POSTPONED): the narrow
          table's choices are put aside while the List is developed. */}
      {!COMPACT_TABLE_POSTPONED && (
      <>
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
      </>
      )}
      <TrialRadios
        value={listSpacing}
        choices={LIST_SPACINGS}
        labels={LIST_SPACING_LABELS}
        caption="List spacing"
        onChoose={(choice) => {
          setListSpacing(choice);
          broadcastSettingsChange(LIST_SPACING_STORAGE_KEY);
        }}
      />
      <DropdownMenuSeparator />
      <TrialRadios
        value={listStyle}
        choices={LIST_STYLES}
        labels={LIST_STYLE_LABELS}
        caption="List style"
        onChoose={(choice) => {
          setListStyle(choice);
          broadcastSettingsChange(LIST_STYLE_STORAGE_KEY);
        }}
      />
      {!COMPACT_TABLE_POSTPONED && (
      <>
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
      </>
      )}
    </div>
  );
}
