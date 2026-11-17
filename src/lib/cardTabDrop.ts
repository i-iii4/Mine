// Cards dragged from a tab's page onto a tab bar open in tabs of their own
// (SPEC_TABS.md, В86): which tabs to ask for, and whether to ask first. Which
// bar is under the pointer the backend finds (SPEC_OUTSIDE_WINDOW.md, ПК4).

import { CONFIRM_CARD_TABS_FROM } from "@/tabbar/constants";

/** The dragged cards in the order their tabs take (В86, п. 5; decision of
 *  15.11.2026): the grabbed card first, on the placeholder's slot, its tab the
 *  one shown (the backend shows the first, `tabs::drag::land_cards`); the rest after it in the feed's order, and cards the feed does
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
