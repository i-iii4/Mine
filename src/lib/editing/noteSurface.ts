// Which surface the open card draws a note's body with (SPEC_EDITING.md, Л1,
// Л2): by the user's decision of 18.10.2026 on ЛВ1 the card opens straight in
// the editor, as in Obsidian, with no switch to a reading view. The reading
// mode stays for a body that cannot be edited. Before the editor asks the
// backend, two things keep it away: a collection page is never edited
// (Л2.5), and the feed's start of the body is no body to edit until the
// whole card has come (Л2.1). What the backend refuses (in iCloud, read-only,
// gone, a collection page after all) the editor learns from
// `begin_note_edit` and says in the tab's notice (Л2.8).

import type { CardKind } from "@/types";

/** Why a body stays in the reading mode before the backend is asked. */
export type ReadingReason =
  /** A collection page: never edited (Л2.5). */
  | "collection_page"
  /** The feed's start of the body: the editor waits for the whole card
   *  (Л2.1). */
  | "body_not_read"
  /** A check of the reading surface turned the editor off (the dev pages
   *  and tests of the reading mode); the app never does. */
  | "editing_off";

/** The surface of the open card's body. */
export type NoteSurface =
  | { kind: "editor" }
  | { kind: "reading"; reason: ReadingReason };

/** What the rule reads of the open card. */
export interface NoteSurfaceCard {
  card_kind: CardKind;
  /** The hash of the whole body read from the file; `null` or absent while
   *  the card is the feed's light one (Л2.1). */
  body_hash?: string | null;
}

/**
 * The surface of the body of `card`. Every card's body opens in the editor
 * (Л2.1: an article, a link with text, a post, a media card with text, a
 * note of Obsidian without properties), except a collection page's. A card
 * without a body to show (a link page, a lone picture, a file) has none to
 * draw in either surface; the open card does not ask.
 */
export function noteSurface(card: NoteSurfaceCard, editingOn = true): NoteSurface {
  if (!editingOn) return { kind: "reading", reason: "editing_off" };
  if (card.card_kind === "channel") return { kind: "reading", reason: "collection_page" };
  if (!card.body_hash) return { kind: "reading", reason: "body_not_read" };
  return { kind: "editor" };
}
