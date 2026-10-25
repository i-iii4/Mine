// The sidebar over the feed in a narrow window (SPEC_NARROW_WINDOW.md, У4 по
// У7; PLAN 47.3c).
//
// A layer over the whole page, under the menus, dialogs, notifications and
// the drop zone: a scrim over all of it, the feed, the bottom bar and the
// 40 px strip at the right, and the sidebar's panel at the left. The panel
// starts where the sidebar beside the feed starts, its filter row in the top
// row's place and its list under it, and runs down to the window's bottom,
// over the bottom bar (user's decision of 16.10.2026, instead of the height
// of the sidebar beside the feed). Its width is the window less the strip.
//
// The scrim blurs and dims what lies under it by `backdrop-filter` alone
// (global.css, `.sidebar-overlay-scrim`). Its values are provisional: the dim,
// the blur and the shadow are chosen live with the user (PLAN 47.3d).
//
// Openness belongs to the page (`useSidebarOverlay`); this component only
// shows it. It moves in and out over 200 ms on the project's ease-out, at
// once with reduced motion (src/lib/motion.ts). While open the panel is a
// dialog: the page marks what lies under the scrim `inert`, the panel takes
// the focus unless something in it already has it, and the focus goes back
// where it was when the panel closes.

import { createContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isEditableKeyboardTarget } from "@/lib/keyboardTargets";
import { motionDuration } from "@/lib/motion";
import { sidebarOverlayWidthCss } from "@/lib/sidebarPlacement";

/** The width, as CSS, that lays out the sidebar's list standing in this
 *  panel, the panel's own; null beside the feed, where the sidebar's width
 *  does (sidebarWidth.ts). The width does not inherit, so the parts laid out
 *  by it take it from here. */
export const SidebarOverlayWidthContext = createContext<string | null>(null);

/** How long the sidebar takes to come over the feed or leave it. */
export const SIDEBAR_OVERLAY_MOTION_MS = 200;

/** Layers whose Escape is their own: menus, listboxes, the image preview. */
const LAYERS_WITH_THEIR_OWN_ESCAPE =
  "[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [data-image-preview-overlay]";

/** The panel's accessible name. */
export const SIDEBAR_OVERLAY_LABEL = "Sidebar";

export interface SidebarOverlayProps {
  /** The sidebar lies over the feed. */
  open: boolean;
  /** Close it: the scrim or the strip was pressed. */
  onClose: () => void;
  /** The panel's filter row, in the top row's place. */
  header: ReactNode;
  /** The sidebar's list. */
  children: ReactNode;
}

/** Whether an Escape at `target` is a field's, a menu's or another dialog's. */
function escapeBelongsElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (isEditableKeyboardTarget(target)) return true;
  if (target.closest(LAYERS_WITH_THEIR_OWN_ESCAPE) !== null) return true;
  const dialog = target.closest("[role='dialog'], [role='alertdialog']");
  return dialog !== null && !dialog.hasAttribute("data-sidebar-overlay-panel");
}

/** The sidebar over the feed: scrim, strip and panel. */
export function SidebarOverlay({ open, onClose, header, children }: SidebarOverlayProps) {
  // Mounted from the opening to the end of the closing's motion.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // In its open place: one frame after mounting, so the motion runs.
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    const duration = motionDuration(SIDEBAR_OVERLAY_MOTION_MS);
    if (duration === 0) {
      setMounted(false);
      return undefined;
    }
    const timer = setTimeout(() => setMounted(false), duration);
    return () => clearTimeout(timer);
  }, [open]);

  // Focus: in on opening, unless the page already put it in the panel (⇧⌘F
  // puts it in the filter); back where it was on closing.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (open) {
      if (!panel) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && !panel.contains(active)) {
        returnFocusRef.current = active;
      }
      if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
      return;
    }
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    const active = document.activeElement;
    const focusLeftWithPanel = active === null || active === document.body || (panel?.contains(active) ?? false);
    if (target?.isConnected && focusLeftWithPanel) target.focus({ preventScroll: true });
  }, [open]);

  // Escape closes the panel (У6). It is heard before the open card under
  // the panel hears it, and taken from it: the card stays open. A field, a
  // menu, a listbox or another dialog keeps its own Escape.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      if (escapeBelongsElsewhere(event.target)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose, open]);

  if (!mounted) return null;

  const width = sidebarOverlayWidthCss();
  const panelStyle: CSSProperties = { width };
  const state = open && entered ? "open" : "closed";

  return (
    <div
      className="absolute inset-0 z-30"
      data-sidebar-overlay=""
      data-state={state}
    >
      <div
        aria-hidden="true"
        className="modal-scrim sidebar-overlay-scrim absolute inset-0"
        data-sidebar-overlay-scrim=""
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={SIDEBAR_OVERLAY_LABEL}
        tabIndex={-1}
        className="sidebar-overlay-panel absolute inset-y-0 left-0 flex flex-col overflow-hidden bg-sidebar shadow-lg outline-none"
        style={panelStyle}
        data-sidebar-overlay-panel=""
      >
        {header}
        {/* A row, as the page's body is beside the feed: the sidebar's own
            box keeps its width and does not shrink, so in the panel's column
            it would take the height of its whole list, run past the panel
            over the bottom bar and never scroll. In a row it stretches to
            the height left under the filter row, and its list scrolls. */}
        <div className="flex min-h-0 flex-1" data-sidebar-overlay-body="">
          <SidebarOverlayWidthContext.Provider value={width}>{children}</SidebarOverlayWidthContext.Provider>
        </div>
      </div>
    </div>
  );
}
