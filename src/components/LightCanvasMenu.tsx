// TRIAL (PLAN 47.7, user's request of 16.10.2026): «Light canvas» in the
// Display panel, White (L 1, today's) or Soft (L 0.975), for the light theme
// only (src/lib/lightCanvas.ts). Once the user decides, this group either
// goes or the chosen canvas becomes K1.

import { useId } from "react";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import {
  LIGHT_CANVAS_LABELS,
  LIGHT_CANVAS_STORAGE_KEY,
  setLightCanvas,
  useLightCanvas,
  type LightCanvas,
} from "@/lib/lightCanvas";
import { broadcastSettingsChange } from "@/lib/settingsChanged";
import { DisplayGroupCaption } from "./DisplayMenu";

const CHOICES: readonly LightCanvas[] = ["white", "soft"];

/** The trial group of the Display panel: the light theme's canvas. */
export function LightCanvasMenu() {
  const canvas = useLightCanvas();
  const labelId = useId();
  return (
    <>
      <DisplayGroupCaption id={labelId}>Light canvas</DisplayGroupCaption>
      <DropdownMenuRadioGroup
        aria-labelledby={labelId}
        data-light-canvas-menu=""
        data-display-trial=""
        value={canvas}
        onValueChange={(next) => {
          const choice = CHOICES.find((candidate) => candidate === next);
          if (!choice) return;
          setLightCanvas(choice);
          broadcastSettingsChange(LIGHT_CANVAS_STORAGE_KEY);
        }}
      >
        {CHOICES.map((choice) => (
          <DropdownMenuRadioItem
            key={choice}
            value={choice}
            // The panel stays open: the next choice is a click away.
            onSelect={(event) => event.preventDefault()}
          >
            {LIGHT_CANVAS_LABELS[choice]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
