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

/** The roles of motion (РД1). Пружина is asked of `springMotion`: in Full it
 *  keeps its own spring, in Minimal it moves as Перемещение. */
export type MotionRole = "response" | "surface" | "move";

/** A motion's phase: an appearance or a move to a new state, or a leaving. */
export type MotionPhase = "enter" | "exit";

/** The tokens' values for code; global.css holds the same, a test keeps them
 *  equal (РД2, РД8). Отклик on every level but Off: an appearance and a move
 *  to a new state. */
export const MOTION_ENTER_MS = 150;
/** Отклик: a leaving and a fade out. */
export const MOTION_EXIT_MS = 100;
/** The curve of Отклик and Поверхность, E. */
export const MOTION_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Поверхность in Full, both ways; Minimal gives it MOTION_ENTER_MS and
 *  MOTION_EXIT_MS (РД2). */
export const MOTION_SURFACE_MS = 200;
/** Перемещение in Full, both ways; Minimal gives it MOTION_ENTER_MS, and so
 *  to Пружина (РД2, РД4). */
export const MOTION_MOVE_MS = 200;
/** The curve of Перемещение, and of Пружина in Minimal. */
export const MOTION_MOVE_EASE = "cubic-bezier(0.37, 0, 0.63, 1)";
/** The blink of a chosen menu item: its highlight goes out for the first
 *  half and comes back for the second, then the menu closes and the item's
 *  command runs, as in the menus of macOS. A sign that the choice was taken,
 *  as the shake of a refused name is a refusal: no motion, outside the roles,
 *  the same on every level and from the keyboard (user's decision of
 *  13.11.2026; SPEC_MOTION_LEVELS.md, РД5). global.css holds the same as
 *  `--motion-menu-blink`. */
export const MOTION_MENU_BLINK_MS = 150;

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

/** How long a motion of `role` lasts at the level in force (РД2): Off 0, and
 *  0 at every level by a key (УД4). Перемещение has one time for both
 *  phases. */
export function roleMs(role: MotionRole, phase: MotionPhase, options: MotionOptions = {}): number {
  if (options.byKey) return 0;
  const level = motionLevel();
  if (level === "off") return 0;
  if (role === "response") return phase === "enter" ? MOTION_ENTER_MS : MOTION_EXIT_MS;
  if (level === "full") return role === "surface" ? MOTION_SURFACE_MS : MOTION_MOVE_MS;
  if (role === "move") return MOTION_ENTER_MS;
  return phase === "enter" ? MOTION_ENTER_MS : MOTION_EXIT_MS;
}

/** The role's curve, the same on every level (РД2). */
export function roleEasing(role: MotionRole): string {
  return role === "move" ? MOTION_MOVE_EASE : MOTION_EASE;
}

/** How a member of Пружина moves: its own spring, Перемещение, or at once. */
export type SpringMotion = "spring" | "move" | "instant";

/** How a member of Пружина moves (РД4): its spring in Full, Перемещение in
 *  Minimal, at once at Off and by a key. */
export function springMotion(options: MotionOptions = {}): SpringMotion {
  if (options.byKey) return "instant";
  const level = motionLevel();
  if (level === "full") return "spring";
  return level === "minimal" ? "move" : "instant";
}

/** A programmatic scroll: smooth only in Full and not by a key (УД4,
 *  «Программная прокрутка»). */
export function scrollBehavior(options: MotionOptions = {}): ScrollBehavior {
  return motionLevel() === "full" && !options.byKey ? "smooth" : "auto";
}
