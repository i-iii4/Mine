// src/lib/menuBlink.ts: the blink of a chosen menu item (user's decision of
// 13.11.2026; DESIGN_SYSTEM.md, «Нажатие»; SPEC_MOTION_LEVELS.md, РД5). An
// item of a dropdown or a context menu chosen by the pointer, Enter or Space
// blinks once, as in the menus of macOS: its highlight goes out for the first
// half of `MOTION_MENU_BLINK_MS` and comes back for the second, then the menu
// closes and the item's command runs. It is a sign that the choice was taken,
// as the shake of a refused name is a refusal: no motion, outside the roles,
// the same on every level, Off included, and from the keyboard too. An item
// that keeps its menu open and shows the result in place (a check, a choice
// of a value), one that opens a submenu and a disabled one do not blink.
//
// The item keeps the menu open while it blinks (its select is prevented) and
// is chosen again once the blink is over, the way the menu chooses it, so the
// menu closes and the command runs as without the blink, exactly once: a
// second press or Enter during the blink chooses nothing.
//
// A row of a menu with a search field is not the menu's own item: the menu
// chooses it itself, by a press or by Enter in the field. Such a row blinks
// the same way through `useMenuRowBlink` (user's decision of 15.11.2026).

import { useCallback, useEffect, useRef, useState } from "react";
import { MOTION_MENU_BLINK_MS } from "./motion";

/** The attribute an item carries while its highlight is out (global.css). */
export const MENU_BLINK_ATTRIBUTE = "data-menu-blink";

let blinkMs: number = MOTION_MENU_BLINK_MS;

/** The blink's whole length: its highlight out for the first half, back for
 *  the second. */
export function menuBlinkMs(): number {
  return blinkMs;
}

/** Tests that are not about the blink choose an item at once: the shared
 *  test setup sets 0 and the blink's own tests put `MOTION_MENU_BLINK_MS`
 *  back. The app never calls it. */
export function setMenuBlinkMsForTests(ms: number): void {
  blinkMs = ms;
}

/** What the menu hands an item's select: a cancellable event whose target
 *  is the item. */
type MenuSelectEvent = Event;

interface Blink {
  /** `blinking` until the blink is over; `choosing` while the item is chosen
   *  again, the one select that passes through. */
  state: "blinking" | "choosing";
  timers: number[];
}

/** An item's select with its blink: `onSelect` runs once the blink is over,
 *  as the menu would run it; `off` is true while the highlight is out.
 *  `blinks` false (an item that keeps its menu open) passes the select
 *  through at once. */
export function useMenuItemBlink<E extends MenuSelectEvent>(
  onSelect: ((event: E) => void) | undefined,
  blinks: boolean,
): { onSelect: (event: E) => void; off: boolean } {
  const [off, setOff] = useState(false);
  const blinkRef = useRef<Blink | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => () => {
    for (const timer of blinkRef.current?.timers ?? []) window.clearTimeout(timer);
    blinkRef.current = null;
  }, []);

  const select = useCallback((event: E) => {
    const blink = blinkRef.current;
    if (blink?.state === "choosing") {
      // The item chosen again once its blink was over: the command runs and
      // the menu closes as the item's own select decides.
      blinkRef.current = null;
      onSelectRef.current?.(event);
      return;
    }
    if (blink?.state === "blinking") {
      // A second press or Enter during the blink chooses nothing.
      event.preventDefault();
      return;
    }
    const item = event.currentTarget;
    const ms = menuBlinkMs();
    if (!blinks || ms <= 0 || !(item instanceof HTMLElement)) {
      onSelectRef.current?.(event);
      return;
    }
    // The menu stays open while the item blinks.
    event.preventDefault();
    const next: Blink = { state: "blinking", timers: [] };
    next.timers.push(
      window.setTimeout(() => setOff(false), ms / 2),
      window.setTimeout(() => {
        if (blinkRef.current !== next) return;
        // The menu closed meanwhile (Escape, a press outside): nothing runs.
        if (!item.isConnected) {
          blinkRef.current = null;
          return;
        }
        next.state = "choosing";
        // Chosen the way the menu chooses an item: its own click path.
        item.click();
        if (blinkRef.current === next) blinkRef.current = null;
      }, ms),
    );
    blinkRef.current = next;
    setOff(true);
  }, [blinks]);

  return { onSelect: select, off };
}

/** The blink of a row the menu chooses itself: a row of a menu with a search
 *  field, which is not the menu's own item (user's decision of 15.11.2026).
 *  `choose` blinks the row `key` and runs `run` once the blink is over, the
 *  menu open meanwhile. `chosen` is that row for the whole blink: the menu
 *  lights it and no other, whatever the pointer or the arrows do meanwhile,
 *  so its highlight is back in the second half however it was chosen. `off`
 *  is true while its highlight is out, the first half. A second choice during
 *  the blink chooses nothing. `cancel` drops the blink and its command: the
 *  menu closed meanwhile (Escape, a press outside). `lit` and `outAt` say
 *  what a row shows: `lit(key, active)` is the row's own active state at
 *  rest and "is it the chosen row" during a blink; `outAt(key)` is the
 *  chosen row in the first half. The menus of spaces in the app and in the
 *  clipper both take their rows' state from here. */
export function useMenuRowBlink<K>(): {
  chosen: K | null;
  off: boolean;
  blinking: boolean;
  lit: (key: K, active: boolean) => boolean;
  outAt: (key: K) => boolean;
  choose: (key: K, run: () => void) => void;
  cancel: () => void;
} {
  const [blink, setBlink] = useState<{ key: K; off: boolean } | null>(null);
  const timersRef = useRef<number[] | null>(null);

  const cancel = useCallback(() => {
    const timers = timersRef.current;
    if (!timers) return;
    for (const timer of timers) window.clearTimeout(timer);
    timersRef.current = null;
    setBlink(null);
  }, []);

  useEffect(() => () => {
    for (const timer of timersRef.current ?? []) window.clearTimeout(timer);
    timersRef.current = null;
  }, []);

  const choose = useCallback((key: K, run: () => void) => {
    // A second press or Enter during the blink chooses nothing.
    if (timersRef.current) return;
    const ms = menuBlinkMs();
    if (ms <= 0) {
      run();
      return;
    }
    const timers = [
      window.setTimeout(() => setBlink({ key, off: false }), ms / 2),
      window.setTimeout(() => {
        if (timersRef.current !== timers) return;
        timersRef.current = null;
        setBlink(null);
        run();
      }, ms),
    ];
    timersRef.current = timers;
    setBlink({ key, off: true });
  }, []);

  const chosen = blink?.key ?? null;
  const off = blink?.off ?? false;
  const lit = (key: K, active: boolean): boolean => (blink === null ? active : blink.key === key);
  const outAt = (key: K): boolean => blink !== null && blink.off && blink.key === key;
  return { chosen, off, blinking: blink !== null, lit, outAt, choose, cancel };
}
