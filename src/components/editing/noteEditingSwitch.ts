// The one switch that puts the open card's article into the editor
// (SPEC_EDITING.md, Л1). The modes of row 50.12 (⌘E and `Edit`, by the user's
// decision ЛВ1) replace it; until then only a dev route or a test turns it
// on, and the app never does. It lives apart from the editor so that `Detail`
// reads it without taking CodeMirror into its part of the bundle (Л0.6).

import { createContext } from "react";

/** Whether the open card's article is shown in the editor. */
export const NoteEditingSwitch = createContext<boolean>(false);
