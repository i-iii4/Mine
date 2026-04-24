import { useEffect, useRef } from "react";
import { PopupApp } from "./PopupApp";

/**
 * Container for the in-page overlay version of the clipper.
 *
 * Position: fixed top-right. Width matches the detached popup (360px).
 * Border + shadow follow the design system for floating elements
 * (DESIGN_SYSTEM.md → "Всплывающие элементы").
 *
 * Close behaviour: click outside the overlay host — handled in
 * overlay-entry.tsx via a window-level capture-phase click listener.
 * No explicit close button.
 *
 * pointer-events: the shadow host has pointer-events:none so clicks on
 * the empty viewport pass through to the page. The OverlayShell root
 * div explicitly opts its subtree back IN via pointer-events-auto.
 *
 * Focus: on mount we pull keyboard focus into the overlay root via
 * tabindex=-1 + .focus(). Without this, the page keeps focus and Tab
 * advances page focusables instead of reaching our keydown handler in
 * PopupApp — users had to click the overlay once before Tab-cycling
 * between Content/Screenshot/Link worked. `preventScroll: true` avoids
 * jumping the page viewport.
 */
export function OverlayShell() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="pointer-events-auto fixed right-4 top-4 w-[360px] rounded-1 border border-border bg-background shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)] outline-none"
    >
      <PopupApp />
    </div>
  );
}
