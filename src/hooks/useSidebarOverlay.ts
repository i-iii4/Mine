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
  /** A key opened it, or closes it: it comes and goes at once on every level
   *  (SPEC_MOTION_LEVELS.md, УД4, С2). Opened by a key, it closes at once
   *  whatever closes it (УД4, п. 3). */
  byKey: boolean;
  /** Open the sidebar over the feed; `byKey`, a key did it. Outside `narrow`
   *  it does nothing. */
  openOverlay: (byKey?: boolean) => void;
  /** Close it; `byKey`, a key did it. */
  close: (byKey?: boolean) => void;
  /** Open it when closed, close it when open; `byKey`, a key did it. */
  toggle: (byKey?: boolean) => void;
}

export interface UseSidebarOverlayOptions {
  /** The page is a tab: it reports to the backend and hears its commands. */
  tab: boolean;
  /** The window widened past the threshold while the sidebar lay over the
   *  feed: the sidebar stands beside the feed now and must be shown there
   *  (У7). */
  onWidenWhileOpen: () => void;
  /** A command that came while the window was no longer narrow: the mirror
   *  lagged the page, or the sidebar beside the feed is shown for the keyboard
   *  and the mirror says so. The intent is the sidebar's beside the feed;
   *  `byKey`, the View menu sent it (SPEC_MOTION_LEVELS.md, УД4, п. 1). */
  onBesideIntent: (intent: SidebarIntent, byKey: boolean) => void;
  /** Whether the backend's command that just came was a key's, the View
   *  menu's, and forget it: the backend says so just before the command
   *  (`sidebar-key-command`). */
  takeKeyCommand?: () => boolean;
  /** The sidebar is on screen only because the keyboard opened it
   *  (SPEC_KEYBOARD.md, М8). */
  openedForKeyboard?: boolean;
}

function narrowNow(): boolean {
  return typeof window !== "undefined" && sidebarOverlaid(window.innerWidth);
}

/** What the backend's mirror should say (domain/windows.rs `SidebarOverlay`). A
 *  sidebar shown for the keyboard says open wherever it stands: it is on screen
 *  while what is stored says hidden, so the View item and the tab bar's button name
 *  it shown, and every toggle and swipe comes to the page and stores nothing
 *  (SPEC_KEYBOARD.md, М8). */
export function sidebarOverlayReport(narrow: boolean, open: boolean, openedForKeyboard = false): SidebarOverlay {
  if (openedForKeyboard) return "open";
  if (!narrow) return "beside";
  return open ? "open" : "closed";
}

/** Whether the sidebar lies over the feed, and how to open and close it. */
export function useSidebarOverlay({
  tab,
  onWidenWhileOpen,
  onBesideIntent,
  takeKeyCommand,
  openedForKeyboard = false,
}: UseSidebarOverlayOptions): SidebarOverlayControls {
  const [narrow, setNarrow] = useState(narrowNow);
  const [requestedOpen, setRequestedOpenState] = useState(false);
  const [byKey, setByKey] = useState(false);
  // An opening says how it came; a closing keeps a key's opening (УД4, п. 3).
  const setRequestedOpen = useCallback((next: boolean, nextByKey = false) => {
    setRequestedOpenState(next);
    setByKey((previous) => (next ? nextByKey : previous || nextByKey));
  }, []);
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
  const takeKeyCommandRef = useRef(takeKeyCommand);
  takeKeyCommandRef.current = takeKeyCommand;

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
    follow();
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [setRequestedOpen]);

  // A hidden tab shows its sidebar over the feed closed when it comes back (У8).
  useEffect(() => {
    if (!visible) setRequestedOpen(false);
  }, [setRequestedOpen, visible]);

  const openOverlay = useCallback((opensByKey = false) => {
    if (narrowRef.current) setRequestedOpen(true, opensByKey);
  }, [setRequestedOpen]);
  const close = useCallback((closesByKey = false) => setRequestedOpen(false, closesByKey), [setRequestedOpen]);
  const toggle = useCallback((togglesByKey = false) => {
    if (narrowRef.current) setRequestedOpen(!openRef.current, togglesByKey);
  }, [setRequestedOpen]);

  // The bar's button, the View menu, ⌃⌘S and the swipe, routed here by the
  // backend while the sidebar lies over the feed (У4, У6, У11).
  useEffect(() => {
    if (!tab) return undefined;
    let disposed = false;
    const unlisten = listenPage<SidebarIntent>(SIDEBAR_OVERLAY_COMMAND_EVENT, ({ payload }) => {
      if (disposed) return;
      const commandByKey = takeKeyCommandRef.current?.() ?? false;
      if (!narrowRef.current) {
        onBesideRef.current(payload, commandByKey);
        return;
      }
      setRequestedOpen(payload.kind === "toggle" ? !openRef.current : payload.open, commandByKey);
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
  }, [setRequestedOpen, tab]);

  // The mirror for the bar's button and the View menu (У4).
  // A hidden tab hears no toggle, and the backend closes its mirror when it hides
  // the tab; coming back, the report says open again.
  const report = sidebarOverlayReport(narrow, open, openedForKeyboard && visible);
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

  return { narrow, open, byKey, openOverlay, close, toggle };
}
