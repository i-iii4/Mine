// This page as one tab among many (SPEC_TABS.md).
//
// Every tab is its own page of index.html. The backend tells the page which
// tab it is, what it remembers and whether it leads its space; the page
// reports back what it shows. Everything here is the page's side of that
// contract; the commands themselves live in commands.ts.

import type { MainViewMode, SidebarLayout, TabLocation, TabView } from "@/types";

/** At most one memory report per this many milliseconds (В31). */
export const TAB_VIEW_REPORT_DEBOUNCE_MS = 250;

/** This tab started or stopped leading its space (В19, В20). */
export const SPACE_LEAD_CHANGED_EVENT = "space-lead-changed";
/** The person came back to the app: catch up with the disk, once per space (В42). */
export const TAB_REFRESH_REQUESTED_EVENT = "tab-refresh-requested";
/** This tab's space was forgotten: the tab chooses a space again (В70). */
export const TAB_SPACE_FORGOTTEN_EVENT = "tab-space-forgotten";
/** The space was opened from outside and this tab shows it: go to Everything (В72). */
export const TAB_GO_EVERYTHING_EVENT = "tab-go-everything";
/** The sidebar of this tab's window changed (В56). */
export const WINDOW_SIDEBAR_CHANGED_EVENT = "window-sidebar-changed";

/** Whether two memories of a tab say the same thing. */
export function sameTabView(left: TabView, right: TabView): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The route of a place in the space. */
export function tabLocationPath(location: TabLocation): string {
  return location.kind === "collection"
    ? `/channel/${encodeURIComponent(location.tag)}`
    : "/";
}

/** The place in the space of the collection `tag`, or Everything. */
export function tabLocationOf(tag: string | undefined): TabLocation {
  return tag === undefined ? { kind: "everything" } : { kind: "collection", tag };
}

export interface TabViewReporter {
  /** The view may have changed: report it within the interval. */
  schedule: () => void;
  /** Report the current view now, if it changed since the last report. */
  flush: () => void;
  /** Stop: nothing scheduled is sent. */
  dispose: () => void;
}

/**
 * Report the tab's memory at most once per `intervalMs` (В31). Changes inside
 * the interval collapse into one report of the latest view, sent when the
 * interval ends, so a long scroll still reports while it goes. A view equal
 * to the last one reported is not sent again.
 */
export function createTabViewReporter({
  read,
  send,
  lastReported,
  intervalMs = TAB_VIEW_REPORT_DEBOUNCE_MS,
}: {
  read: () => TabView;
  send: (view: TabView) => Promise<void>;
  /** What the backend already holds for this tab; null when unknown, so the
   *  first report goes out whatever it says. */
  lastReported: TabView | null;
  intervalMs?: number;
}): TabViewReporter {
  let last = lastReported;
  let timer: number | null = null;
  let disposed = false;

  const flush = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (disposed) return;
    const view = read();
    if (last !== null && sameTabView(view, last)) return;
    last = view;
    void send(view).catch((error: unknown) => {
      console.error("Could not report the tab's view:", error);
    });
  };

  return {
    schedule: () => {
      if (disposed || timer !== null) return;
      timer = window.setTimeout(flush, intervalMs);
    },
    flush,
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

const LEGACY_MAIN_VIEW_MODE_KEY = "mine.mainViewMode";
const LEGACY_SIDEBAR_KEYS = ["mine:sidebar", "arena:sidebar"] as const;
/// Written by every collection pick and read by nothing (В79).
const LEGACY_RECENT_TAGS_KEYS = ["mine:recentTags", "arena:recentTags"] as const;

/** What the app kept in localStorage before a tab and a window owned it. */
export interface LegacyTabState {
  mode: MainViewMode | null;
  sidebar: SidebarLayout | null;
}

function parseLegacySidebar(raw: string): SidebarLayout | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const width = "width" in parsed ? parsed.width : undefined;
    const collapsed = "collapsed" in parsed ? parsed.collapsed : undefined;
    if (typeof width !== "number" || !Number.isFinite(width) || typeof collapsed !== "boolean") {
      return null;
    }
    return { width_px: Math.max(0, Math.round(width)), collapsed };
  } catch (error) {
    console.warn("Ignoring an unreadable stored sidebar:", error);
    return null;
  }
}

/**
 * Read what localStorage kept for the main view and the sidebar, and delete
 * those keys along with the recent collections nobody reads (В79). Every
 * page deletes them, so the first one takes them and the rest find nothing.
 * The values apply only on a launch that read no saved windows
 * (`TabBootstrap.fresh_start`); the caller decides.
 */
export function takeLegacyTabState(storage: Storage = window.localStorage): LegacyTabState {
  try {
    const storedMode = storage.getItem(LEGACY_MAIN_VIEW_MODE_KEY);
    const mode: MainViewMode | null = storedMode === "graph" || storedMode === "grid" ? storedMode : null;
    let sidebar: SidebarLayout | null = null;
    for (const key of LEGACY_SIDEBAR_KEYS) {
      const raw = storage.getItem(key);
      if (raw !== null && sidebar === null) sidebar = parseLegacySidebar(raw);
    }
    for (const key of [LEGACY_MAIN_VIEW_MODE_KEY, ...LEGACY_SIDEBAR_KEYS, ...LEGACY_RECENT_TAGS_KEYS]) {
      storage.removeItem(key);
    }
    return { mode, sidebar };
  } catch (error) {
    console.warn("Could not read the stored view before tabs:", error);
    return { mode: null, sidebar: null };
  }
}

/** Run `callback` once the frame after the next one is drawn: the first
 *  frame commits what React rendered, the second shows it painted (В5). */
export function afterTwoFrames(callback: () => void): () => void {
  let second: number | null = null;
  const first = window.requestAnimationFrame(() => {
    second = window.requestAnimationFrame(() => {
      second = null;
      callback();
    });
  });
  return () => {
    window.cancelAnimationFrame(first);
    if (second !== null) window.cancelAnimationFrame(second);
  };
}
