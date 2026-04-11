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
 */
export function OverlayShell() {
  return (
    <div className="pointer-events-auto fixed right-4 top-4 w-[360px] rounded-1 border border-border bg-background shadow-[0_4px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.4)]">
      <PopupApp />
    </div>
  );
}
