import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Set on a menu trigger while the pointer is within its box. */
export const POINTER_INSIDE_ATTRIBUTE = "data-pointer-inside";

interface PointerInsideTracker {
  /** The menu closed: keep following only until the pointer leaves. */
  release: () => void;
  stop: () => void;
}

function trackPointerInside(node: HTMLElement): PointerInsideTracker {
  const doc = node.ownerDocument;
  let released = false;

  const stop = () => {
    doc.removeEventListener("pointermove", handlePointer, true);
    doc.removeEventListener("pointerdown", handlePointer, true);
    doc.removeEventListener("pointerup", handlePointer, true);
    doc.removeEventListener("pointerout", handlePointerOut, true);
    node.removeAttribute(POINTER_INSIDE_ATTRIBUTE);
  };

  const set = (inside: boolean) => {
    node.toggleAttribute(POINTER_INSIDE_ATTRIBUTE, inside);
    if (!inside && released) stop();
  };

  function handlePointer(event: PointerEvent) {
    // A touch has no hover to keep.
    if (event.pointerType === "touch") {
      set(false);
      return;
    }
    const box = node.getBoundingClientRect();
    set(
      event.clientX >= box.left
        && event.clientX < box.right
        && event.clientY >= box.top
        && event.clientY < box.bottom,
    );
  }

  // The pointer left the page (into the tab bar, out of the window).
  function handlePointerOut(event: PointerEvent) {
    if (event.relatedTarget === null) set(false);
  }

  doc.addEventListener("pointermove", handlePointer, true);
  doc.addEventListener("pointerdown", handlePointer, true);
  doc.addEventListener("pointerup", handlePointer, true);
  doc.addEventListener("pointerout", handlePointerOut, true);
  // Opened by a click on the trigger, it is hovered now; opened from the
  // keyboard with the pointer elsewhere, it is not.
  node.toggleAttribute(POINTER_INSIDE_ATTRIBUTE, node.matches(":hover"));

  return {
    release: () => {
      released = true;
      if (!node.hasAttribute(POINTER_INSIDE_ATTRIBUTE)) stop();
    },
    stop,
  };
}

/**
 * Keeps a menu trigger's hover across its modal menu (DESIGN_SYSTEM.md,
 * «Нажатие»). While the menu is open Radix puts `pointer-events: none` on the
 * body, so the browser stops hit-testing the trigger: it is not `:hover`, and
 * the click on it that closes the menu lands on the page root. WebKit tests
 * hover again only on the release, so between the press and the release the
 * plate had neither the open state nor hover and went dark, then lit up.
 * Instead the pointer is followed by geometry: from the moment the menu
 * opens, document pointer events set `data-pointer-inside` on the trigger
 * while the pointer is within its box, and after the menu closes they keep
 * doing so until the pointer leaves it. Then the listeners go.
 */
export function useMenuTriggerPointerInside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  const trackerRef = useRef<PointerInsideTracker | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    trackerRef.current?.stop();
    const tracker = trackPointerInside(node);
    trackerRef.current = tracker;
    return () => tracker.release();
  }, [open, ref]);

  useEffect(() => () => trackerRef.current?.stop(), []);
}
