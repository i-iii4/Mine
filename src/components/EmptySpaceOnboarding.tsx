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
      <div className="w-full max-w-2xl px-8 text-left">
        <p className="text-lg font-semibold text-foreground">This space is empty</p>
        <p className="mt-1 text-base text-muted-foreground">
          Everything you save lands here as ordinary files in your folder.
        </p>

        <div className="mt-8 grid gap-10 sm:grid-cols-2">
          <div>
            <p className="text-base font-semibold text-foreground">Save from the web</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              The browser clipper saves pages, images and videos straight into
              this space.
            </p>
            <div className="mt-3">
              <Button onClick={onInstallClipper}>
                <Download className="size-4" />
                Install the clipper
              </Button>
            </div>
          </div>
          <div>
            <p className="text-base font-semibold text-foreground">Drag files in</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Drop images, videos or documents anywhere in this window.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
