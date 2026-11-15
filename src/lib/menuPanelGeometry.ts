// TRIAL (DESIGN_SYSTEM.md, «Меню карточки в отдельном окне: проба»): where
// the card menu stands on the screen when it is drawn in the menu panel, a
// window of its own, and where that window goes.
//
// A menu on a page is placed by Radix against the page's edges: it flips to
// the other side of its button and shifts along it (floating-ui `shift` with
// `limitShift`, then `flip` with its best fit), `collisionPadding` off every
// edge. A menu in the panel does the same against the edges of the screen,
// so the placement of the main menu is computed here by those rules, with
// the screen's visible frame in place of the page. The panel then goes where
// its own edges, less the shadow's field, stand for the screen's: Radix
// inside it places the submenu as the screen would, and finds no reason to
// move the main menu. The menu is pressed to the screen's edge, never the
// panel: the panel reaches past it by the field.
//
// Every rectangle is in global screen points with the origin at the top left
// of the main screen, y growing down, as the backend reports them.

import { FLOATING_LAYER_EDGE_PX, MENU_PLATE_GAP_PX } from "./floatingLayer";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/** The width of a menu of actions and of a list under a search field
 *  (global.css, `[data-floating-menu]`). */
export const MENU_ACTION_WIDTH_PX = 240;
export const MENU_SEARCH_WIDTH_PX = 300;

/** The tallest card menu: nine rows of 32 px, three separators of 9 px, the
 *  surface's inset and border, with room to spare. A taller one is not drawn
 *  in the panel (`fitsPanel`). */
export const MENU_PANEL_MENU_MAX_HEIGHT_PX = 400;

/** The tallest submenu: Connect's search field, eight rows of collections
 *  (QuantizedMenuScrollArea), the creation row and a refusal under it. */
export const MENU_PANEL_SUBMENU_MAX_HEIGHT_PX = 400;

/** How far a submenu's trigger row stands inside its menu: the surface's
 *  border and inset (`border p-surface`). Radix sets the submenu against the
 *  row, not the menu. */
export const SUBMENU_TRIGGER_INSET_PX = 5;

/** The context menu's distance from the pointer (Radix ContextMenu). */
export const CONTEXT_MENU_OFFSET_PX = 2;

/**
 * The clear field the panel keeps around the menu and its submenu: the page
 * draws the menu's shadow (`shadow-md`, the menu's own on a page), and the
 * panel's edge must not cut it. The shadow reaches 9 px below a surface, 5 px
 * to its sides and 1 px above it (Tailwind's `--shadow-md`, its widest layer
 * `0 4px 6px -1px`); the test reads the token and holds the field to it.
 * Radix in the panel keeps this far from the panel's edges.
 */
export const MENU_SHADOW_FIELD_PX = 12;

/** The panel: the main menu, a submenu beside it on the side its placement
 *  gives, and the shadow's field round them. It is made once in this size
 *  and never resized. */
export const MENU_PANEL_SIZE: MenuSize = {
  width: MENU_ACTION_WIDTH_PX + MENU_SEARCH_WIDTH_PX + 2 * MENU_SHADOW_FIELD_PX,
  height:
    Math.max(MENU_PANEL_MENU_MAX_HEIGHT_PX, SUBMENU_TRIGGER_INSET_PX + MENU_PANEL_SUBMENU_MAX_HEIGHT_PX)
    + 2 * MENU_SHADOW_FIELD_PX,
};

/** What opened the menu: a button's plate, the menu below or above it and
 *  flush with one of its edges, or the pointer of a right click. */
export type MenuOpener =
  | { kind: "plate"; plate: ScreenRect; align: "start" | "end" }
  | { kind: "point"; point: ScreenPoint };

export type MenuSide = "top" | "bottom" | "left" | "right";

export interface MenuPlacement {
  /** The menu on the screen, at the height it is drawn. */
  menu: ScreenRect;
  side: MenuSide;
  align: "start" | "end";
  /** The height the menu is held to, when the screen has less room than it
   *  needs (Radix's `size`); null when it shows whole. */
  maxHeight: number | null;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boundsOf(screen: ScreenRect, padding: number): Bounds {
  return {
    left: screen.x + padding,
    top: screen.y + padding,
    right: screen.x + screen.width - padding,
    bottom: screen.y + screen.height - padding,
  };
}

/** floating-ui's `clamp(start, value, end)`: the start wins a conflict. */
function clamp(start: number, value: number, end: number): number {
  return Math.max(start, Math.min(value, end));
}

/** The shift along a side, held to the anchor (`limitShift`): the menu may
 *  slide until its far edge meets the anchor's near one, never off it. */
function shiftAlong(coordinate: number, length: number, start: number, end: number, anchorStart: number, anchorLength: number): number {
  const shifted = clamp(start, coordinate, end - length);
  return clamp(anchorStart - length, shifted, anchorStart + anchorLength);
}

function positive(value: number): number {
  return Math.max(0, value);
}

/** Where the menu of `size` stands on `screen` for `opener`, by Radix's rules
 *  with the screen's visible frame as the page. */
export function placeMenu(opener: MenuOpener, size: MenuSize, screen: ScreenRect): MenuPlacement {
  const bounds = boundsOf(screen, FLOATING_LAYER_EDGE_PX);
  if (opener.kind === "plate") {
    const { plate, align } = opener;
    const wantedX = align === "end" ? plate.x + plate.width - size.width : plate.x;
    const x = shiftAlong(wantedX, size.width, bounds.left, bounds.right, plate.x, plate.width);
    const belowY = plate.y + plate.height + MENU_PLATE_GAP_PX;
    const aboveBottom = plate.y - MENU_PLATE_GAP_PX;
    const overflowBelow = positive(belowY + size.height - bounds.bottom);
    const overflowAbove = positive(bounds.top - (aboveBottom - size.height));
    // The first side that fits, else the one that overflows least; a tie
    // keeps the first (floating-ui `flip`, `bestFit`).
    const side: MenuSide = overflowBelow === 0 || overflowBelow <= overflowAbove ? "bottom" : "top";
    const room = side === "bottom" ? bounds.bottom - belowY : aboveBottom - bounds.top;
    const height = Math.min(size.height, Math.max(0, room));
    const y = side === "bottom" ? belowY : aboveBottom - height;
    return {
      menu: { x, y, width: size.width, height },
      side,
      align,
      maxHeight: height < size.height ? height : null,
    };
  }
  const { point } = opener;
  const rightX = point.x + CONTEXT_MENU_OFFSET_PX;
  const leftX = point.x - CONTEXT_MENU_OFFSET_PX - size.width;
  const overflowRight = positive(rightX + size.width - bounds.right);
  const overflowLeft = positive(bounds.left - leftX);
  const side: MenuSide = overflowRight === 0 || overflowRight <= overflowLeft ? "right" : "left";
  const height = Math.min(size.height, Math.max(0, bounds.bottom - bounds.top));
  const y = shiftAlong(point.y, height, bounds.top, bounds.bottom, point.y, 0);
  return {
    menu: { x: side === "right" ? rightX : leftX, y, width: size.width, height },
    side,
    align: "start",
    maxHeight: height < size.height ? height : null,
  };
}

/** The side a submenu of `submenuWidth` opens to beside `menu` on `screen`:
 *  the right when it fits, else the left when that fits, else the side that
 *  overflows least, the right on a tie (Radix's submenu `flip`). */
export function submenuSide(menu: ScreenRect, submenuWidth: number, screen: ScreenRect): "right" | "left" {
  const bounds = boundsOf(screen, FLOATING_LAYER_EDGE_PX);
  const rightStart = menu.x + menu.width - SUBMENU_TRIGGER_INSET_PX;
  const leftStart = menu.x + SUBMENU_TRIGGER_INSET_PX - submenuWidth;
  const overflowRight = positive(rightStart + submenuWidth - bounds.right);
  const overflowLeft = positive(bounds.left - leftStart);
  return overflowRight === 0 || overflowRight <= overflowLeft ? "right" : "left";
}

/** Whether a menu of `size` can be drawn in the panel: wider or taller than
 *  the panel holds, it opens on the page as before. */
export function fitsPanel(size: MenuSize): boolean {
  return size.width <= MENU_ACTION_WIDTH_PX + 0.5 && size.height <= MENU_PANEL_MENU_MAX_HEIGHT_PX;
}

/**
 * The panel's top left corner on the screen for `placement`, its submenu
 * opening to `side`. Radix in the panel keeps `MENU_SHADOW_FIELD_PX` from its
 * edges, so the panel's edges less the field are the bounds it places in.
 * Across, they hold the menu and the submenu's side whole: Radix opens the
 * submenu to the side the screen allows. Down, the bound is the screen's own
 * (`collisionPadding` off its bottom) when the tallest submenu would reach
 * past it, so Radix lifts the submenu off the screen's bottom as it would
 * off a page's, and the panel reaches past the screen by the rest of the
 * field; otherwise the bound lies below anything the menu or a submenu
 * covers, and nothing moves.
 */
export function panelOrigin(placement: MenuPlacement, side: "right" | "left", screen: ScreenRect, panel: MenuSize = MENU_PANEL_SIZE): ScreenPoint {
  const { menu } = placement;
  const x = side === "right"
    ? menu.x - MENU_SHADOW_FIELD_PX
    : menu.x + menu.width + MENU_SHADOW_FIELD_PX - panel.width;
  const submenuBottom = menu.y + SUBMENU_TRIGGER_INSET_PX + MENU_PANEL_SUBMENU_MAX_HEIGHT_PX;
  const screenBound = screen.y + screen.height - FLOATING_LAYER_EDGE_PX;
  const bound = Math.max(menu.y + menu.height, Math.min(screenBound, submenuBottom));
  return { x, y: bound + MENU_SHADOW_FIELD_PX - panel.height };
}

/**
 * The point in the panel's page that Radix anchors the main menu to, so it
 * lands on `placement` exactly: a trigger of no size, with the side and the
 * edge the menu keeps from it. The dropdown wrapper sets its menu
 * `MENU_PLATE_GAP_PX` off the trigger, so the point stands that far off the
 * menu's edge. The edge is the one the menu came out of on the page, so the
 * menu grows from the same corner.
 */
export function panelAnchor(placement: MenuPlacement, origin: ScreenPoint): ScreenPoint {
  const { menu, side, align } = placement;
  const left = menu.x - origin.x;
  const top = menu.y - origin.y;
  switch (side) {
    case "bottom":
      return { x: align === "end" ? left + menu.width : left, y: top - MENU_PLATE_GAP_PX };
    case "top":
      return { x: align === "end" ? left + menu.width : left, y: top + menu.height + MENU_PLATE_GAP_PX };
    case "right":
      return { x: left - MENU_PLATE_GAP_PX, y: top };
    case "left":
      return { x: left + menu.width + MENU_PLATE_GAP_PX, y: top };
  }
}

/** The whole layout of one opening: where the menu stands, the panel's
 *  corner, the point Radix anchors to inside it. */
export interface PanelLayout {
  placement: MenuPlacement;
  submenu: "right" | "left";
  origin: ScreenPoint;
  anchor: ScreenPoint;
}

export function layoutPanel(opener: MenuOpener, size: MenuSize, screen: ScreenRect): PanelLayout {
  const placement = placeMenu(opener, size, screen);
  const submenu = submenuSide(placement.menu, MENU_SEARCH_WIDTH_PX, screen);
  const origin = panelOrigin(placement, submenu, screen);
  return { placement, submenu, origin, anchor: panelAnchor(placement, origin) };
}
