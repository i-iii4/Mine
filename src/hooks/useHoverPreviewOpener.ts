import { useEffect, useRef, useState } from "react";
import { HoverPreviewOpener } from "@/lib/hoverPreviewTiming";

/**
 * One surface's card hover preview timing (SPEC_CARD_STATES.md, С7.10).
 * `isResting` reads the surface's hover-intent engine (`isSlow`); the opener
 * lives as long as the surface and drops its pending request on unmount.
 */
export function useHoverPreviewOpener(isResting: () => boolean): HoverPreviewOpener {
  const isRestingRef = useRef(isResting);
  isRestingRef.current = isResting;
  const [opener] = useState(() => new HoverPreviewOpener(() => isRestingRef.current()));
  useEffect(() => () => opener.dispose(), [opener]);
  return opener;
}
