// The feed's Display options: order, card presentation and spacing. The
// standard Display panel (DisplayMenu.tsx) with one radio group per option,
// each described as data (src/lib/displayMenu.ts); new options arrive as
// new groups (SPEC_FEED_DISPLAY.md, Д1 to Д3, Д19).

import { useCallback, useMemo } from "react";
import {
  DENSITY_STEPS,
  DENSITY_STORAGE_KEY,
  applyDensity,
  useDensity,
  type DensityStep,
} from "@/lib/density";
import {
  FEED_SHOW_STORAGE_KEY,
  FEED_SORT_STORAGE_KEY,
  setFeedShow,
  setFeedSort,
  useFeedDisplay,
  type FeedShow,
} from "@/lib/feedDisplay";
import { chosenValue, displayChoice, type DisplayChoice, type DisplayGroups } from "@/lib/displayMenu";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import type { FeedOrder, MenuAction } from "@/types";
import { DisplayMenu } from "./DisplayMenu";

export const FEED_SORT_ID = "sort";
export const FEED_SHOW_ID = "show";
export const FEED_SPACING_ID = "spacing";

const SORT_CHOICES: DisplayChoice<FeedOrder>[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

/// The presentations' labels, the only place they are written
/// (SPEC_FEED_DISPLAY.md, Д10): a new name is one line here. The values stay
/// what storage holds (Д18).
const SHOW_CHOICES: DisplayChoice<FeedShow>[] = [
  { value: "cards", label: "Media and Text" },
  { value: "media", label: "Text on Hover" },
  { value: "media-only", label: "Media Only" },
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

// Sort and Show are the whole app's (SPEC_TABS.md, В78): the other tabs and
// windows take them, as they take Spacing (SPEC_DEEP_AUDIT.md, Е6.7).
function applySort(sort: FeedOrder) {
  setFeedSort(sort);
  broadcastSettingsChange(FEED_SORT_STORAGE_KEY);
}

function applyShow(show: FeedShow) {
  setFeedShow(show);
  broadcastSettingsChange(FEED_SHOW_STORAGE_KEY);
}

/** The feed's panel of the Display button, shown in Grid (Д1 to Д4). */
export function FeedDisplayMenu() {
  const { sort, show } = useFeedDisplay();
  const spacing = useDensity();

  const groups = useMemo(() => [
    displayChoice(FEED_SORT_ID, "Sort", sort, SORT_CHOICES),
    displayChoice(FEED_SHOW_ID, "Show", show, SHOW_CHOICES),
    displayChoice(FEED_SPACING_ID, "Spacing", String(spacing), SPACING_CHOICES),
  ], [sort, show, spacing]);

  const apply = useCallback((action: MenuAction): boolean => {
    const chosenSort = chosenValue(action, FEED_SORT_ID, SORT_CHOICES);
    if (chosenSort !== null) {
      applySort(chosenSort);
      return true;
    }
    const chosenShow = chosenValue(action, FEED_SHOW_ID, SHOW_CHOICES);
    if (chosenShow !== null) {
      applyShow(chosenShow);
      return true;
    }
    const chosenSpacing = chosenValue(action, FEED_SPACING_ID, SPACING_CHOICES);
    if (chosenSpacing !== null) {
      applySpacing(chosenSpacing);
      return true;
    }
    return false;
  }, []);

  const view = useMemo<DisplayGroups>(() => ({ groups, largest: groups, apply }), [groups, apply]);
  return <DisplayMenu panel="feed" view={view} />;
}
