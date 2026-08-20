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
// See SPEC_ONBOARDING.md О14–О18.

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptySpaceOnboardingProps {
  viewportHeight: number;
  onInstallClipper: () => void;
}

export function EmptySpaceOnboarding({
  viewportHeight,
  onInstallClipper,
}: EmptySpaceOnboardingProps) {
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
          <Button onClick={onInstallClipper}>
            <Download className="size-4" />
            Install the extension
          </Button>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          Or drag images, videos and documents straight into this window.
        </p>
      </div>
    </div>
  );
}
