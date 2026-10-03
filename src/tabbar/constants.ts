// Geometry and timing of the tab bar (SPEC_TABS.md, «Константы»).
//
// The Rust side owns the values it needs itself: TAB_BAR_HEIGHT_PX,
// TAB_MIN_WIDTH_PX, TAB_MAX_WIDTH_PX and TAB_DETACH_THRESHOLD_PX live in
// src-tauri/src/domain/windows.rs, which lays out the bar's webview and
// follows a torn tab. They are not exported to TypeScript, so they are
// restated here once and constants.test.ts reads the Rust source to keep the
// two equal.

/** Height of the bar page: a 30 px chrome row and its 1 px bottom separator
 *  (domain/windows.rs `TAB_BAR_HEIGHT_PX`, В44). */
export const TAB_BAR_HEIGHT_PX = 31;

/** Narrowest a tab gets before the strip scrolls (domain/windows.rs `TAB_MIN_WIDTH_PX`, В48). */
export const TAB_MIN_WIDTH_PX = 96;

/** Widest a tab gets (domain/windows.rs `TAB_MAX_WIDTH_PX`, В48). */
export const TAB_MAX_WIDTH_PX = 240;

/** How far below the bar the pointer goes before a dragged tab tears off
 *  (domain/windows.rs `TAB_DETACH_THRESHOLD_PX`, В61). */
export const TAB_DETACH_THRESHOLD_PX = 24;

/** How long neighbours take to make room for a dragged tab (В60). */
export const TAB_REORDER_MOTION_MS = 150;

/** The project's ease-out, the curve the sidebar's rows part with. */
export const TAB_REORDER_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Width of the line that marks where a tab from another window would land (В63). */
export const DROP_MARKER_WIDTH_PX = 2;

/** Pointer travel that turns a press into a drag: the chrome's threshold
 *  gesture (`DEFAULT_CHROME_DRAG_THRESHOLD_PX` in useChromeDragGesture.ts, В60). */
export const CHROME_DRAG_THRESHOLD_PX = 4;
