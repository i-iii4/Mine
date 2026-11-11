// What the top row over the feed names (DESIGN_SYSTEM.md, «Верхние ряды»,
// «Одно название в ряду»; SPEC_NARROW_WINDOW.md, У12, У15; SPEC_CARD_PEEK.md,
// О5; user's decision of 11.11.2026). The row names one place, the one the
// person is in. With the sidebar open beside the feed the sidebar names the
// space and the place too, and the row reads as before: the space's segment
// over the sidebar, then the place's name, or an open card's name full page.
// With the sidebar hidden (collapsed, or a narrow window where it lies over
// the feed, open or closed) the row has no segment: with no card open only
// the place's name, with a card open full page only the card's name with its
// menu and close button, and under the card's window neither name. The
// place's name and a card's name never stand in the row together, so no
// line parts them.

/** Where the sidebar stands for the top row: open beside the feed, or hidden
 *  (collapsed, or in a narrow window, over the feed or closed). The sidebar
 *  shown for the keyboard (SPEC_KEYBOARD.md, М8) stands beside the feed. */
export type TopRowSidebar = "beside" | "hidden";

/** How the open card stands: none open, full page (through its name's exit
 *  from the row), or in its window over the right part (until the window
 *  begins to close, SPEC_CARD_PEEK.md, О5). */
export type TopRowCardView = "none" | "full" | "window";

/** Whether the place's name stands in the top row: with no card open always;
 *  under the card's window only beside the open sidebar; with a card full
 *  page never, its name takes the place's room. */
export function topRowShowsPlace({
  sidebar,
  card,
}: {
  sidebar: TopRowSidebar;
  card: TopRowCardView;
}): boolean {
  if (card === "none") return true;
  return card === "window" && sidebar === "beside";
}

/** The open card the top row shows (SPEC_CARD_PEEK.md, О5): none while the
 *  card stands in its window over the right part, whose header names it;
 *  full page, the card itself. */
export function topRowCard<T>(card: T | null, cardView: "full" | "peek"): T | null {
  return cardView === "peek" ? null : card;
}
