// TRIAL (SPEC_CARD_PEEK.md, О3, О8): the open card in a frame of its own,
// the card's window. Where the card's panel stands is decided by the place
// the window has, not by the window's width, and the window narrows to the
// content with the panel under it: the card tells the window its content's
// width, the window tells the card its layout. Outside the window (the full
// page, a test) there is no frame and the card decides by its own width.

import { createContext, useContext } from "react";
import type { DetailLayoutMode } from "@/lib/detailLayout";

export interface DetailFrame {
  /** The layout the window's place decides; null until the card told the
   *  window its content's width. */
  layout: DetailLayoutMode | null;
  /** The card's drawn content's full width (Р1) and its inset, px. */
  report(contentWidth: number, padPx: number): void;
}

export const DetailFrameContext = createContext<DetailFrame | null>(null);

/** The frame the open card stands in, if any. */
export function useDetailFrame(): DetailFrame | null {
  return useContext(DetailFrameContext);
}
