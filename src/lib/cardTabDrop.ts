// Cards dragged from a tab's page onto its window's tab bar open in tabs of
// their own (SPEC_TABS.md, В86). Pure: the page feeds pointer positions and
// the dragged cards, these decide whether the pointer is over the bar and
// which tabs to ask for.

import { CONFIRM_CARD_TABS_FROM, TAB_BAR_HEIGHT_PX } from "@/tabbar/constants";

/** Where the pointer at page position (`clientX`, `clientY`) is over the
 *  window's tab bar, as an `x` from the bar's left edge; `null` off the bar.
 *  The bar is the row above the page across the window's whole width, and
 *  the page's left edge is the bar's (В3): while the button holds a drag
 *  begun in the page, the page goes on hearing the pointer there, above its
 *  own top edge. */
export function tabBarPointX(clientX: number, clientY: number, viewportWidth: number): number | null {
  if (clientY >= 0 || clientY < -TAB_BAR_HEIGHT_PX) return null;
  if (clientX < 0 || clientX > viewportWidth) return null;
  return clientX;
}

/** The dragged cards in the order their tabs take (В86, п. 5; decision of
 *  15.11.2026): the grabbed card first, on the placeholder's slot, its tab the
 *  one shown (`drop_cards_on_tab_bar` shows the first); the rest after it in the feed's order, and cards the feed does
 *  not hold after those, in their own order. */
export function cardTabsOrder(
  slugs: readonly string[],
  feedSlugs: readonly string[],
  grabbed: string,
): string[] {
  const position = new Map(feedSlugs.map((slug, index) => [slug, index]));
  const rest = [...new Set(slugs)]
    .filter((slug) => slug !== grabbed)
    .map((slug, index) => ({ slug, index, at: position.get(slug) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ slug }) => slug);
  return [grabbed, ...rest];
}

/** Whether a drop that opens `count` tabs asks `Open N tabs?` first (В86,
 *  п. 6): from `CONFIRM_CARD_TABS_FROM` on; fewer open at once. */
export function asksBeforeOpening(count: number): boolean {
  return count >= CONFIRM_CARD_TABS_FROM;
}
