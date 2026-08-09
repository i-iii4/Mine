import { useEffect, useRef } from "react";
import { DropdownMenuPortalContainerProvider } from "@/components/ui/dropdown-menu";
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
export function OverlayShell({ portalContainer }: { portalContainer: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <DropdownMenuPortalContainerProvider container={portalContainer}>
      <div
        ref={ref}
        data-mine-clipper-panel
        tabIndex={-1}
        // max-h pins the panel inside the viewport (16px top and bottom
        // margins); the flex column lets the elastic previews compress while
        // buttons, picker and the save stack keep their heights. overflow-auto
        // is the last-resort safety: below the sum of the hard minimums
        // (~430px, under any real browser window) the panel scrolls as a
        // whole instead of clipping. Shadow is the system floating-element
        // shadow, not a bespoke rgba.
        className="pointer-events-auto fixed right-4 top-4 flex max-h-[calc(100vh-32px)] w-[360px] flex-col overflow-y-auto rounded-1 border border-border bg-background shadow-md outline-none"
      >
        <PopupApp />
      </div>
    </DropdownMenuPortalContainerProvider>
  );
}
