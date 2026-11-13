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
