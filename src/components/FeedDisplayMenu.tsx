// The feed's Display options: order, card presentation and spacing. The
// standard Display panel (DisplayMenu.tsx) with one radio group per option;
// new options arrive as new groups (SPEC_FEED_DISPLAY.md, Д1 to Д3, Д19).

import { useId } from "react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  DENSITY_STEPS,
  DENSITY_STORAGE_KEY,
  applyDensity,
  useDensity,
  type DensityStep,
} from "@/lib/density";
import {
  setFeedShow,
  setFeedSort,
  useFeedDisplay,
  type FeedShow,
} from "@/lib/feedDisplay";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import type { FeedOrder } from "@/types";
import { DisplayGroupCaption, DisplayMenu } from "./DisplayMenu";

interface DisplayChoice<T extends string> {
  value: T;
  label: string;
}

const SORT_CHOICES: DisplayChoice<FeedOrder>[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const SHOW_CHOICES: DisplayChoice<FeedShow>[] = [
  { value: "cards", label: "Cards" },
  { value: "media", label: "Media" },
];

const SPACING_CHOICES: DisplayChoice<string>[] = DENSITY_STEPS.map((step) => ({
  value: String(step),
  label: String(step),
}));

function isDensityStep(value: number): value is DensityStep {
  return (DENSITY_STEPS as readonly number[]).includes(value);
}

function applySpacing(value: string) {
  const step = Number(value);
  if (!isDensityStep(step)) return;
  applyDensity(step);
  // Other windows (Settings) re-read the rhythm.
  broadcastSettingsChange(DENSITY_STORAGE_KEY);
}

function DisplayGroup<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly DisplayChoice<T>[];
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <>
      <DisplayGroupCaption id={labelId}>{label}</DisplayGroupCaption>
      <DropdownMenuRadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => {
          const choice = choices.find((candidate) => candidate.value === next);
          if (choice) onChange(choice.value);
        }}
      >
        {choices.map((choice) => (
          <DropdownMenuRadioItem
            key={choice.value}
            value={choice.value}
            // The menu stays open: the choice applies at once and the next
            // one is a click away (Д3).
            onSelect={(event) => event.preventDefault()}
          >
            {choice.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** The feed's panel of the Display button, shown in Grid (Д1 to Д4). */
export function FeedDisplayMenu() {
  const { sort, show } = useFeedDisplay();
  const spacing = useDensity();

  return (
    <DisplayMenu panel="feed">
      <DisplayGroup label="Sort" value={sort} choices={SORT_CHOICES} onChange={setFeedSort} />
      <DropdownMenuSeparator />
      <DisplayGroup label="Show" value={show} choices={SHOW_CHOICES} onChange={setFeedShow} />
      <DropdownMenuSeparator />
      <DisplayGroup
        label="Spacing"
        value={String(spacing)}
        choices={SPACING_CHOICES}
        onChange={applySpacing}
      />
    </DisplayMenu>
  );
}
