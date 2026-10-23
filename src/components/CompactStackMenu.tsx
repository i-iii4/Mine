// TRIAL (PLAN 50.38, user's request of 22.10.2026): «Compact stack» in the
// Display panel: Standard or Large, Shadow or Ring, and the sidebar
// thumbnails' corners, Square or Rounded (src/lib/compactStack.ts).
// Once the user decides, this group either goes or the chosen stack becomes
// the rule.

import { useId } from "react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  COMPACT_STACK_CHOICES,
  COMPACT_STACK_EDGES,
  COMPACT_STACK_EDGE_LABELS,
  COMPACT_STACK_EDGE_STORAGE_KEY,
  COMPACT_STACK_LABELS,
  COMPACT_STACK_STORAGE_KEY,
  SIDEBAR_STYLES,
  SIDEBAR_STYLE_LABELS,
  SIDEBAR_STYLE_STORAGE_KEY,
  THUMB_CORNERS,
  THUMB_CORNERS_LABELS,
  THUMB_CORNERS_STORAGE_KEY,
  setCompactStack,
  setCompactStackEdge,
  setSidebarStyle,
  setThumbCorners,
  useCompactStack,
  useCompactStackEdge,
  useSidebarStyle,
  useThumbCorners,
} from "@/lib/compactStack";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import { DisplayGroupCaption } from "./DisplayMenu";

/** One captioned radio group of the trial, kept open between choices. */
function TrialRadios<T extends string>({
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
  const stack = useCompactStack();
  const edge = useCompactStackEdge();
  const thumbCorners = useThumbCorners();
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
        value={stack}
        choices={COMPACT_STACK_CHOICES}
        labels={COMPACT_STACK_LABELS}
        caption="Compact stack size"
        onChoose={(choice) => {
          setCompactStack(choice);
          broadcastSettingsChange(COMPACT_STACK_STORAGE_KEY);
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
      <DropdownMenuSeparator />
      <TrialRadios
        value={thumbCorners}
        choices={THUMB_CORNERS}
        labels={THUMB_CORNERS_LABELS}
        caption="Thumbnail corners"
        onChoose={(choice) => {
          setThumbCorners(choice);
          broadcastSettingsChange(THUMB_CORNERS_STORAGE_KEY);
        }}
      />
    </div>
  );
}
