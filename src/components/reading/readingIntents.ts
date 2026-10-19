// The reading mode carries out what an event on an element of the note means
// (SPEC_EDITING.md, Л11.1): the decision is `noteInteractionIntent`'s, shared
// with the editor; here every intent is either done by the action the
// element lends or refused with its reason. A new intent does not build until
// this switch says what the reading mode does with it.

import { noteInteractionIntent, type NoteElement, type NoteEvent, type NoteInteractionIntent } from "@/lib/reading/intents";

/** What an element of the article can do. An action an element does not
 *  lend is not carried out here, and its event keeps its default. */
export interface ReadingActions {
  /** A wikilink's target as written. */
  openNote?(target: string): void;
  /** An address outside the note. */
  openExternal?(href: string): void;
  /** A place in the article, the part of the link after `#`. */
  jumpToAnchor?(fragment: string): void;
  toggleTask?(): void;
  openImagePreview?(): void;
  openEmbed?(): void;
}

/** Carry out `intent` in the reading mode; whether it was done here. */
export function carryOutReadingIntent(intent: NoteInteractionIntent, actions: ReadingActions): boolean {
  switch (intent.kind) {
    case "OpenNote":
      if (!actions.openNote) return false;
      actions.openNote(intent.target);
      return true;
    case "OpenExternal":
      if (!actions.openExternal) return false;
      actions.openExternal(intent.href);
      return true;
    case "JumpToAnchor":
      if (!actions.jumpToAnchor) return false;
      actions.jumpToAnchor(intent.fragment);
      return true;
    case "ToggleTask":
      if (!actions.toggleTask) return false;
      actions.toggleTask();
      return true;
    case "OpenImagePreview":
      if (!actions.openImagePreview) return false;
      actions.openImagePreview();
      return true;
    case "OpenEmbed":
      if (!actions.openEmbed) return false;
      actions.openEmbed();
      return true;
    // The reading mode has no caret, chooses no block, shows no source and
    // edits no cell: these are the editor's alone.
    case "PlaceCaret":
    case "SelectBlock":
    case "RevealBlock":
    case "EnterTableCell":
    case "Nothing":
      return false;
    default: {
      const unhandled: never = intent;
      return unhandled;
    }
  }
}

/** Decide what `event` on `element` means in the reading mode and carry it
 *  out; whether it was done here. */
export function actOnReadingElement(element: NoteElement, event: NoteEvent, actions: ReadingActions): boolean {
  return carryOutReadingIntent(noteInteractionIntent({ surface: "reading", element, event }), actions);
}

/** The event a pointer click is: ⌘ or Ctrl held makes it a command click. */
export function clickEvent(event: { metaKey: boolean; ctrlKey: boolean }): NoteEvent {
  return event.metaKey || event.ctrlKey ? "command-click" : "click";
}
