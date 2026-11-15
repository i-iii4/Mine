import { useCallback, useEffect, useRef } from "react";
import { dropCardsOnTabBar, reportCardDrag } from "@/lib/commands";
import { tabBarPointX } from "@/lib/cardTabDrop";
import { logTabBarFailure } from "@/lib/tabBarFailure";
import type { CardBarDrop } from "@/types";

/** What the page does with cards held over its window's tab bar. */
export interface CardDragToTabBar {
  /** Asked as the drag ends: the bar position the cards were let go at, or
   *  `null` when the pointer was not over the bar. A drop taken here leaves
   *  the room in the bar open for `dropOnBar` or `leaveBar`. */
  takeDrop: () => number | null;
  /** The cards land in the bar: a tab each at the slot under `drop.x`. */
  dropOnBar: (drop: CardBarDrop) => void;
  /** The room in the bar closes: the cards will not land now. */
  leaveBar: () => void;
}

function logFailure(error: unknown): void {
  logTabBarFailure("open the elements in new tabs", error);
}

/**
 * Cards dragged in this tab's page over its window's tab bar (SPEC_TABS.md,
 * В86).
 *
 * The bar is a page of its own above this one. A drag begun here keeps the
 * pointer while the button is down, above this page's top edge too, and the
 * bar hears nothing of it; so this page tells the backend where the pointer
 * is over the bar, and the backend tells this window's bar, which makes room
 * for the card's tab there. No other window's bar hears of it.
 *
 * `dragging` is a card drag under way, `title` the title of the card it
 * holds. A drag that ends without `takeDrop` taking it closes the room in the
 * bar. Every report is numbered, the drop too: the backend drops a late one
 * (В10).
 */
export function useCardDragToTabBar({
  enabled,
  dragging,
  title,
}: {
  enabled: boolean;
  dragging: boolean;
  title: string;
}): CardDragToTabBar {
  /** The bar position under the pointer now, `null` off the bar. */
  const overBar = useRef<number | null>(null);
  /** The room in the bar was handed on with a drop and is not closed here. */
  const taken = useRef(false);
  const titleRef = useRef(title);
  const seq = useRef(0);

  const report = useCallback((x: number | null) => {
    seq.current += 1;
    reportCardDrag(seq.current, x === null ? null : { x, title: titleRef.current }).catch(logFailure);
  }, []);

  useEffect(() => {
    titleRef.current = title;
    // A card read after the drag began names the room that is already open.
    if (overBar.current !== null) report(overBar.current);
  }, [report, title]);

  useEffect(() => {
    if (!enabled || !dragging) return;
    taken.current = false;
    const follow = (event: PointerEvent) => {
      const x = tabBarPointX(event.clientX, event.clientY, window.innerWidth);
      if (x === overBar.current) return;
      overBar.current = x;
      report(x);
    };
    // Capture on the window runs before the drag library's own listeners on
    // the document, so the release point is known when the drag ends.
    window.addEventListener("pointermove", follow, true);
    window.addEventListener("pointerup", follow, true);
    return () => {
      window.removeEventListener("pointermove", follow, true);
      window.removeEventListener("pointerup", follow, true);
      const left = overBar.current;
      overBar.current = null;
      if (left !== null && !taken.current) report(null);
    };
  }, [dragging, enabled, report]);

  const takeDrop = useCallback((): number | null => {
    const x = overBar.current;
    if (x === null) return null;
    taken.current = true;
    overBar.current = null;
    return x;
  }, []);

  const dropOnBar = useCallback((drop: CardBarDrop) => {
    seq.current += 1;
    dropCardsOnTabBar(seq.current, drop).catch(logFailure);
  }, []);

  const leaveBar = useCallback(() => report(null), [report]);

  return { takeDrop, dropOnBar, leaveBar };
}
