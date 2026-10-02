// What a brand-new space says instead of nothing.
//
// An empty Everything route used to render an empty area: no hint that a
// clipper exists, no mention of dragging files in. The two ways to fill a
// space are the two things worth saying, and they are said once — the state
// disappears with the first card and does not come back.
//
// Icon economy: the one icon lives inside the install button, where it names
// the action; the paths themselves are words. Content is left-aligned in two
// columns, per the review of 17.08.2026.
//
// The Are.na import is deliberately not offered: it was cancelled for this
// version (16.08.2026), with no promise of a later one.
//
// Installing the extension happens here, not in Settings: the button shows
// the folder a browser loads once and says how, in one line. Settings has no
// Extension section since 30.09.2026 (SPEC_ONBOARDING.md, О16).
// See SPEC_ONBOARDING.md О14–О18.

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/** How a browser takes the extension while it is not in the store. */
export const EXTENSION_INSTALL_STEP =
  "In Chrome, open chrome://extensions, turn on Developer mode, choose Load unpacked and pick the folder that opened in Finder.";

interface EmptySpaceOnboardingProps {
  viewportHeight: number;
  /** Shows the extension folder in Finder. */
  onInstallClipper: () => void;
  /** The steps start open (the edge-states showcase). */
  initialStepsOpen?: boolean;
}

export function EmptySpaceOnboarding({
  viewportHeight,
  onInstallClipper,
  initialStepsOpen = false,
}: EmptySpaceOnboardingProps) {
  const [stepsOpen, setStepsOpen] = useState(initialStepsOpen);
  return (
    <div
      className="grid place-items-center"
      style={{ minHeight: Math.max(320, viewportHeight) }}
      data-empty-space-onboarding=""
    >
      {/* One column, one accent. The two-column arrangement gave the second
          half no action, so it read as an unfinished half of the first; the
          way that needs no button is a line of text, not a column. */}
      <div className="w-full max-w-md px-8 text-left">
        <p className="text-lg font-semibold text-foreground">Nothing here yet</p>
        <p className="mt-1 text-base text-muted-foreground">
          Everything you save becomes plain files in your folder. The extension
          brings pages, images and videos straight into this space.
        </p>

        <div className="mt-6">
          <Button
            onClick={() => {
              setStepsOpen(true);
              onInstallClipper();
            }}
          >
            <Download className="size-[13px]" />
            Install the extension
          </Button>
        </div>

        {stepsOpen && (
          <p className="mt-3 text-sm text-foreground" role="status" data-empty-space-install-step="">
            {EXTENSION_INSTALL_STEP}
          </p>
        )}

        <p className="mt-4 text-sm text-muted-foreground">
          Or drag images, videos and documents straight into this window.
        </p>
      </div>
    </div>
  );
}
