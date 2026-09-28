import { useEffect } from "react";

/**
 * Ends a drag whose release never arrived.
 *
 * A pointer drag ends when its button is released. WebKit sometimes keeps that
 * release from the page, for instance when its own native drag takes over an
 * image, so the app goes on believing a drag is under way: every collection
 * row then swallows its click and no sidebar preview opens, in the feed and in
 * an open card alike, until the app restarts.
 *
 * The primary button cannot be pressed again while a drag still holds it, so
 * a fresh press while a drag is recorded proves that drag is over. The press
 * cancels it (dnd-kit's own Escape handling, kept from reaching the app's
 * Escape shortcuts) and resets the app's drag state before the click that
 * follows, which then works as usual.
 */
export function useStaleDragRecovery(dragActive: boolean, resetDragState: () => void): void {
  useEffect(() => {
    if (!dragActive) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      cancelLibraryDrag();
      resetDragState();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [dragActive, resetDragState]);
}

/**
 * dnd-kit's pointer sensor listens on the document for Escape to cancel the
 * drag it owns. The synthetic key stops at the document, after that listener,
 * so the app's own Escape handling on the window never sees it.
 */
function cancelLibraryDrag(): void {
  const stopAtDocument = (event: Event) => event.stopPropagation();
  document.addEventListener("keydown", stopAtDocument);
  try {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  } finally {
    document.removeEventListener("keydown", stopAtDocument);
  }
}
