// src/lib/motionInput.ts: which input, a key or the pointer, started what
// moves (SPEC_MOTION_LEVELS.md, УД4). A key's motion lands at once at every
// level; the pointer's goes by the level (motion.ts). The page remembers its
// last input, and a menu, a window, the search or a tooltip a key opened
// carries `data-motion-key` on its surface and its scrim while it is on the
// page, where global.css lands it at once. A key that starts closing a
// surface the pointer opened marks it the same way before the closing runs.
//
// This module reads no level: motion.ts is the one reader of the setting.

import { useCallback, useRef, type Ref } from "react";

/** What started a motion. */
export type MotionInput = "key" | "pointer";

/** A native menu item (Find Elements, Find Collections and the others)
 *  counts as a key: the page gets it as a command and cannot tell its
 *  shortcut from a choice by the pointer, and the shortcut is the ordinary
 *  way to it (УД4, п. 1; «Что требует согласия пользователя», п. 1). The one
 *  place this rule is written: every native command reaches the page through
 *  `noteNativeMenuCommand`. */
export const NATIVE_MENU_INPUT: MotionInput = "key";

/** The mark of a surface a key opened or started closing (УД4, «Признак
 *  клавиатуры в CSS»). */
export const MOTION_KEY_ATTRIBUTE = "data-motion-key";

/** Radix's open state on a surface and its scrim; a tooltip's open state is
 *  `delayed-open` or `instant-open`. */
const STATE_ATTRIBUTE = "data-state";
const CLOSED_STATE = "closed";

let last: MotionInput = "pointer";
let installs = 0;

/** The surfaces already followed: their opening is behind them. */
const followedSurfaces = new WeakSet<HTMLElement>();

/** Whether the last input of the page was a key. Never before
 *  `installMotionInput`: a page that does not follow the rule (the clipper,
 *  УД10) moves as the level says. */
export function lastInputIsKey(): boolean {
  return installs > 0 && last === "key";
}

/** A command of the native menu reached the page: it counts as
 *  `NATIVE_MENU_INPUT`. Called before the command acts; nothing on a page
 *  that did not install the rule. */
export function noteNativeMenuCommand(): void {
  if (installs > 0) last = NATIVE_MENU_INPUT;
}

/** Whether a native menu command moves as a key, for a motion that takes
 *  `byKey` from the command itself rather than from the last input (the
 *  sidebar's View menu item). */
export function nativeMenuCommandIsKey(): boolean {
  return NATIVE_MENU_INPUT === "key";
}

function noteKey(): void {
  last = "key";
}

function notePress(): void {
  last = "pointer";
}

/** A pointer that moved. WebKit also sends a move with no movement when the
 *  page changes under a still pointer, as a menu a key opened appears: that
 *  one is no input. */
function noteMove(event: PointerEvent): void {
  if (event.movementX === 0 && event.movementY === 0) return;
  last = "pointer";
}

/** An app page's entry: hears every key and every press or move of the
 *  pointer before anything takes it. A second call adds no second listener.
 *  Returns the removal; the last removal forgets the input. */
export function installMotionInput(target: Window = window): () => void {
  installs += 1;
  if (installs === 1) {
    target.addEventListener("keydown", noteKey, true);
    target.addEventListener("pointerdown", notePress, true);
    target.addEventListener("pointermove", noteMove, true);
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    installs -= 1;
    if (installs > 0) return;
    target.removeEventListener("keydown", noteKey, true);
    target.removeEventListener("pointerdown", notePress, true);
    target.removeEventListener("pointermove", noteMove, true);
    last = "pointer";
  };
}

function isOpen(element: HTMLElement): boolean {
  return element.getAttribute(STATE_ATTRIBUTE) !== CLOSED_STATE;
}

/**
 * Marks `surface` (a menu, a window, the search, a tooltip, their scrim) as
 * moved by a key while it is on the page (УД4, п. 3): when a key opened it,
 * and when a key starts closing it. A click closes a surface the pointer
 * opened by the level; a surface a key opened stays marked whatever closes
 * it. Opened again during its leaving, it is a new opening. Returns the
 * function that stops following.
 *
 * The closing mark may come a task after Radix sets `data-state="closed"`:
 * the surfaces move by CSS animations, and a running animation takes a new
 * duration at once.
 *
 * Followed again (a ref that React attaches anew when its callback changes),
 * a surface is not opened again: it keeps its mark as it stands.
 */
export function followMotionKey(surface: HTMLElement): () => void {
  if (!followedSurfaces.has(surface)) {
    followedSurfaces.add(surface);
    if (lastInputIsKey()) surface.setAttribute(MOTION_KEY_ATTRIBUTE, "");
  }
  let open = isOpen(surface);
  const view = surface.ownerDocument.defaultView;
  if (view === null || typeof view.MutationObserver !== "function") return () => undefined;
  const observer = new view.MutationObserver(() => {
    const nowOpen = isOpen(surface);
    if (nowOpen === open) return;
    open = nowOpen;
    if (nowOpen) surface.toggleAttribute(MOTION_KEY_ATTRIBUTE, lastInputIsKey());
    else if (lastInputIsKey()) surface.setAttribute(MOTION_KEY_ATTRIBUTE, "");
  });
  observer.observe(surface, { attributes: true, attributeFilter: [STATE_ATTRIBUTE] });
  return () => observer.disconnect();
}

/** A ref that follows its element with `followMotionKey` and passes it on
 *  to `ref`. Stable while `ref` is. */
export function useMotionKeyRef<T extends HTMLElement>(ref?: Ref<T>): (node: T | null) => void {
  const stopRef = useRef<(() => void) | null>(null);
  return useCallback(
    (node: T | null) => {
      stopRef.current?.();
      stopRef.current = node ? followMotionKey(node) : null;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
}
