//! Where a menu stands on the screen when the menu panel draws it, and where
//! the panel goes (SPEC_MENU_WINDOW.md, section 3). No Tauri, no AppKit.
//!
//! The rules are a desktop app's, not a page's (AUDIT_MENU_PLACEMENT.md). The
//! bound is the screen the anchor lies on, less the Dock, the menu bar and
//! the camera's notch (МО1), with no field off its edges (МО2); the app's
//! window takes no part. A menu of a button opens below its plate, flush with
//! one of the plate's edges, and above only when it does not fit below (МО6
//! to МО8). A right click's menu stands with its corner on the point, moves
//! up at the bound's bottom and turns left at its right edge (МО10 to МО12).
//! A submenu opens right of its row, left where the right has no room (МО13).
//!
//! The backend places the main menu here the moment it hears of it: the panel
//! moves before its page has drawn anything. The panel's frame is set for
//! each opening (МО29): it holds the menu, the room its submenus take on the
//! side they open to, and the shadow's field round them, and it does not
//! change while the menu is open. Its edges, less the field, stand for the
//! bound's where a submenu reaches them: Radix in the panel's page places the
//! submenu as the bound would (МО31), and finds no reason to move the main
//! menu.
//!
//! Every rectangle is in global points from the top left corner of the main
//! screen, y down. The page's constants are the same numbers
//! (src/lib/menuPanelGeometry.ts; its test reads this file).

use serde::{Deserialize, Serialize};

/// A menu's distance from the bound's edges: none (МО2). A layer on a page
/// keeps `FLOATING_LAYER_EDGE_PX` off the window's edge, which cuts its
/// shadow; the screen's edge cuts nothing of a menu in a window of its own.
pub const EDGE_PX: f64 = 0.0;
/// A dropdown menu's distance from its button's plate (`MENU_PLATE_GAP_PX`).
pub const PLATE_GAP_PX: f64 = 4.0;
/// A right click's menu's distance from the point: none, its corner stands on
/// the point as `NSMenu.popUpContextMenu` puts it (МО10).
pub const CONTEXT_MENU_OFFSET_PX: f64 = 0.0;
/// How far a submenu's trigger row stands inside its menu: the surface's
/// border and inset. Radix sets the submenu against the row.
pub const SUBMENU_TRIGGER_INSET_PX: f64 = 5.0;
/// The clear field round the menu for the shadow the page draws
/// (`MENU_SHADOW_FIELD_PX`): `shadow-md` reaches 9 px below a surface.
pub const SHADOW_FIELD_PX: f64 = 12.0;

/// The panel before its first menu: one row of a menu of commands with the
/// field round it. Any size would do: the frame is set for each opening.
pub const REST_WIDTH_PX: f64 = 240.0 + 2.0 * SHADOW_FIELD_PX;
pub const REST_HEIGHT_PX: f64 = 32.0 + 2.0 * SHADOW_FIELD_PX;

/// A rectangle in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A point in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// How far a screen's safe area stands inside its frame on each side
/// (`NSScreen.safeAreaInsets`): the camera's notch at the top.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SafeInsets {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
}

/// The bound of a menu on a screen (МО1): what its visible frame and its
/// frame less the safe area's insets share. The visible frame leaves the
/// Dock and the menu bar out; in full screen it may be the whole frame, and
/// the insets keep the menu from under the notch.
pub fn screen_bound(frame: ScreenRect, visible: ScreenRect, insets: SafeInsets) -> ScreenRect {
    let left = visible.x.max(frame.x + insets.left);
    let top = visible.y.max(frame.y + insets.top);
    let right = (visible.x + visible.width).min(frame.x + frame.width - insets.right);
    let bottom = (visible.y + visible.height).min(frame.y + frame.height - insets.bottom);
    ScreenRect { x: left, y: top, width: (right - left).max(0.0), height: (bottom - top).max(0.0) }
}

/// A size in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct MenuPanelSize {
    pub width: f64,
    pub height: f64,
}

/// A submenu of the menu being opened, as its page counts it from the
/// menu's description (МО28): the largest it gets while the menu is open.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct SubmenuSize {
    /// How far below the menu's top the submenu's trigger row starts.
    pub row_top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuAlign {
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuSide {
    Top,
    Bottom,
    Left,
    Right,
}

/// What opened the menu: a button's plate, the menu below or above it and
/// flush with one of its edges, or the pointer of a right click.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuOpener {
    Plate { align: MenuAlign },
    Point,
}

/// One opening laid out: where the panel goes, and where in its page Radix
/// anchors the menu so it lands on its place exactly.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, specta::Type)]
pub struct MenuPanelLayout {
    /// The menu on the screen, at the height it is drawn.
    pub menu: ScreenRect,
    /// The panel's top left corner on the screen.
    pub origin: ScreenPoint,
    /// The panel's size for this opening (МО29). Its page draws the menu
    /// once its own area is this size (МО30).
    pub frame: MenuPanelSize,
    /// A trigger of no size in the panel's page; the dropdown wrapper sets
    /// its menu `PLATE_GAP_PX` off it.
    pub anchor: ScreenPoint,
    pub side: MenuSide,
    pub align: MenuAlign,
    /// The height the menu is held to when the screen has less room.
    pub max_height: Option<f64>,
    /// Whether the menu's submenus open to its right; true with none.
    pub submenu_right: bool,
}

struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn bounds_of(screen: ScreenRect) -> Bounds {
    Bounds {
        left: screen.x + EDGE_PX,
        top: screen.y + EDGE_PX,
        right: screen.x + screen.width - EDGE_PX,
        bottom: screen.y + screen.height - EDGE_PX,
    }
}

/// floating-ui's `clamp(start, value, end)`: the start wins a conflict.
fn clamp(start: f64, value: f64, end: f64) -> f64 {
    start.max(value.min(end))
}

/// The shift along a side, held to the anchor (`limitShift`): the menu may
/// slide until its far edge meets the anchor's near one, never off it.
fn shift_along(coordinate: f64, length: f64, start: f64, end: f64, anchor_start: f64, anchor_length: f64) -> f64 {
    let shifted = clamp(start, coordinate, end - length);
    clamp(anchor_start - length, shifted, anchor_start + anchor_length)
}

fn positive(value: f64) -> f64 {
    value.max(0.0)
}

/// The menu of `size` on the bound `screen` for `opener` at `anchor` (the
/// plate, or the point as a rectangle of no size).
fn place_menu(opener: MenuOpener, anchor: ScreenRect, size: MenuPanelSize, screen: ScreenRect) -> (ScreenRect, MenuSide, MenuAlign, Option<f64>) {
    let bounds = bounds_of(screen);
    match opener {
        MenuOpener::Plate { align } => {
            let wanted_x = match align {
                MenuAlign::End => anchor.x + anchor.width - size.width,
                MenuAlign::Start => anchor.x,
            };
            let x = shift_along(wanted_x, size.width, bounds.left, bounds.right, anchor.x, anchor.width);
            let below_y = anchor.y + anchor.height + PLATE_GAP_PX;
            let above_bottom = anchor.y - PLATE_GAP_PX;
            let overflow_below = positive(below_y + size.height - bounds.bottom);
            let overflow_above = positive(bounds.top - (above_bottom - size.height));
            // Below where it fits, else above where that fits, else the side
            // that overflows least, below on a tie (МО6).
            let side = if overflow_below == 0.0 || overflow_below <= overflow_above { MenuSide::Bottom } else { MenuSide::Top };
            let room = if side == MenuSide::Bottom { bounds.bottom - below_y } else { above_bottom - bounds.top };
            let height = size.height.min(room.max(0.0));
            let y = if side == MenuSide::Bottom { below_y } else { above_bottom - height };
            let max_height = (height < size.height).then_some(height);
            (ScreenRect { x, y, width: size.width, height }, side, align, max_height)
        }
        MenuOpener::Point => {
            let right_x = anchor.x + CONTEXT_MENU_OFFSET_PX;
            let left_x = anchor.x - CONTEXT_MENU_OFFSET_PX - size.width;
            let overflow_right = positive(right_x + size.width - bounds.right);
            let overflow_left = positive(bounds.left - left_x);
            // Right of the point where it fits, else left where that fits,
            // else the side that overflows least, the right on a tie, moved
            // inside the bound (МО11).
            let side = if overflow_right == 0.0 || overflow_right <= overflow_left { MenuSide::Right } else { MenuSide::Left };
            let height = size.height.min((bounds.bottom - bounds.top).max(0.0));
            // Moved up until its bottom stands on the bound's (МО12).
            let y = shift_along(anchor.y, height, bounds.top, bounds.bottom, anchor.y, 0.0);
            let wanted_x = if side == MenuSide::Right { right_x } else { left_x };
            let x = clamp(bounds.left, wanted_x, bounds.right - size.width);
            let max_height = (height < size.height).then_some(height);
            (ScreenRect { x, y, width: size.width, height }, side, MenuAlign::Start, max_height)
        }
    }
}

/// Whether a submenu `width` wide opens right of `menu`: where it fits,
/// else left where that fits, else the side that overflows least, the right
/// on a tie (МО13).
fn submenu_opens_right(menu: ScreenRect, width: f64, screen: ScreenRect) -> bool {
    let bounds = bounds_of(screen);
    let right_start = menu.x + menu.width - SUBMENU_TRIGGER_INSET_PX;
    let left_start = menu.x + SUBMENU_TRIGGER_INSET_PX - width;
    let overflow_right = positive(right_start + width - bounds.right);
    let overflow_left = positive(bounds.left - left_start);
    overflow_right == 0.0 || overflow_right <= overflow_left
}

/// The panel's frame for one opening (МО29, МО31). Radix in the panel keeps
/// `SHADOW_FIELD_PX` from its edges, so the frame less the field is the
/// bound it places in. Across, the frame holds the menu and the widest
/// submenu on the side the submenus open to. Down, it holds the menu and
/// every submenu where it will stand: with its top on its row's, moved up
/// until its bottom meets the bound's (МО14). Where a submenu is moved up
/// the frame's lower edge, less the field, is the bound's own, so Radix
/// lifts the submenu off it as off a page's; the frame reaches past the
/// bound by the field.
fn panel_frame(menu: ScreenRect, submenus: &[SubmenuSize], submenu_right: bool, screen: ScreenRect) -> ScreenRect {
    let bounds = bounds_of(screen);
    let widest = submenus.iter().map(|submenu| submenu.width).fold(0.0, f64::max);
    let width = menu.width + widest + 2.0 * SHADOW_FIELD_PX;
    let x = if submenu_right {
        menu.x - SHADOW_FIELD_PX
    } else {
        menu.x + menu.width + SHADOW_FIELD_PX - width
    };
    let mut top = menu.y;
    let mut bottom = menu.y + menu.height;
    for submenu in submenus {
        let height = submenu.height.min(positive(bounds.bottom - bounds.top));
        let submenu_top = clamp(bounds.top, menu.y + submenu.row_top, bounds.bottom - height);
        top = top.min(submenu_top);
        bottom = bottom.max(submenu_top + height);
    }
    ScreenRect {
        x,
        y: top - SHADOW_FIELD_PX,
        width,
        height: bottom - top + 2.0 * SHADOW_FIELD_PX,
    }
}

/// The trigger point in the panel's page that puts the menu on `menu`: the
/// plate gap off the edge the menu came out of, so it grows from the same
/// corner as on a page.
fn panel_anchor(menu: ScreenRect, side: MenuSide, align: MenuAlign, origin: ScreenPoint) -> ScreenPoint {
    let left = menu.x - origin.x;
    let top = menu.y - origin.y;
    let edge_x = if align == MenuAlign::End { left + menu.width } else { left };
    match side {
        MenuSide::Bottom => ScreenPoint { x: edge_x, y: top - PLATE_GAP_PX },
        MenuSide::Top => ScreenPoint { x: edge_x, y: top + menu.height + PLATE_GAP_PX },
        MenuSide::Right => ScreenPoint { x: left - PLATE_GAP_PX, y: top },
        MenuSide::Left => ScreenPoint { x: left + menu.width + PLATE_GAP_PX, y: top },
    }
}

/// Whether the sizes a page counted are sizes: finite and more than nothing.
pub fn sizes_are_sizes(size: MenuPanelSize, submenus: &[SubmenuSize]) -> bool {
    let whole = |value: f64| value.is_finite() && value > 0.0;
    whole(size.width)
        && whole(size.height)
        && submenus
            .iter()
            .all(|submenu| whole(submenu.width) && whole(submenu.height) && submenu.row_top.is_finite() && submenu.row_top >= 0.0)
}

/// Lay out one opening on the bound `screen` (`screen_bound`): the menu of
/// `size` with its `submenus`.
pub fn layout(opener: MenuOpener, anchor: ScreenRect, size: MenuPanelSize, submenus: &[SubmenuSize], screen: ScreenRect) -> MenuPanelLayout {
    let (menu, side, align, max_height) = place_menu(opener, anchor, size, screen);
    let widest = submenus.iter().map(|submenu| submenu.width).fold(0.0, f64::max);
    let submenu_right = submenus.is_empty() || submenu_opens_right(menu, widest, screen);
    let frame = panel_frame(menu, submenus, submenu_right, screen);
    let origin = ScreenPoint { x: frame.x, y: frame.y };
    MenuPanelLayout {
        menu,
        origin,
        frame: MenuPanelSize { width: frame.width, height: frame.height },
        anchor: panel_anchor(menu, side, align, origin),
        side,
        align,
        max_height,
        submenu_right,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 1440 × 900 screen whose visible frame starts under a 25 pt menu bar.
    const SCREEN: ScreenRect = ScreenRect { x: 0.0, y: 25.0, width: 1440.0, height: 875.0 };
    const MENU: MenuPanelSize = MenuPanelSize { width: 240.0, height: 300.0 };
    const END: MenuOpener = MenuOpener::Plate { align: MenuAlign::End };
    /// Connect's picker, off the menu's first row: a list under a search
    /// field at its tallest.
    const PICKER: SubmenuSize = SubmenuSize { row_top: 5.0, width: 300.0, height: 303.0 };

    /// A card menu: the menu of commands with Connect's submenu.
    fn layout(opener: MenuOpener, anchor: ScreenRect, size: MenuPanelSize, screen: ScreenRect) -> MenuPanelLayout {
        super::layout(opener, anchor, size, &[PICKER], screen)
    }

    fn plate(x: f64, y: f64) -> ScreenRect {
        ScreenRect { x, y, width: 24.0, height: 24.0 }
    }

    fn point(x: f64, y: f64) -> ScreenRect {
        ScreenRect { x, y, width: 0.0, height: 0.0 }
    }

    #[test]
    fn the_frame_is_the_menu_and_its_submenu_with_the_shadows_field() {
        let laid = layout(END, plate(700.0, 200.0), MENU, SCREEN);
        // Across: the menu, the picker beside it, the field on both sides.
        // Down: the picker starts 5 below the menu's top and ends 8 below
        // its bottom.
        assert_eq!(laid.frame, MenuPanelSize { width: 240.0 + 300.0 + 24.0, height: 5.0 + 303.0 + 24.0 });
        assert_eq!(laid.origin, ScreenPoint { x: laid.menu.x - SHADOW_FIELD_PX, y: laid.menu.y - SHADOW_FIELD_PX });
    }

    #[test]
    fn a_menu_with_no_submenu_has_a_frame_of_its_own_size_and_the_field() {
        let laid = super::layout(END, plate(700.0, 200.0), MENU, &[], SCREEN);
        assert_eq!(laid.frame, MenuPanelSize { width: 264.0, height: 324.0 });
        assert_eq!(laid.origin, ScreenPoint { x: laid.menu.x - 12.0, y: laid.menu.y - 12.0 });
        assert!(laid.submenu_right);
        // At the screen's right edge too: nothing is kept for a submenu.
        let edge = super::layout(END, plate(1416.0, 200.0), MENU, &[], SCREEN);
        assert_eq!((edge.menu.x, edge.frame.width, edge.submenu_right), (1200.0, 264.0, true));
    }

    #[test]
    fn the_frame_holds_the_widest_and_the_lowest_of_several_submenus() {
        let table = SubmenuSize { row_top: 37.0, width: 240.0, height: 400.0 };
        let laid = super::layout(END, plate(700.0, 200.0), MENU, &[PICKER, table], SCREEN);
        assert_eq!(laid.frame, MenuPanelSize { width: 240.0 + 300.0 + 24.0, height: 37.0 + 400.0 + 24.0 });
    }

    #[test]
    fn a_submenu_taller_than_the_bound_takes_its_height() {
        let short = ScreenRect { x: 0.0, y: 0.0, width: 1440.0, height: 250.0 };
        let small = MenuPanelSize { width: 240.0, height: 100.0 };
        let laid = super::layout(END, plate(700.0, 20.0), small, &[PICKER], short);
        // The picker from the bound's top to its bottom, Radix scrolls it.
        assert_eq!((laid.origin.y, laid.frame.height), (-12.0, 250.0 + 24.0));
    }

    #[test]
    fn a_menu_stands_below_its_plate_flush_with_its_right_edge() {
        let laid = layout(END, plate(700.0, 200.0), MENU, SCREEN);
        assert_eq!(laid.side, MenuSide::Bottom);
        assert_eq!(laid.menu, ScreenRect { x: 724.0 - 240.0, y: 228.0, width: 240.0, height: 300.0 });
        assert_eq!(laid.max_height, None);
    }

    #[test]
    fn a_menu_flips_above_its_plate_at_the_screens_bottom() {
        // It fits below to the last point: no field off the bound (МО2).
        let y = SCREEN.y + SCREEN.height - 300.0 - PLATE_GAP_PX - 24.0;
        assert_eq!(layout(END, plate(700.0, y), MENU, SCREEN).side, MenuSide::Bottom);
        let flipped = layout(END, plate(700.0, y + 1.0), MENU, SCREEN);
        assert_eq!(flipped.side, MenuSide::Top);
        assert_eq!(flipped.menu.y + flipped.menu.height, y + 1.0 - PLATE_GAP_PX);
    }

    #[test]
    fn a_menu_shifts_off_the_screens_side_but_never_off_its_plate() {
        assert_eq!(layout(END, plate(20.0, 200.0), MENU, SCREEN).menu.x, 0.0);
        assert_eq!(layout(END, plate(-400.0, 200.0), MENU, SCREEN).menu.x, -376.0);
        let second = ScreenRect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let start = MenuOpener::Plate { align: MenuAlign::Start };
        assert_eq!(layout(start, plate(3350.0, 300.0), MENU, second).menu.x, 3360.0 - 240.0);
        // A screen left of the main one: its points are negative (МО3).
        let left = ScreenRect { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(layout(start, plate(-100.0, 300.0), MENU, left).menu.x, -240.0);
        assert_eq!(layout(END, plate(-1910.0, 300.0), MENU, left).menu.x, -1920.0);
    }

    #[test]
    fn with_room_on_neither_side_the_menu_takes_the_lesser_overflow_and_its_room() {
        let short = ScreenRect { x: 0.0, y: 0.0, width: 800.0, height: 400.0 };
        let laid = layout(END, plate(400.0, 150.0), MENU, short);
        assert_eq!(laid.side, MenuSide::Bottom);
        assert_eq!(laid.max_height, Some(400.0 - 178.0));
    }

    #[test]
    fn a_right_clicks_menu_stands_with_its_corner_on_the_point_and_turns_left_at_the_edge() {
        // The top left corner on the point, no offset (МО10).
        let laid = layout(MenuOpener::Point, point(500.0, 300.0), MENU, SCREEN);
        assert_eq!((laid.side, laid.menu.x, laid.menu.y), (MenuSide::Right, 500.0, 300.0));
        // It fits to the bound's right edge exactly, and turns one point on:
        // the top right corner on the point (МО11).
        assert_eq!(layout(MenuOpener::Point, point(1200.0, 300.0), MENU, SCREEN).side, MenuSide::Right);
        let flipped = layout(MenuOpener::Point, point(1201.0, 300.0), MENU, SCREEN);
        assert_eq!(flipped.side, MenuSide::Left);
        assert_eq!(flipped.menu.x + flipped.menu.width, 1201.0);
    }

    #[test]
    fn a_right_clicks_menu_moves_up_at_the_bottom_just_enough() {
        // Its bottom on the bound's, not a point higher (МО12).
        let low = layout(MenuOpener::Point, point(500.0, 850.0), MENU, SCREEN);
        assert_eq!(low.menu.y + low.menu.height, SCREEN.y + SCREEN.height);
        assert_eq!(low.max_height, None);
        // A menu taller than the bound starts at its top and takes its height.
        let short = ScreenRect { x: 0.0, y: 25.0, width: 1440.0, height: 200.0 };
        let tall = layout(MenuOpener::Point, point(500.0, 100.0), MENU, short);
        assert_eq!((tall.menu.y, tall.menu.height, tall.max_height), (25.0, 200.0, Some(200.0)));
    }

    #[test]
    fn a_right_clicks_menu_with_room_on_neither_side_stays_inside_the_bound() {
        let narrow = ScreenRect { x: 0.0, y: 0.0, width: 300.0, height: 900.0 };
        // 90 past the right edge, 90 past the left: a tie, the right, moved in.
        let tie = layout(MenuOpener::Point, point(150.0, 100.0), MENU, narrow);
        assert_eq!((tie.side, tie.menu.x), (MenuSide::Right, 60.0));
        // Less past the left edge: the left side, moved in.
        let left = layout(MenuOpener::Point, point(220.0, 100.0), MENU, narrow);
        assert_eq!((left.side, left.menu.x), (MenuSide::Left, 0.0));
    }

    #[test]
    fn the_bound_leaves_out_the_dock_the_menu_bar_and_the_notch() {
        let frame = ScreenRect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
        // A window's screen: the visible frame starts under the menu bar,
        // which already covers the notch, and ends above the Dock.
        let visible = ScreenRect { x: 0.0, y: 38.0, width: 1512.0, height: 874.0 };
        let notch = SafeInsets { top: 38.0, ..SafeInsets::default() };
        assert_eq!(screen_bound(frame, visible, notch), visible);
        // Full screen: the visible frame is the whole frame, the insets keep
        // the menu from under the notch (МО1, decision 4).
        assert_eq!(screen_bound(frame, frame, notch), ScreenRect { x: 0.0, y: 38.0, width: 1512.0, height: 944.0 });
        // A screen with no notch, a Dock on the left.
        let docked = ScreenRect { x: 70.0, y: 25.0, width: 1370.0, height: 875.0 };
        let plain = ScreenRect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        assert_eq!(screen_bound(plain, docked, SafeInsets::default()), docked);
        // A second screen above the main one: negative points.
        let above = ScreenRect { x: 0.0, y: -1080.0, width: 1920.0, height: 1080.0 };
        assert_eq!(screen_bound(above, above, SafeInsets::default()), above);
    }

    #[test]
    fn the_submenu_opens_where_the_screen_has_room() {
        assert!(layout(END, plate(700.0, 200.0), MENU, SCREEN).submenu_right);
        let left = layout(END, plate(1200.0, 200.0), MENU, SCREEN);
        assert!(!left.submenu_right);
        // The frame's right edge the field off the menu: Radix flips left.
        assert_eq!(left.origin.x + left.frame.width, left.menu.x + left.menu.width + SHADOW_FIELD_PX);
        assert_eq!(left.menu.x - left.origin.x, PICKER.width + SHADOW_FIELD_PX);
    }

    #[test]
    fn the_submenu_is_pressed_to_the_screens_bottom_and_the_frame_reaches_past_it() {
        let laid = layout(MenuOpener::Point, point(300.0, 700.0), MENU, SCREEN);
        let bottom = SCREEN.y + SCREEN.height;
        // The frame's lower edge less the field is the bound's: Radix lifts
        // the picker off it, and the frame's top is the lifted picker's.
        assert_eq!(laid.origin.y + laid.frame.height - SHADOW_FIELD_PX, bottom);
        assert_eq!(laid.menu.y + laid.menu.height, bottom);
        assert_eq!(laid.origin.y + SHADOW_FIELD_PX, bottom - PICKER.height);
    }

    #[test]
    fn every_menu_has_the_shadows_field_round_it_in_the_panel() {
        for height in [120.0, 300.0, 400.0] {
            for y in [30.0, 300.0, 600.0, 880.0] {
                for x in [0.0, 500.0, 1430.0] {
                    for opener in [MenuOpener::Point, END] {
                        let anchor = if opener == MenuOpener::Point { point(x, y) } else { plate(x, y) };
                        let laid = layout(opener, anchor, MenuPanelSize { width: 240.0, height }, SCREEN);
                        let (menu, origin) = (laid.menu, laid.origin);
                        assert!(menu.x - origin.x >= SHADOW_FIELD_PX - 1e-9);
                        assert!(origin.x + laid.frame.width - (menu.x + menu.width) >= SHADOW_FIELD_PX - 1e-9);
                        assert!(menu.y - origin.y >= SHADOW_FIELD_PX - 1e-9);
                        assert!(origin.y + laid.frame.height - (menu.y + menu.height) >= SHADOW_FIELD_PX - 1e-9);
                    }
                }
            }
        }
    }

    #[test]
    fn the_anchor_stands_the_plate_gap_off_the_edge_the_menu_came_out_of() {
        let laid = layout(END, plate(700.0, 200.0), MENU, SCREEN);
        let local = ScreenPoint { x: laid.menu.x - laid.origin.x, y: laid.menu.y - laid.origin.y };
        assert_eq!(laid.anchor, ScreenPoint { x: local.x + 240.0, y: local.y - PLATE_GAP_PX });
        let right_click = layout(MenuOpener::Point, point(500.0, 300.0), MENU, SCREEN);
        assert_eq!(right_click.anchor.x, right_click.menu.x - right_click.origin.x - PLATE_GAP_PX);
    }

    #[test]
    fn only_sizes_are_laid_out() {
        assert!(sizes_are_sizes(MenuPanelSize { width: 240.0, height: 325.0 }, &[PICKER]));
        // Any size a menu has: the bound holds it to the room, not the panel.
        assert!(sizes_are_sizes(MenuPanelSize { width: 300.0, height: 900.0 }, &[]));
        assert!(!sizes_are_sizes(MenuPanelSize { width: f64::NAN, height: 200.0 }, &[]));
        assert!(!sizes_are_sizes(MenuPanelSize { width: 240.0, height: 0.0 }, &[]));
        assert!(!sizes_are_sizes(MENU, &[SubmenuSize { row_top: -1.0, ..PICKER }]));
        assert!(!sizes_are_sizes(MENU, &[SubmenuSize { height: f64::INFINITY, ..PICKER }]));
    }
}
