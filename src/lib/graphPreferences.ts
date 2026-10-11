// Which extra links between cards the graph draws (SPEC_GRAPH_VIEW.md,
// «Панель графа»).
//
// One value for every tab and window, kept between launches in one object
// under one key. Two surfaces change it: the graph's Display panel in a tab
// and the Graph section of the Settings window. Both go through
// `setGraphPreference`, which stores the object, tells this page's readers at
// once and announces the change to the other windows; a window hearing that
// announcement adopts the value and calls `reloadGraphPreferences`.
//
// Collections and their membership edges are the graph's skeleton and always
// drawn: there is no preference for them. A stored `include_collections` from
// before 11.10.2026 is not read and is dropped by the next write.

import { useSyncExternalStore } from "react";
import { broadcastSettingsChange } from "@/lib/settingsChanged";

export const GRAPH_PREFERENCES_STORAGE_KEY = "mine.graphPreferences";

/** The links between cards the graph may leave out. */
export interface GraphPreferences {
  /** Body wikilinks between cards, and from a card to a collection page. */
  include_wikilinks: boolean;
  /** Related-note provenance links recorded by Mine. */
  include_related_notes: boolean;
}

export type GraphLinkPreference = keyof GraphPreferences;

export const DEFAULT_GRAPH_PREFERENCES: Readonly<GraphPreferences> = {
  include_wikilinks: true,
  include_related_notes: true,
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored preferences. A missing, damaged or partial value reads as the
 * defaults for whatever it lacks; fields that are not preferences any more
 * (`include_collections`) are not read.
 */
export function getStoredGraphPreferences(): GraphPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_GRAPH_PREFERENCES };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_GRAPH_PREFERENCES };
  }
  if (!raw) return { ...DEFAULT_GRAPH_PREFERENCES };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_GRAPH_PREFERENCES };
  }
  if (!isRecord(value)) return { ...DEFAULT_GRAPH_PREFERENCES };
  return {
    include_wikilinks: readBoolean(
      value.include_wikilinks,
      DEFAULT_GRAPH_PREFERENCES.include_wikilinks,
    ),
    include_related_notes: readBoolean(
      value.include_related_notes,
      DEFAULT_GRAPH_PREFERENCES.include_related_notes,
    ),
  };
}

function storeGraphPreferences(preferences: GraphPreferences): void {
  try {
    window.localStorage.setItem(
      GRAPH_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch (error) {
    // Unwritable storage (private mode, quota): the choice lasts this session.
    console.error("Failed to store graph preferences:", error);
  }
}

function samePreferences(left: GraphPreferences, right: GraphPreferences): boolean {
  return left.include_wikilinks === right.include_wikilinks
    && left.include_related_notes === right.include_related_notes;
}

let current: GraphPreferences = getStoredGraphPreferences();
const listeners = new Set<() => void>();

function publish(next: GraphPreferences) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** This page's current preferences. */
export function getGraphPreferences(): GraphPreferences {
  return current;
}

/** This page's current preferences, re-rendering on every change. */
export function useGraphPreferences(): GraphPreferences {
  return useSyncExternalStore(subscribe, getGraphPreferences, getGraphPreferences);
}

/**
 * Turn one kind of extra link on or off: stored, applied on this page at
 * once and announced to the other windows. Setting the value it already has
 * does nothing.
 */
export function setGraphPreference(key: GraphLinkPreference, value: boolean): void {
  if (current[key] === value) return;
  const next = { ...current, [key]: value };
  storeGraphPreferences(next);
  publish(next);
  broadcastSettingsChange(GRAPH_PREFERENCES_STORAGE_KEY);
}

/**
 * Re-read the stored preferences after another window changed them. An equal
 * value is not published, so this page's own announcement coming back to it
 * does not ask the graph for a new snapshot.
 */
export function reloadGraphPreferences(): void {
  const next = getStoredGraphPreferences();
  if (samePreferences(next, current)) return;
  publish(next);
}
