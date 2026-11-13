// The one anatomy of a modal window (DESIGN_SYSTEM.md, «Окна»), shared by
// `Dialog` and `AlertDialog` so the two cannot drift apart again: one
// dimming, one surface, two widths by role, one header, one footer.
//
// The window and its scrim move together as Поверхность: a fade and 95 %,
// in on --motion-surface-enter, out on --motion-surface-exit, the response
// curve; Full 200 ms both ways, Minimal 150 and 100 ms, Off at once by the
// tokens, a key at once by global.css (SPEC_MOTION_LEVELS.md, М5, РД1; user's
// decision of 12.11.2026 on the scrim). The layers that play the entrance and
// exit themselves follow their own specs.

/** The scrim under a window: the one scrim every layer over the page shares
 *  (global.css, `.modal-scrim`; SPEC_COLOR_RULES.md, 3.9.1; user's decisions
 *  of 16.10.2026), the whole page of the tab blurred and dimmed by the
 *  canvas at 32 %. */
export const MODAL_OVERLAY_CLASS =
  "modal-scrim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:duration-(--motion-surface-enter) data-[state=closed]:duration-(--motion-surface-exit) ease-(--motion-ease) fixed inset-0 z-50"

/** A floating layer on `--popover`, held by its line and shadow
 *  (SPEC_COLOR_RULES.md, 3.3; K11), 16px off each edge of a narrow app
 *  window, the window field 24px (`--spacing-s4`), its parts 16px apart. Its
 *  width is its role's (`MODAL_WIDTH_CLASS`). */
export const MODAL_SURFACE_CLASS =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=open]:duration-(--motion-surface-enter) data-[state=closed]:duration-(--motion-surface-exit) ease-(--motion-ease) fixed top-[50%] left-[50%] z-50 grid w-[calc(100%-32px)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-1 border border-border p-6 shadow-lg outline-none"

/** The dialogs' own entrance and exit, for a layer that plays them itself
 *  over its own content (the card's window, SPEC_CARD_PEEK.md, О11; the image
 *  preview, SPEC_MEDIA_ASSET_ACTIONS.md): the surface's as above, the scrim's
 *  as `MODAL_OVERLAY_CLASS`'s. */
export const MODAL_SURFACE_ENTER_CLASS = "animate-in fade-in-0 zoom-in-95 duration-(--motion-surface-enter) ease-(--motion-ease)"
export const MODAL_SURFACE_LEAVE_CLASS = "animate-out fade-out-0 zoom-out-95 duration-(--motion-surface-exit) ease-(--motion-ease) fill-mode-forwards"
export const MODAL_SCRIM_ENTER_CLASS = "animate-in fade-in-0 duration-(--motion-surface-enter) ease-(--motion-ease)"
export const MODAL_SCRIM_LEAVE_CLASS = "animate-out fade-out-0 duration-(--motion-surface-exit) ease-(--motion-ease) fill-mode-forwards"

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
