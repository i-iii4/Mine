// The one anatomy of a modal window (DESIGN_SYSTEM.md, «Окна»), shared by
// `Dialog` and `AlertDialog` so the two cannot drift apart again: one
// dimming, one surface, two widths by role, one header, one footer.

/** The scrim under a window: the one scrim every layer over the page shares
 *  (global.css, `.modal-scrim`; SPEC_COLOR_RULES.md, 3.9.1; user's decisions
 *  of 16.10.2026), the whole page of the tab blurred and dimmed by the
 *  canvas at 32 %. */
export const MODAL_OVERLAY_CLASS =
  "modal-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50"

/** A floating layer on `--popover`, held by its line and shadow
 *  (SPEC_COLOR_RULES.md, 3.3; K11), 16px off each edge of a narrow app
 *  window, the window field 24px (`--spacing-s4`), its parts 16px apart. Its
 *  width is its role's (`MODAL_WIDTH_CLASS`). */
export const MODAL_SURFACE_CLASS =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-[calc(100%-32px)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-1 border border-border p-6 shadow-lg duration-200 outline-none"

/** What a window holds sets its width. A question (a title, a description,
 *  the buttons; no field, list or preview) is 384px; a window with content
 *  (a field, a list, a preview) is 512px, as the column of the full-screen
 *  states. A call site names the role, never the pixels. */
export type ModalWidth = "question" | "content"

export const MODAL_WIDTH_CLASS: Record<ModalWidth, string> = {
  question: "max-w-sm",
  content: "max-w-lg",
}

/** Title over description, 8px apart, on the left edge. */
export const MODAL_HEADER_CLASS = "grid gap-2 text-left"

/** The buttons in one row at the bottom right, Cancel first and the primary
 *  last (DESIGN_SYSTEM.md, «Положение primary»). */
export const MODAL_FOOTER_CLASS = "flex items-center justify-end gap-2"

export const MODAL_TITLE_CLASS = "text-lg font-semibold text-foreground"

export const MODAL_DESCRIPTION_CLASS = "text-base text-muted-foreground"

/** A line that names a thing: a file, a path (as ScreenState's detail). A
 *  long name wraps inside the window rather than widening it. */
export const MODAL_DETAIL_CLASS = "min-w-0 wrap-anywhere font-mono text-sm text-muted-foreground"

/** What went wrong, under what it concerns. A second line the error carries
 *  (a refused Trash's way out, decision of 14.10.2026) stays a line. */
export const MODAL_ERROR_CLASS = "whitespace-pre-line text-sm text-destructive"
