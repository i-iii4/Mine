// TRIAL (PLAN 50.38, user's requests of 22.10.2026): the compact sidebar
// item's stack in the Display panel: its cards' edge, Shadow (today's
// `shadow-sm`) or Ring (no shadow, a 1px ring of the item's fill outside the
// buttons' edge), at the right of the name. Each kept between
// launches in its own localStorage key; every tab applies them and hears
// `settings-changed`. Once the user decides, this module either goes or the
// chosen stack becomes the rule.

import { useSyncExternalStore } from "react";

/** One choice on trial: kept, put on the root, heard by React. The Display
 *  panel's other trials keep their choices the same way (cardView.ts). */
export function trialChoice<T extends string>(key: string, fallback: T, choices: readonly T[], apply: (value: T) => void) {
  const read = (): T => {
    try {
      const stored = window.localStorage.getItem(key);
      return choices.find((choice) => choice === stored) ?? fallback;
    } catch {
      return fallback;
    }
  };
  let current: T = typeof window === "undefined" ? fallback : read();
  const listeners = new Set<() => void>();
  const publish = (next: T) => {
    current = next;
    if (typeof document !== "undefined") apply(next);
    for (const listener of listeners) listener();
  };
  if (typeof document !== "undefined") apply(current);
  const get = () => current;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    get,
    set(next: T) {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Unwritable storage (private mode, quota): the choice lasts this session.
      }
      publish(next);
    },
    /** Re-read storage: another tab or window chose (`settings-changed`). */
    reload: () => publish(read()),
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}

function rootFlag(name: string, on: boolean) {
  document.documentElement.toggleAttribute(name, on);
}

/** The two edges on trial. */
export type CompactStackEdge = "shadow" | "ring";
export const COMPACT_STACK_EDGES: readonly CompactStackEdge[] = ["shadow", "ring"];
export const COMPACT_STACK_EDGE_STORAGE_KEY = "mine.sidebar.compactStackEdge";
/** What the Display panel calls each edge. */
export const COMPACT_STACK_EDGE_LABELS: Record<CompactStackEdge, string> = { shadow: "Shadow", ring: "Ring" };

// The root's mark swaps the cards' shadow for the ring (global.css).
const edge = trialChoice<CompactStackEdge>(COMPACT_STACK_EDGE_STORAGE_KEY, "shadow", COMPACT_STACK_EDGES, (value) =>
  rootFlag("data-sidebar-stack-ring", value === "ring"));

export const getCompactStackEdge = edge.get;
export const setCompactStackEdge = edge.set;
export const reloadCompactStackEdge = edge.reload;
export const useCompactStackEdge = edge.use;

/** The sidebar's look on trial: Table (today's rows, previews and counts) or
 *  List (the collections' names alone, muted, lit under the pointer, the
 *  open one with a dot after it). */
export type SidebarStyle = "table" | "list";
export const SIDEBAR_STYLES: readonly SidebarStyle[] = ["table", "list"];
export const SIDEBAR_STYLE_STORAGE_KEY = "mine.sidebar.style";
/** What the Display panel calls each look. */
export const SIDEBAR_STYLE_LABELS: Record<SidebarStyle, string> = { table: "Table", list: "List" };

// The root's mark gives the sidebar the list's look (global.css, «List sidebar»).
/** POSTPONED (user's decision of 23.10.2026): the narrow table with the
 *  stack of thumbnails and its settings are put aside while the List look is
 *  developed. Below the compact threshold the sidebar is always the List;
 *  the Table choice, the stack's edge and the rows' morph stay in the code,
 *  out of use, until the narrow table is taken up again. */
export const COMPACT_TABLE_POSTPONED = true;

const look = trialChoice<SidebarStyle>(SIDEBAR_STYLE_STORAGE_KEY, "table", SIDEBAR_STYLES, (value) =>
  rootFlag("data-sidebar-list", COMPACT_TABLE_POSTPONED || value === "list"));

export const getSidebarStyle = (): SidebarStyle => (COMPACT_TABLE_POSTPONED ? "list" : look.get());
export const setSidebarStyle = look.set;
export const reloadSidebarStyle = look.reload;
export const useSidebarStyle = look.use;

// List spacing and List style are fixed, Tight and Contents (user's decision
// of 15.11.2026): the List steps 24px and reads as a table of contents
// (global.css, «List sidebar»). Their stored choices are no longer read.
