import { useCallback, useEffect, useRef, useState } from "react";
import { beginCardDrag, endCardDrag, updateCardDrag } from "@/lib/commands";
import { listenPage } from "@/lib/pageEvents";
import { logTabBarFailure } from "@/lib/tabBarFailure";
import type { CardDragViewShown, CardStack, TabView } from "@/types";

/** The backend's word that the dragged card is drawn outside (`DRAG_VIEW_EVENT`). */
export const CARD_DRAG_VIEW_EVENT = "card-drag-view";

/** What the page drags, as the backend needs it. */
export interface CardDragAcrossInput {
  /** This page's count of its drags: a new one is a new drag. */
  drag: number;
  title: string;
  views: TabView[];
  slugs: string[];
  /// Taken from a thumbnail of the sidebar: the feed of an open collection
  /// takes it, in this window and another.
  thumbnail: boolean;
  confirm: boolean;
  /** The card as the outside window draws it; `null` until the page has it. */
  stack: CardStack | null;
}

/** What the page does with cards dragged past its own edges. */
export interface CardDragAcross {
  /** Asked as the drag ends: the button went up outside this page, over its
   *  window's bar, another window or none. The backend took that drop; the
   *  page's own targets take nothing. */
  releasedOutside: () => boolean;
  /** The dragged card is drawn in the outside window: the page's own goes
   *  unseen (SPEC_OUTSIDE_WINDOW.md, ПК2). */
  shownOutside: boolean;
}

function logFailure(error: unknown): void {
  logTabBarFailure("drag the elements past the window", error);
}

/**
 * Cards dragged in this tab's page past its edges (SPEC_OUTSIDE_WINDOW.md,
 * ПК1 to ПК8; SPEC_TABS.md, В86).
 *
 * The page owns the drag. As it begins the backend hears what is dragged and
 * follows the pointer over every window until the button goes up: it draws
 * the card outside, tells the bar or another window's page under the pointer,
 * and lands the cards where they are let go. This page hears that the card is
 * drawn outside, and tells the backend what came of the card after the drag
 * began (its title and look once read) and that the drag ended. Every report
 * is numbered, above the one before: calls may arrive out of order (В10).
 */
export function useCardDragAcrossWindows({
  enabled,
  drag,
}: {
  enabled: boolean;
  drag: CardDragAcrossInput | null;
}): CardDragAcross {
  const seq = useRef(0);
  /** The report that began the running drag, or `null` with none. */
  const begun = useRef<number | null>(null);
  const latest = useRef(drag);
  latest.current = drag;
  const released = useRef<{ x: number; y: number } | null>(null);
  /** What the backend has of the running drag: its title, and its look. */
  const told = useRef<{ title: string; stack: boolean }>({ title: "", stack: false });
  const [shownOutside, setShownOutside] = useState(false);

  const running = enabled && drag !== null ? drag.drag : null;

  useEffect(() => {
    if (running === null) return;
    const input = latest.current;
    if (!input) return;
    seq.current += 1;
    begun.current = seq.current;
    released.current = null;
    told.current = { title: input.title, stack: input.stack !== null };
    beginCardDrag(seq.current, {
      title: input.title,
      views: input.views,
      slugs: input.slugs,
      thumbnail: input.thumbnail,
      confirm: input.confirm,
      stack: input.stack,
    }).catch(logFailure);
    const release = (event: PointerEvent) => {
      released.current = { x: event.clientX, y: event.clientY };
    };
    // Capture on the window runs before the drag library's own listeners on
    // the document, so the release point is known when the drag ends.
    window.addEventListener("pointerup", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      begun.current = null;
      setShownOutside(false);
      seq.current += 1;
      endCardDrag(seq.current).catch(logFailure);
    };
  }, [running]);

  // A card read after the drag began: its title, and its look for outside.
  const title = drag?.title ?? "";
  const hasStack = drag?.stack != null;
  useEffect(() => {
    const input = latest.current;
    if (running === null || begun.current === null || !input) return;
    const sent = told.current;
    if (input.title === sent.title && (sent.stack || input.stack === null)) return;
    told.current = { title: input.title, stack: sent.stack || input.stack !== null };
    seq.current += 1;
    updateCardDrag(seq.current, { title: input.title, stack: input.stack }).catch(logFailure);
  }, [hasStack, running, title]);

  useEffect(() => {
    if (!enabled) return;
    const subscription = listenPage<CardDragViewShown>(CARD_DRAG_VIEW_EVENT, (event) => {
      const first = begun.current;
      if (first !== null && event.payload.seq >= first) setShownOutside(true);
    }).catch(() => null);
    return () => {
      void subscription.then((unlisten) => unlisten?.());
    };
  }, [enabled]);

  const releasedOutside = useCallback((): boolean => {
    const point = released.current;
    if (point === null) return false;
    return point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight;
  }, []);

  return { releasedOutside, shownOutside };
}
