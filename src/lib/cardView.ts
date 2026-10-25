// TRIAL (SPEC_CARD_PEEK.md, О1; user's requests of 23.10.2026): how an open
// card stands, chosen in the Display panel. Full page (today's: the whole
// right part) or Peek (a window over the right part, the feed blurred round
// it). Kept between launches in its own localStorage key; every tab and window
// re-reads it on `settings-changed`. A change applies from the next opening:
// an open card keeps the view it opened in. Once the user decides, this module
// either goes or the chosen view becomes the rule.

import { trialChoice } from "./compactStack";

/** The two views on trial. */
export type CardView = "full" | "peek";
export const CARD_VIEWS: readonly CardView[] = ["full", "peek"];
export const CARD_VIEW_STORAGE_KEY = "mine.detail.cardView";
/** What the Display panel calls each view. */
export const CARD_VIEW_LABELS: Record<CardView, string> = { full: "Full page", peek: "Peek" };

// Nothing on the root: the view is read when a card opens.
const view = trialChoice<CardView>(CARD_VIEW_STORAGE_KEY, "full", CARD_VIEWS, () => {});

export const getCardView = view.get;
export const setCardView = view.set;
export const reloadCardView = view.reload;
export const useCardView = view.use;

/** The view a card opening now takes: Peek only where the sidebar stands
 *  beside the feed; in a narrow window, where it lies over the feed
 *  (SPEC_NARROW_WINDOW.md, У1), every card opens full (О1). */
export function cardViewForOpening(chosen: CardView, narrow: boolean): CardView {
  return chosen === "peek" && !narrow ? "peek" : "full";
}

/** TRIAL (SPEC_CARD_PEEK.md, О3; user's request of 24.10.2026): the Peek
 *  window's width. Fit: no wider than the card, narrowed to its content when
 *  the panel goes under it. Fill: the right part less `M` on every side. */
export type PeekWidth = "fit" | "fill";
export const PEEK_WIDTHS: readonly PeekWidth[] = ["fit", "fill"];
export const PEEK_WIDTH_STORAGE_KEY = "mine.detail.peekWidth";
/** What the Display panel calls each width. */
export const PEEK_WIDTH_LABELS: Record<PeekWidth, string> = { fit: "Fit card", fill: "Fill" };

// Nothing on the root: the window reads it as it lays itself out.
const peekWidth = trialChoice<PeekWidth>(PEEK_WIDTH_STORAGE_KEY, "fit", PEEK_WIDTHS, () => {});

export const getPeekWidth = peekWidth.get;
export const setPeekWidth = peekWidth.set;
export const reloadPeekWidth = peekWidth.reload;
export const usePeekWidth = peekWidth.use;
