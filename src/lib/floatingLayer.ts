/// How far every floating layer keeps from the window's edges: the chrome's
/// edge inset, `--chrome-edge-pad` (DESIGN_SYSTEM.md, «Всплывающие
/// элементы»). The layer wrappers take it as their default
/// `collisionPadding`; a call site may pass its own.
export const FLOATING_LAYER_EDGE_PX = 8;

/**
 * A menu's width comes from its role, never from its rows (user's decision
 * of 11.10.2026; DESIGN_SYSTEM.md, «Всплывающие элементы», «Ширина»):
 * `action` for menus of actions and panels, `search` for a list under a
 * search field. The wrappers put the role on `data-floating-menu`, and
 * global.css alone holds the width of each; a row that does not fit is cut
 * with an ellipsis.
 */
export type FloatingMenuWidth = "action" | "search";

/// How far a dropdown menu and a tooltip stand from the visible plate of
/// their button: the surface inset, `--spacing-surface` (user's decisions of
/// 11.10.2026 for menus and 15.11.2026 for tooltips; DESIGN_SYSTEM.md,
/// «Всплывающие элементы», «Отступ от кнопки»).
export const MENU_PLATE_GAP_PX = 4;

/// How far a menu a right click opened stands from the point of the click:
/// nothing, its corner is on the point, as `NSMenu.popUpContextMenu` puts a
/// system menu (user's decision of 15.11.2026; SPEC_MENU_WINDOW.md, МО10).
export const MENU_POINT_OFFSET_PX = 0;

/** What a menu stands at: the plate of its button, or the point of a click. */
export type MenuAnchor = "plate" | "point";

export type MenuSide = "top" | "right" | "bottom" | "left";

/** A menu stands flush with one edge of its button's plate: the start edge
 *  for a button on the left, the end edge for a button at the right. */
export type MenuAlign = "start" | "end";

export interface MenuPlateOffsets {
  sideOffset: number;
  alignOffset: number;
}

type Box = Pick<DOMRectReadOnly, "top" | "right" | "bottom" | "left">;

/**
 * How far from the box Radix anchors to (the trigger) a layer stands on
 * `side` so that it stands `MENU_PLATE_GAP_PX` off the plate one sees inside
 * that box. A chrome button is as tall as its row and its 24px plate stands
 * centred in it: counted from the box, the same 4 read as 7 or 11.5 (user's
 * reports of 11.10.2026 for a menu, 15.11.2026 for a tooltip). The menus and
 * the tooltips take it alike.
 */
export function plateSideOffset(trigger: Box, plate: Box, side: MenuSide): number {
  const inset: Record<MenuSide, number> = {
    top: plate.top - trigger.top,
    right: trigger.right - plate.right,
    bottom: trigger.bottom - plate.bottom,
    left: plate.left - trigger.left,
  };
  return MENU_PLATE_GAP_PX - inset[side];
}

/**
 * The offsets that put a menu `MENU_PLATE_GAP_PX` off its button's plate
 * and flush with the plate's `align` edge, from the box Radix anchors to
 * (the trigger) and the plate one sees inside it. A chrome button is as tall
 * as its row and its 24px plate stands centred in it: counted from the box,
 * the same 4 read as 7 or 11.5 (user's report of 11.10.2026).
 */
export function menuPlateOffsets(
  trigger: Box,
  plate: Box,
  side: MenuSide,
  align: MenuAlign,
): MenuPlateOffsets {
  const acrossTop = side === "top" || side === "bottom";
  const alignOffset = acrossTop
    ? align === "start" ? plate.left - trigger.left : trigger.right - plate.right
    : align === "start" ? plate.top - trigger.top : trigger.bottom - plate.bottom;
  return { sideOffset: plateSideOffset(trigger, plate, side), alignOffset };
}

/** What a menu or a tooltip measures from: a chrome control's plate
 *  (`ChromePlate`), or the button itself, whose box is the plate one sees. */
export function menuPlateOf(trigger: HTMLElement): HTMLElement {
  return trigger.querySelector<HTMLElement>("[data-chrome-plate]") ?? trigger;
}
