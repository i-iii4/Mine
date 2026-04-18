// Measurement-only card component.
//
// Renders the exact same DOM structure as <Card>, minus the interactive
// wrappers (useDraggable, event handlers, CardHoverMenu). The DOM is visually
// identical to the real card, so its getBoundingClientRect height matches
// what the real card will render at the same column width.
//
// Used by the DOM measurement pass in Grid.tsx during channel load / new
// columnWidth bucket. Not used in the visible render path.

import { memo } from "react";
import type { LightBlock } from "@/types";
import { CardContent, MeasuredCardFrame } from "./Card";

interface MeasureCardProps {
  block: LightBlock;
  vaultPath: string;
  thumbsRootPath?: string;
}

export const MeasureCard = memo(function MeasureCard({
  block,
  vaultPath,
  thumbsRootPath,
}: MeasureCardProps) {
  // Mirror the class list from Card.tsx (the outer wrapper) EXCEPT the
  // interactive state classes (opacity-30 while dragging, ring-2 when
  // focused). Those never apply during measurement.
  return (
    <MeasuredCardFrame>
      <CardContent
        block={block}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath}
        priority={false}
        measurementMode
      />
    </MeasuredCardFrame>
  );
});
