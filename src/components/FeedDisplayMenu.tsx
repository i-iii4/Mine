// The feed's Display options: order, card presentation, media placement and
// spacing. A standard command menu with one radio group per option; new options
// arrive as new groups (SPEC_FEED_DISPLAY.md, Д1 to Д3, Д19).

import { Settings2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTopChromeTriggerInteraction } from "@/hooks/useTopChromeTriggerInteraction";
import {
  DENSITY_STEPS,
  DENSITY_STORAGE_KEY,
  applyDensity,
  useDensity,
  type DensityStep,
} from "@/lib/density";
import {
  setFeedMedia,
  setFeedShow,
  setFeedSort,
  useFeedDisplay,
  type FeedMedia,
  type FeedShow,
} from "@/lib/feedDisplay";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import type { FeedOrder } from "@/types";

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
  { value: "mixed", label: "Mixed" },
  { value: "media", label: "Media" },
];

const MEDIA_CHOICES: DisplayChoice<FeedMedia>[] = [
  { value: "inset", label: "Inset" },
  { value: "edge", label: "Edge to edge" },
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
      {/* Same caption as the selection menu's count header. */}
      <div id={labelId} className="px-2 py-1.5 font-mono text-sm text-muted-foreground">
        {label}
      </div>
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

export function FeedDisplayMenu() {
  const { sort, show, media } = useFeedDisplay();
  const spacing = useDensity();
  const { triggerProps, handleCloseAutoFocus } =
    useTopChromeTriggerInteraction({ dragDisabled: true });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          {...triggerProps}
          aria-label="Display options"
          variant="chrome"
          size="chrome-icon"
          data-feed-display-trigger=""
        >
          <Settings2 aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={handleCloseAutoFocus}
        data-feed-display-panel=""
      >
        <DisplayGroup label="Sort" value={sort} choices={SORT_CHOICES} onChange={setFeedSort} />
        <DropdownMenuSeparator />
        <DisplayGroup label="Show" value={show} choices={SHOW_CHOICES} onChange={setFeedShow} />
        <DropdownMenuSeparator />
        <DisplayGroup label="Media" value={media} choices={MEDIA_CHOICES} onChange={setFeedMedia} />
        <DropdownMenuSeparator />
        <DisplayGroup
          label="Spacing"
          value={String(spacing)}
          choices={SPACING_CHOICES}
          onChange={applySpacing}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
