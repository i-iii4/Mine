// The feed's Display options: order, card presentation and spacing, in one
// panel that will grow (filters come later). SPEC_FEED_DISPLAY.md, Д1 to Д18.

import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  DENSITY_STEPS,
  DENSITY_STORAGE_KEY,
  applyDensity,
  useDensity,
  type DensityStep,
} from "@/lib/density";
import { setFeedShow, setFeedSort, useFeedDisplay, type FeedShow } from "@/lib/feedDisplay";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import type { FeedOrder } from "@/types";

const SORT_OPTIONS: SegmentedControlOption<FeedOrder>[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const SHOW_OPTIONS: SegmentedControlOption<FeedShow>[] = [
  { value: "cards", label: "Cards" },
  { value: "mixed", label: "Mixed" },
  { value: "media", label: "Media" },
];

const SPACING_OPTIONS: SegmentedControlOption<string>[] = DENSITY_STEPS.map((step) => ({
  value: String(step),
  label: String(step),
}));

function isDensityStep(value: number): value is DensityStep {
  return (DENSITY_STEPS as readonly number[]).includes(value);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4" data-feed-display-row={label}>
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function FeedDisplayMenu() {
  const { sort, show } = useFeedDisplay();
  const spacing = useDensity();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="chrome"
          size="chrome-icon"
          aria-label="Display options"
          title="Display options"
          data-feed-display-trigger=""
        >
          <SlidersHorizontal aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid gap-3" data-feed-display-panel="">
        <Row label="Sort">
          <SegmentedControl
            aria-label="Sort"
            size="default"
            value={sort}
            options={SORT_OPTIONS}
            onChange={setFeedSort}
          />
        </Row>
        <Row label="Show">
          <SegmentedControl
            aria-label="Show"
            size="default"
            value={show}
            options={SHOW_OPTIONS}
            onChange={setFeedShow}
          />
        </Row>
        <Row label="Spacing">
          <SegmentedControl
            aria-label="Spacing"
            size="default"
            value={String(spacing)}
            options={SPACING_OPTIONS}
            onChange={(value) => {
              const step = Number(value);
              if (!isDensityStep(step)) return;
              applyDensity(step);
              // Other windows (Settings) re-read the rhythm.
              broadcastSettingsChange(DENSITY_STORAGE_KEY);
            }}
          />
        </Row>
      </PopoverContent>
    </Popover>
  );
}
