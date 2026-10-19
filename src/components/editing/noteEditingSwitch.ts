// Whether the open card may show its note in the editor (SPEC_EDITING.md, Л1).
// By the user's decision of 18.10.2026 on ЛВ1 the card opens straight in the
// editor, and the app never turns this off: there is no switch to a reading
// view. Which body opens in the editor is the rule of `noteSurface`
// (`src/lib/editing/noteSurface.ts`). Only the checks of the reading surface
// turn it off: the reading mode's browser check, the comparison of the
// widgets with the reading mode on `/__editing?editing=off`, and tests of the
// reading article. It lives apart from the editor so that `Detail` reads it
// without taking CodeMirror into its part of the bundle (Л0.6).

import { createContext } from "react";

/** Whether the open card's body may open in the editor: on, except where a
 *  check of the reading surface turns it off. */
export const NoteEditingSwitch = createContext<boolean>(true);
