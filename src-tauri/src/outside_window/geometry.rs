//! Where the outside window stands on the screen (SPEC_OUTSIDE_WINDOW.md,
//! ПН2, ПН8, ПК3). No Tauri, no AppKit.
//!
//! The hover preview window goes outside the app window only when it has no
//! room beside its panel inside it (ПН1). Outside it stands beside the same
//! panel, the same 8 px off it, on the preferred side first, within the bound
//! of the screen its trigger lies on: the bound of a menu (МО1), with no field
//! off its edges (МО2). The outside window then takes a column: the
//! window's width across and the whole bound down, with a clear field round
//! it for the shadow the page draws. The frame is set once a showing and
//! does not change while it lasts: the window moves on its page (ПН8).
//!
//! Every rectangle is in global points from the top left corner of the main
//! screen, y down, as the menu panel's (`menu_panel::geometry`).

use serde::{Deserialize, Serialize};

use crate::menu_panel::geometry::{ScreenPoint, ScreenRect, EDGE_PX};

/// The hover preview window's width: the card's of the sidebar, the graph and
/// the related notes (SPEC_CARD_STATES.md, С10.4); `HOVER_PREVIEW_WINDOW_WIDTH_PX`
/// on the page.
pub const PREVIEW_WIDTH_PX: f64 = 240.0;

/// Between the window and the panel it stands beside (С7.11);
/// `HOVER_PREVIEW_WINDOW_GAP_PX` on the page.
pub const PREVIEW_GAP_PX: f64 = 8.0;

/// The clear field round what the outside window draws, for its shadow: how
/// far `shadow-lg` (`0 10px 15px -3px`) reaches below a surface, 10 + 15 − 3,
/// its farthest side (ПН8). One field on every side, as the menu panel's
/// `SHADOW_FIELD_PX` for `shadow-md`.
pub const SHADOW_FIELD_PX: f64 = 22.0;

/// Which side of its panel the window would rather stand on: after the
/// sidebar, before the open card's panel (С7.11, «Место»).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PreviewSide {
    After,
    Before,
}

/// The left edge of the window beside `panel` within `bound`: on `side`,
/// else on the other, else `None`, when neither has room on the screen
/// (ПН2, ПН3).
pub fn preview_column_left(panel: ScreenRect, bound: ScreenRect, side: PreviewSide) -> Option<f64> {
    let after = panel.x + panel.width + PREVIEW_GAP_PX;
    let before = panel.x - PREVIEW_GAP_PX - PREVIEW_WIDTH_PX;
    let fits_after = after + PREVIEW_WIDTH_PX <= bound.x + bound.width - EDGE_PX;
    let fits_before = before >= bound.x + EDGE_PX;
    match side {
        PreviewSide::After if fits_after => Some(after),
        PreviewSide::Before if fits_before => Some(before),
        _ if fits_after => Some(after),
        _ if fits_before => Some(before),
        _ => None,
    }
}

/// The outside window's frame for a showing: the column at `left`, the
/// whole `bound` down, the shadow's field round both (ПН8).
pub fn preview_frame(left: f64, bound: ScreenRect) -> ScreenRect {
    ScreenRect {
        x: left - SHADOW_FIELD_PX,
        y: bound.y - SHADOW_FIELD_PX,
        width: PREVIEW_WIDTH_PX + 2.0 * SHADOW_FIELD_PX,
        height: bound.height + 2.0 * SHADOW_FIELD_PX,
    }
}

/// Where the window may stand on the outside window's page, from the page's
/// top left: the column across, the bound down (`HoverPreviewArea`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, specta::Type)]
pub struct PageArea {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// The area on the page of the outside window framed by `frame` for
/// `bound`: the field's width in from the frame's edges.
pub fn preview_page_area(frame: ScreenRect, bound: ScreenRect) -> PageArea {
    let top = bound.y - frame.y;
    PageArea {
        left: SHADOW_FIELD_PX,
        top,
        right: frame.width - SHADOW_FIELD_PX,
        bottom: top + bound.height,
    }
}

/// A rectangle of the screen on the page of the window framed by `frame`.
pub fn on_page(rect: ScreenRect, frame: ScreenRect) -> ScreenRect {
    ScreenRect { x: rect.x - frame.x, y: rect.y - frame.y, width: rect.width, height: rect.height }
}

/// How far the cursor's tip stands inside the dragged card's top left corner
/// (`snapToCursor` in App.tsx, its `INSET`): the card's corner is 4 points
/// up and left of the tip, inside the app window and outside it (ПК1).
pub const DRAG_CURSOR_INSET_PX: f64 = 4.0;

/// Where the front card of the dragged stack stands on the outside window's
/// page, past the shadow's field: room for the stack's back layers
/// (`DRAG_STACK_LAYERS` in Card.tsx: up to 6 points across and 16 up) turned
/// by up to 0.9° about their centre, which moves a corner of a card 600
/// points tall by 600 / 2 × sin 0.9° ≈ 4.7 points.
pub const DRAG_STACK_SIDE_PX: f64 = 12.0;
pub const DRAG_STACK_TOP_PX: f64 = 22.0;

/// The outside window's frame for a dragged card with the cursor's tip at
/// `cursor`: the card's width with the stack's room and the shadow's field
/// across, the tallest screen down, so no card of any height is cut and the
/// frame never changes while the card is dragged (ПК3).
pub fn drag_frame(cursor: ScreenPoint, tallest_screen: f64) -> ScreenRect {
    let origin = drag_frame_origin(cursor);
    ScreenRect {
        x: origin.x,
        y: origin.y,
        width: PREVIEW_WIDTH_PX + 2.0 * (SHADOW_FIELD_PX + DRAG_STACK_SIDE_PX),
        height: tallest_screen + 2.0 * SHADOW_FIELD_PX,
    }
}

/// The frame's top left for the cursor's tip at `cursor`: the front card's
/// corner `DRAG_CURSOR_INSET_PX` up and left of the tip.
pub fn drag_frame_origin(cursor: ScreenPoint) -> ScreenPoint {
    ScreenPoint {
        x: cursor.x - DRAG_CURSOR_INSET_PX - SHADOW_FIELD_PX - DRAG_STACK_SIDE_PX,
        y: cursor.y - DRAG_CURSOR_INSET_PX - SHADOW_FIELD_PX - DRAG_STACK_TOP_PX,
    }
}

/// Where the front card stands on the dragged card's page.
pub fn drag_stack_on_page() -> ScreenPoint {
    ScreenPoint { x: SHADOW_FIELD_PX + DRAG_STACK_SIDE_PX, y: SHADOW_FIELD_PX + DRAG_STACK_TOP_PX }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUND: ScreenRect = ScreenRect { x: 0.0, y: 25.0, width: 1728.0, height: 1080.0 };

    fn panel(x: f64, width: f64) -> ScreenRect {
        ScreenRect { x, y: 80.0, width, height: 700.0 }
    }

    #[test]
    fn stands_beside_the_panel_on_its_side_eight_points_off() {
        // A narrow window at x 400: the sidebar over the feed, 350 wide.
        assert_eq!(preview_column_left(panel(400.0, 350.0), BOUND, PreviewSide::After), Some(758.0));
        // The open card's stacked panel: before it.
        assert_eq!(preview_column_left(panel(400.0, 350.0), BOUND, PreviewSide::Before), Some(152.0));
    }

    #[test]
    fn takes_the_other_side_at_the_screens_edge_and_none_when_neither_has_room() {
        // The window at the screen's right edge: no room after.
        let at_right = panel(1728.0 - 360.0, 350.0);
        assert_eq!(preview_column_left(at_right, BOUND, PreviewSide::After), Some(1368.0 - 8.0 - 240.0));
        // At the left edge: no room before.
        assert_eq!(preview_column_left(panel(10.0, 350.0), BOUND, PreviewSide::Before), Some(368.0));
        // Full screen: the panel spans the screen.
        assert_eq!(preview_column_left(panel(0.0, 1728.0), BOUND, PreviewSide::After), None);
    }

    #[test]
    fn touches_the_screens_edge_with_no_field_between() {
        // Exactly room for the window after the panel, up to the bound's edge.
        let exact = panel(1728.0 - 248.0 - 300.0, 300.0);
        assert_eq!(preview_column_left(exact, BOUND, PreviewSide::After), Some(1728.0 - 240.0));
        // Exactly room before, from the bound's left edge.
        assert_eq!(preview_column_left(panel(248.0, 300.0), BOUND, PreviewSide::Before), Some(0.0));
    }

    #[test]
    fn keeps_to_a_second_screen_left_of_the_main_one() {
        let second = ScreenRect { x: -1920.0, y: 0.0, width: 1920.0, height: 1055.0 };
        assert_eq!(preview_column_left(panel(-1900.0, 350.0), second, PreviewSide::Before), Some(-1900.0 + 358.0));
    }

    #[test]
    fn frames_a_column_down_the_whole_bound_with_the_shadows_field() {
        let frame = preview_frame(758.0, BOUND);
        assert_eq!(frame, ScreenRect { x: 736.0, y: 3.0, width: 284.0, height: 1124.0 });
        let area = preview_page_area(frame, BOUND);
        assert_eq!(area, PageArea { left: 22.0, top: 22.0, right: 262.0, bottom: 1102.0 });
        // The window fits the area across exactly: it does not move across.
        assert!((area.right - area.left - PREVIEW_WIDTH_PX).abs() < f64::EPSILON);
    }

    #[test]
    fn puts_a_screen_rectangle_on_the_page_of_its_frame() {
        let frame = preview_frame(758.0, BOUND);
        let trigger = ScreenRect { x: 420.0, y: 300.0, width: 300.0, height: 40.0 };
        assert_eq!(on_page(trigger, frame), ScreenRect { x: -316.0, y: 297.0, width: 300.0, height: 40.0 });
    }

    #[test]
    fn puts_the_dragged_cards_corner_four_points_up_and_left_of_the_cursors_tip() {
        let cursor = ScreenPoint { x: 900.0, y: 500.0 };
        let frame = drag_frame(cursor, 1117.0);
        let stack = drag_stack_on_page();
        assert_eq!(frame.x + stack.x, cursor.x - DRAG_CURSOR_INSET_PX);
        assert_eq!(frame.y + stack.y, cursor.y - DRAG_CURSOR_INSET_PX);
        assert_eq!(frame.width, 308.0);
        assert_eq!(frame.height, 1117.0 + 44.0);
        // The stack's room holds its back layers turned about their centre.
        let turned: f64 = 300.0 * 0.9_f64.to_radians().sin();
        assert!(DRAG_STACK_SIDE_PX >= 6.0 + turned);
        assert!(DRAG_STACK_TOP_PX >= 16.0 + turned);
    }

    #[test]
    fn its_field_holds_the_preview_shadow() {
        // `shadow-lg`: 0 10px 15px -3px reaches 22 px below, 12 at the sides.
        let below: f64 = 10.0 + 15.0 - 3.0;
        assert!(SHADOW_FIELD_PX >= below);
    }
}
