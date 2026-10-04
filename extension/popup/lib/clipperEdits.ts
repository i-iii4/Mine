import { createContext } from "react";

/**
 * Whether the person changed the open clip: its title, collections, type,
 * space or screenshot. An overlay clipper with edits stays open on a click
 * outside it and is not replaced by a repeated launch without new material
 * (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч10, Ч11). The overlay owns one per editor
 * and reads it outside React; the editor only sets it.
 */
export interface ClipperEdits {
  changed: boolean;
}

export const ClipperEditsContext = createContext<ClipperEdits | null>(null);
