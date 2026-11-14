// src/lib/motion.ts: the one reader of the motion setting and of the
// system's "Reduce motion" (SPEC_MOTION_LEVELS.md). The level in force stands
// as `data-motion` on the page's root, where global.css reads it; code that
// animates itself asks here, so a menu, a scroll, the image zoom and the
// card's window obey the same choice. The graph keeps the system's flag alone
// (УД9), the clipper follows only the system (УД10).

import { useSyncExternalStore } from "react";

/** Three sets of motion, each whole (SPEC_MOTION_LEVELS.md, «Режимы»; user's
 *  decision of 13.11.2026). What answers the pointer, the keyboard's focus
 *  and a drag moves the same in all three. A press or a command plays as it
 *  always did in Full; in Minimal its heavy motions, the flights and the
 *  springs, give way to one calm short one; at Off its result stands at
 *  once. */
export type MotionLevel = "full" | "minimal" | "off";

/** The levels, in the order Settings shows them. */
export const MOTION_LEVELS: readonly MotionLevel[] = ["full", "minimal", "off"];

/** Where the person's choice is kept (НС2). */
export const MOTION_LEVEL_STORAGE_KEY = "mine.motion";

/** The attribute that carries the level in force on a page's root, or on the
 *  clipper's top element inside its Shadow DOM (НС5, НС7). */
export const MOTION_LEVEL_ATTRIBUTE = "data-motion";

/** The clipper's own mark beside it (УД10): under the system's flag
 *  everything of the clipper's stands at once, as it always did, by the rule
 *  «At once» in global.css; an app page at Off has no such rule. */
export const MOTION_CLIPPER_ATTRIBUTE = "data-motion-clipper";

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
/** The curve of Отклик, E: small fades and what answers the pointer start at
 *  once. */
export const MOTION_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** The curve of Поверхность and of the small popups, menus and tooltips: a
 *  thing the size of a window, or a popup with a scale, comes and goes
 *  decelerating from a soft start. Material 3's standard easing. On E a third
 *  of a window's path fell into its first frame and its leaving read as a cut
 *  (SPEC_MOTION_LEVELS.md, «Основания значений»; user's report of
 *  14.11.2026). */
export const MOTION_SURFACE_EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** Поверхность, both ways, in Full and Minimal alike (РД2). */
export const MOTION_SURFACE_MS = 200;
/** Перемещение, both ways, in Full and Minimal alike (РД2). */
export const MOTION_MOVE_MS = 200;
/** A member of Пружина a press started, in Minimal: the calm move that
 *  stands in for its spring is Перемещение, its time on the move curve
 *  (РД4): one kind of motion, a thing carried across the page, one value. */
export const MOTION_SPRING_MOVE_MS = MOTION_MOVE_MS;
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
  root.setAttribute(MOTION_CLIPPER_ATTRIBUTE, "");
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

/** What started a motion (SPEC_MOTION_LEVELS.md, «Режимы»). `byKey`: a key's
 *  command, at once in every mode (УД4). `answers`: the motion answers the
 *  pointer over a thing, the keyboard's focus walking, or a drag in hand, and
 *  moves the same in every mode. Neither: a press or a command, which Off
 *  stands at once. */
export interface MotionOptions {
  byKey?: boolean;
  answers?: boolean;
}

/** How long a motion of `role` lasts (РД2): 0 by a key's command; its own
 *  time when it answers the pointer or the focus, in every mode; else its own
 *  time in Full and Minimal and 0 at Off. Перемещение has one time for both
 *  phases. */
export function roleMs(role: MotionRole, phase: MotionPhase, options: MotionOptions = {}): number {
  if (options.byKey) return 0;
  if (!options.answers && motionLevel() === "off") return 0;
  if (role === "response") return phase === "enter" ? MOTION_ENTER_MS : MOTION_EXIT_MS;
  return role === "surface" ? MOTION_SURFACE_MS : MOTION_MOVE_MS;
}

/** The role's curve, the same on every level (РД2). */
export function roleEasing(role: MotionRole): string {
  if (role === "move") return MOTION_MOVE_EASE;
  return role === "surface" ? MOTION_SURFACE_EASE : MOTION_EASE;
}

/** How a member of Пружина moves: its own spring, Перемещение, or at once. */
export type SpringMotion = "spring" | "move" | "instant";

/** How a member of Пружина moves (РД4): at once by a key's command; on its
 *  spring in every mode when it answers the pointer or the focus; else its
 *  spring in Full, a calm move of `MOTION_SPRING_MOVE_MS` in Minimal, at once
 *  at Off. */
export function springMotion(options: MotionOptions = {}): SpringMotion {
  if (options.byKey) return "instant";
  if (options.answers) return "spring";
  const level = motionLevel();
  if (level === "full") return "spring";
  return level === "minimal" ? "move" : "instant";
}

/** A programmatic scroll: at once by a key's command; smooth in every mode
 *  when it follows the keyboard's focus walking; else smooth in Full and
 *  Minimal, at once at Off («Программная прокрутка»). */
export function scrollBehavior(options: MotionOptions = {}): ScrollBehavior {
  if (options.byKey) return "auto";
  if (options.answers) return "smooth";
  return motionLevel() === "off" ? "auto" : "smooth";
}
