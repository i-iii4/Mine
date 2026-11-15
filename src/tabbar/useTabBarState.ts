// What this window's tab bar shows, kept current from the backend
// (SPEC_TABS.md, В21, В56, В63, В86). Whether the visible tab's sidebar is shown
// comes in `tabbar-state` too: beside the feed or over it, only the backend
// and the page know (SPEC_NARROW_WINDOW.md, У4).
//
// Every subscription is this page's own (`getCurrentWebview().listen`): the
// backend addresses the bar by its page label, and the global `listen` or the
// window's handle are off limits in tab pages and bars (В22).

import { useEffect, useReducer } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getTabbarBootstrap } from "@/lib/commands";
import type { DropHover, TabBarState } from "@/types";

export const TABBAR_STATE_EVENT = "tabbar-state";
export const TABBAR_DROP_HOVER_EVENT = "tabbar-drop-hover";

/** Subscribe this page to `event`; returns the unsubscription, safe to call
 *  before the subscription has settled. */
export function listenHere<T>(event: string, handler: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  getCurrentWebview()
    .listen<T>(event, ({ payload }) => {
      if (!disposed) handler(payload);
    })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => {
      console.error(`Tab bar could not listen to ${event}:`, error);
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

interface BarModel {
  bar: TabBarState | null;
  /** An event already delivered a state; the start answer is older then. */
  live: boolean;
  /** What is held over the bar: a tab of another window (В63) or cards of
   *  this window's visible tab (В86). */
  dropHover: DropHover | null;
  /** Cards let go over the bar, until the backend says the drop is over (В86). */
  landing: DropHover | null;
}

type BarAction =
  | { kind: "bootstrap"; bar: TabBarState | null }
  | { kind: "state"; bar: TabBarState }
  | { kind: "drop-hover"; hover: DropHover };

function reduce(model: BarModel, action: BarAction): BarModel {
  switch (action.kind) {
    case "bootstrap":
      if (model.live || action.bar === null) return model;
      return { ...model, bar: action.bar };
    case "state":
      // The state after cards were let go brings their tabs: the gap they
      // land in goes in the same frame (В86).
      return {
        ...model,
        bar: action.bar,
        live: true,
        dropHover: model.landing === null ? model.dropHover : null,
      };
    case "drop-hover":
      if (action.hover.item.kind === "cards" && action.hover.item.dropped) {
        return { ...model, landing: action.hover };
      }
      // A report of the pointer that reached the backend after the drop
      // changes nothing; the end of the drop ends the landing.
      if (model.landing !== null && action.hover.item.kind === "cards" && action.hover.x !== null) {
        return model;
      }
      return { ...model, dropHover: action.hover.x === null ? null : action.hover, landing: null };
  }
}

const INITIAL: BarModel = { bar: null, live: false, dropHover: null, landing: null };

/** The bar's state, what is held over it, and cards let go over it. */
export function useTabBarState(): {
  bar: TabBarState | null;
  dropHover: DropHover | null;
  landing: DropHover | null;
} {
  const [model, dispatch] = useReducer(reduce, INITIAL);

  useEffect(() => {
    let cancelled = false;
    // Subscribe first: a change between the start answer and the
    // subscription would otherwise be lost.
    const stops = [
      listenHere<TabBarState>(TABBAR_STATE_EVENT, (bar) => dispatch({ kind: "state", bar })),
      listenHere<DropHover>(TABBAR_DROP_HOVER_EVENT, (hover) => dispatch({ kind: "drop-hover", hover })),
    ];
    getTabbarBootstrap()
      .then((bar) => {
        if (!cancelled) dispatch({ kind: "bootstrap", bar });
      })
      .catch((error: unknown) => {
        console.error("Tab bar could not read its window:", error);
      });
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, []);

  return { bar: model.bar, dropHover: model.dropHover, landing: model.landing };
}
