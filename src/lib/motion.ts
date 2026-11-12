// src/lib/motion.ts: the one reader of the motion setting and of the
// system's "Reduce motion" (SPEC_MOTION_LEVELS.md). The level in force stands
// as `data-motion` on the page's root, where global.css reads it; code that
// animates itself asks here, so a menu, a scroll, the image zoom and the
// card's window obey the same choice. The graph keeps the system's flag alone
// (УД9), the clipper follows only the system (УД10).

import { useSyncExternalStore } from "react";

/** How the interface answers the pointer: as it moves today, by one short
 *  motion, or at once (SPEC_MOTION_LEVELS.md, УД1). */
export type MotionLevel = "full" | "minimal" | "off";

/** The levels, in the order Settings shows them. */
export const MOTION_LEVELS: readonly MotionLevel[] = ["full", "minimal", "off"];

/** Where the person's choice is kept (НС2). */
export const MOTION_LEVEL_STORAGE_KEY = "mine.motion";

/** The attribute that carries the level in force on a page's root, or on the
 *  clipper's top element inside its Shadow DOM (НС5, НС7). */
export const MOTION_LEVEL_ATTRIBUTE = "data-motion";

/** The tokens' values for code; global.css holds the same, a test keeps them
 *  equal («Величины»). An appearance and a move to a new state. */
export const MOTION_ENTER_MS = 150;
/** A leaving and a fade out. */
export const MOTION_EXIT_MS = 100;
/** Minimal's curve, E: the hover answers' and the top rows' curve. */
export const MOTION_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** The system's "Reduce motion". */
const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Whether this page follows the setting (an app page) or only the system
 *  (the clipper); none before either entry ran. */
type MotionMode = "app" | "clipper" | null;

let mode: MotionMode = null;
/** The person's choice this page holds: read from storage, or made here when
 *  storage would not take it (НС2). */
let choice: MotionLevel | null = null;
let current: MotionLevel = "full";
let systemListening = false;
const listeners = new Set<() => void>();

function systemQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCE_MOTION_QUERY);
}

/** The system's flag alone: the graph keeps its own branch (УД9). */
export function systemReducesMotion(): boolean {
  return systemQuery()?.matches ?? false;
}

function isMotionLevel(value: string | null): value is MotionLevel {
  return MOTION_LEVELS.some((level) => level === value);
}

/** The stored choice; none when the key is missing, holds another value, or
 *  storage cannot be read (НС2). */
function readStoredChoice(): MotionLevel | null {
  try {
    const stored = window.localStorage.getItem(MOTION_LEVEL_STORAGE_KEY);
    return isMotionLevel(stored) ? stored : null;
  } catch (error) {
    console.error("Failed to read the motion level:", error);
    return null;
  }
}

function writeAttribute(root: HTMLElement, level: MotionLevel): void {
  if (root.getAttribute(MOTION_LEVEL_ATTRIBUTE) !== level) root.setAttribute(MOTION_LEVEL_ATTRIBUTE, level);
}

/** Puts `next` in force: on the page's root, and to the subscribers when it
 *  changed. */
function publish(next: MotionLevel): void {
  const changed = next !== current;
  current = next;
  if (typeof document !== "undefined" && mode !== "clipper") writeAttribute(document.documentElement, next);
  if (!changed) return;
  for (const listener of listeners) listener();
}

/** The level an app page has: the choice, else the system's (НС3). */
function appLevel(): MotionLevel {
  if (choice !== null) return choice;
  return systemReducesMotion() ? "minimal" : "full";
}

function followSystemOnce(): void {
  if (systemListening) return;
  const query = systemQuery();
  if (!query || typeof query.addEventListener !== "function") return;
  systemListening = true;
  query.addEventListener("change", () => {
    if (mode === "app") publish(appLevel());
  });
}

/** The level in force: the stored choice, else the system's (Minimal under
 *  "Reduce motion", Full without it). Full before installation and outside a
 *  page. */
export function motionLevel(): MotionLevel {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React subscription to `motionLevel()`. */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribe, motionLevel, motionLevel);
}

/** The person's choice in Settings: stored, applied to this page. Storage
 *  that will not take it keeps the choice for this page's session (НС2). */
export function chooseMotionLevel(level: MotionLevel): void {
  if (mode === null) mode = "app";
  if (choice === level) return;
  choice = level;
  try {
    window.localStorage.setItem(MOTION_LEVEL_STORAGE_KEY, level);
  } catch (error) {
    console.error("Failed to store the motion level:", error);
  }
  publish(appLevel());
}

/** Re-read the stored choice: another window chose (`settings-changed`). */
export function reloadMotionLevel(): void {
  if (mode === null) mode = "app";
  choice = readStoredChoice();
  publish(appLevel());
}

/** An app page's entry: the level on its root before the first render, and
 *  the system's flag followed while no choice is stored. */
export function installMotionLevel(): void {
  mode = "app";
  choice = readStoredChoice();
  followSystemOnce();
  publish(appLevel());
}

/** The clipper's entry (УД10): Off under the system's flag, Full without it,
 *  on `root`; the stored key is never read. Returns the listener's removal. */
export function followSystemMotion(root: HTMLElement): () => void {
  mode = "clipper";
  const apply = () => {
    const level: MotionLevel = systemReducesMotion() ? "off" : "full";
    writeAttribute(root, level);
    publish(level);
  };
  apply();
  const query = systemQuery();
  if (!query || typeof query.addEventListener !== "function") return () => undefined;
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}

/** What a motion asks of the level: whether a key started it (УД4). */
export interface MotionOptions {
  byKey?: boolean;
}

/** How long a motion lasts at the level in force: Full `fullMs`, Minimal the
 *  lesser of it and the set's phase, Off 0; `byKey` gives 0 at every level
 *  (УД2, УД4). */
export function motionMs(fullMs: number, phase: "enter" | "exit", options: MotionOptions = {}): number {
  if (options.byKey) return 0;
  const level = motionLevel();
  if (level === "off") return 0;
  if (level === "full") return fullMs;
  return Math.min(fullMs, phase === "enter" ? MOTION_ENTER_MS : MOTION_EXIT_MS);
}

/** The curve of a motion whose time `motionMs` gave: its own in Full and
 *  where Minimal keeps its time, E where Minimal shortens it (УД2). */
export function motionEasing(fullMs: number, phase: "enter" | "exit", fullEasing: string): string {
  return motionLevel() === "minimal" && motionMs(fullMs, phase) !== fullMs ? MOTION_EASE : fullEasing;
}

/** A programmatic scroll: smooth only in Full and not by a key (УД4,
 *  «Программная прокрутка»). */
export function scrollBehavior(options: MotionOptions = {}): ScrollBehavior {
  return motionLevel() === "full" && !options.byKey ? "smooth" : "auto";
}
