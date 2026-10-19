// Where a picture of the editor's widgets stands in the note (SPEC_EDITING.md,
// Л11.3, Л14): the host's picture asks it only when an action needs it
// (Remove from Element names the one `![` it removes, Г1.4), and it is
// counted then from the editor's document, never from a parse of the whole
// body on every keystroke. It lives apart from the editor so that `Detail`
// reads it without taking CodeMirror into its part of the bundle (Л0.6).

import { createContext } from "react";

/** A picture drawn in the editor: how many `![` stand before its own in the
 *  document now; `null` when it is no longer there. */
export interface EditorImagePlacement {
  occurrenceIndex(): number | null;
}

/** Set around the host's picture by the editor's widgets. */
export const EditorImagePlacementContext = createContext<EditorImagePlacement | null>(null);

/** The prefix of a picture's source: `![…](…)` and `![[…]]` alike. */
const IMAGE_OPENER = "![";

/** How many `![` stand in `text` before `position`, where one must start;
 *  `null` when none starts there. The core counts the same way in the body
 *  as written (`inlineMediaOccurrenceIndex`). */
export function imageOccurrenceBefore(text: string, position: number): number | null {
  if (!text.startsWith(IMAGE_OPENER, position)) return null;
  let count = 0;
  for (
    let index = text.indexOf(IMAGE_OPENER);
    index !== -1 && index < position;
    index = text.indexOf(IMAGE_OPENER, index + IMAGE_OPENER.length)
  ) {
    count += 1;
  }
  return count;
}
