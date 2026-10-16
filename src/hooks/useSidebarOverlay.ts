// The sidebar over the feed in a narrow window (SPEC_NARROW_WINDOW.md, У4 по
// У8; PLAN 47.3b, 47.3c).
//
// Below the narrowest sidebar beside the narrowest feed the sidebar leaves the
// row: the feed takes the whole window and the sidebar lies over it when
// opened. Whether it is open belongs to the page alone, never to windows.json:
// it is closed at every start, when the tab is hidden and when the window
// narrows into this mode (У7, У8). The backend keeps a mirror for the tab
// bar's button and the View menu (`report_sidebar_overlay`) and, while the
// sidebar lies over the feed, hands the page every toggle and swipe as
// `sidebar-overlay-command` instead of storing `collapsed` (У4).

import { useCallback, useEffect, useRef, useState } from "react";
import { reportSidebarOverlay } from "@/lib/commands";
import { listenPage } from "@/lib/pageEvents";
import { sidebarOverlaid } from "@/lib/sidebarPlacement";
import { useTabVisible } from "@/lib/tabVisibility";
import type { SidebarIntent, SidebarOverlay } from "@/types";

/** The backend hands this tab a toggle or a swipe for its sidebar over the
 *  feed (domain/windows.rs `SidebarIntent`). */
export const SIDEBAR_OVERLAY_COMMAND_EVENT = "sidebar-overlay-command";

/** What `useSidebarOverlay` gives the page. */
export interface SidebarOverlayControls {
  /** The window is too narrow for the sidebar beside the feed (У1). */
  narrow: boolean;
  /** The sidebar lies over the feed. Never true outside `narrow`. */
  open: boolean;
  /** Open the sidebar over the feed. Outside `narrow` it does nothing. */
  openOverlay: () => void;
  /** Close it. */
  close: () => void;
  /** Open it when closed, close it when open. */
  toggle: () => void;
}

export interface UseSidebarOverlayOptions {
  /** The page is a tab: it reports to the backend and hears its commands. */
  tab: boolean;
  /** The window widened past the threshold while the sidebar lay over the
   *  feed: the sidebar stands beside the feed now and must be shown there
   *  (У7). */
  onWidenWhileOpen: () => void;
  /** A command that came while the window was no longer narrow: the mirror
   *  lagged the page, and the intent is the sidebar's beside the feed. */
  onBesideIntent: (intent: SidebarIntent) => void;
}

function narrowNow(): boolean {
  return typeof window !== "undefined" && sidebarOverlaid(window.innerWidth);
}

/** What the backend's mirror should say (domain/windows.rs `SidebarOverlay`). */
export function sidebarOverlayReport(narrow: boolean, open: boolean): SidebarOverlay {
  if (!narrow) return "beside";
  return open ? "open" : "closed";
}

/** Whether the sidebar lies over the feed, and how to open and close it. */
export function useSidebarOverlay({
  tab,
  onWidenWhileOpen,
  onBesideIntent,
}: UseSidebarOverlayOptions): SidebarOverlayControls {
  const [narrow, setNarrow] = useState(narrowNow);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const visible = useTabVisible();
  const open = narrow && requestedOpen && visible;

  const openRef = useRef(open);
  openRef.current = open;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const onWidenRef = useRef(onWidenWhileOpen);
  onWidenRef.current = onWidenWhileOpen;
  const onBesideRef = useRef(onBesideIntent);
  onBesideRef.current = onBesideIntent;

  // The window crosses the threshold: narrowing, the sidebar comes over the
  // feed closed; widening with it open, it stands beside the feed, shown (У7).
  useEffect(() => {
    const follow = () => {
      const next = narrowNow();
      if (next === narrowRef.current) return;
      if (!next && openRef.current) onWidenRef.current();
      narrowRef.current = next;
      setRequestedOpen(false);
      setNarrow(next);
    };
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, []);

  // A hidden tab shows its sidebar over the feed closed when it comes back (У8).
  useEffect(() => {
    if (!visible) setRequestedOpen(false);
  }, [visible]);

  const openOverlay = useCallback(() => {
    if (narrowRef.current) setRequestedOpen(true);
  }, []);
  const close = useCallback(() => setRequestedOpen(false), []);
  const toggle = useCallback(() => {
    if (narrowRef.current) setRequestedOpen(!openRef.current);
  }, []);

  // The bar's button, the View menu, ⌃⌘S and the swipe, routed here by the
  // backend while the sidebar lies over the feed (У4, У6, У11).
  useEffect(() => {
    if (!tab) return undefined;
    let disposed = false;
    const unlisten = listenPage<SidebarIntent>(SIDEBAR_OVERLAY_COMMAND_EVENT, ({ payload }) => {
      if (disposed) return;
      if (!narrowRef.current) {
        onBesideRef.current(payload);
        return;
      }
      setRequestedOpen(payload.kind === "toggle" ? !openRef.current : payload.open);
    });
    unlisten.catch((error: unknown) => {
      console.error("Could not listen to the sidebar's commands:", error);
    });
    return () => {
      disposed = true;
      // A subscription that failed has nothing to stop; its failure is
      // logged above.
      void unlisten.then((stop) => stop(), () => undefined);
    };
  }, [tab]);

  // The mirror for the bar's button and the View menu (У4).
  const report = sidebarOverlayReport(narrow, open);
  useEffect(() => {
    if (!tab) return;
    void reportSidebarOverlay(report).catch((error: unknown) => {
      console.error("Could not report the sidebar over the feed:", error);
    });
  }, [report, tab]);
  // A page that leaves its space (the space picker, another space) has no
  // sidebar over the feed: the backend stores the toggles again.
  useEffect(() => {
    if (!tab) return undefined;
    return () => {
      void reportSidebarOverlay("beside").catch((error: unknown) => {
        console.error("Could not report the sidebar over the feed:", error);
      });
    };
  }, [tab]);

  return { narrow, open, openOverlay, close, toggle };
}
