// TRIAL (PLAN 50.38, user's requests of 22.10.2026): the compact sidebar
// item's stack in the Display panel. Its size, Standard (32px cards 8px
// inside the item, today's) or Large (40px cards 4px inside it); its cards'
// edge, Shadow (today's `shadow-sm`) or Ring (no shadow, a 1px ring of the
// item's fill outside the buttons' edge); and the sidebar thumbnails'
// corners, Square or Rounded. Its side follows the sidebar's columns: before the name when the
// previews stand before it (sidebarColumnLayout.ts). Each kept between
// launches in its own localStorage key; every tab applies them and hears
// `settings-changed`. Once the user decides, this module either goes or the
// chosen stack becomes the rule.

import { useSyncExternalStore } from "react";
import { CHANNEL_ICON_CARD_PX, CHANNEL_ICON_LARGE_CARD_PX } from "./channelIcon";

/** One choice on trial: kept, put on the root, heard by React. */
function trialChoice<T extends string>(key: string, fallback: T, choices: readonly T[], apply: (value: T) => void) {
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

/** The two sizes on trial. */
export type CompactStack = "standard" | "large";
export const COMPACT_STACK_CHOICES: readonly CompactStack[] = ["standard", "large"];
export const COMPACT_STACK_STORAGE_KEY = "mine.sidebar.compactStack";
/** What the Display panel calls each size. */
export const COMPACT_STACK_LABELS: Record<CompactStack, string> = { standard: "Standard", large: "Large" };
/** The card side of each size. */
export const COMPACT_STACK_CARD_PX: Record<CompactStack, number> = {
  standard: CHANNEL_ICON_CARD_PX,
  large: CHANNEL_ICON_LARGE_CARD_PX,
};

// The root's mark gives the large stack its 4px insets (global.css).
const size = trialChoice<CompactStack>(COMPACT_STACK_STORAGE_KEY, "standard", COMPACT_STACK_CHOICES, (value) =>
  rootFlag("data-sidebar-stack-large", value === "large"));

export const getCompactStack = size.get;
export const setCompactStack = size.set;
export const reloadCompactStack = size.reload;
export const useCompactStack = size.use;

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

/** The sidebar thumbnails' corners on trial, the table's strip and the
 *  compact stack alike: Square (today's) or Rounded (the buttons' 3px,
 *  `--radius-1`). */
export type ThumbCorners = "square" | "rounded";
export const THUMB_CORNERS: readonly ThumbCorners[] = ["square", "rounded"];
export const THUMB_CORNERS_STORAGE_KEY = "mine.sidebar.thumbCorners";
/** What the Display panel calls each choice. */
export const THUMB_CORNERS_LABELS: Record<ThumbCorners, string> = { square: "Square", rounded: "Rounded" };

// The root's mark rounds every sidebar thumbnail (global.css, «Thumbnail edge»).
const corners = trialChoice<ThumbCorners>(THUMB_CORNERS_STORAGE_KEY, "square", THUMB_CORNERS, (value) =>
  rootFlag("data-sidebar-thumbs-rounded", value === "rounded"));

export const getThumbCorners = corners.get;
export const setThumbCorners = corners.set;
export const reloadThumbCorners = corners.reload;
export const useThumbCorners = corners.use;

/** The sidebar's look on trial: Table (today's rows, previews and counts) or
 *  List (the collections' names alone, muted, lit under the pointer, the
 *  open one with a dot after it). */
export type SidebarStyle = "table" | "list";
export const SIDEBAR_STYLES: readonly SidebarStyle[] = ["table", "list"];
export const SIDEBAR_STYLE_STORAGE_KEY = "mine.sidebar.style";
/** What the Display panel calls each look. */
export const SIDEBAR_STYLE_LABELS: Record<SidebarStyle, string> = { table: "Table", list: "List" };

// The root's mark gives the sidebar the list's look (global.css, «List sidebar»).
const look = trialChoice<SidebarStyle>(SIDEBAR_STYLE_STORAGE_KEY, "table", SIDEBAR_STYLES, (value) =>
  rootFlag("data-sidebar-list", value === "list"));

export const getSidebarStyle = look.get;
export const setSidebarStyle = look.set;
export const reloadSidebarStyle = look.reload;
export const useSidebarStyle = look.use;
