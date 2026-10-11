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

/// How far a dropdown menu stands from the visible plate of the button that
/// opened it: the surface inset, `--spacing-surface` (user's decision of
/// 11.10.2026; DESIGN_SYSTEM.md, «Всплывающие элементы», «Отступ от кнопки»).
export const MENU_PLATE_GAP_PX = 4;

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
  const inset: Record<MenuSide, number> = {
    top: plate.top - trigger.top,
    right: trigger.right - plate.right,
    bottom: trigger.bottom - plate.bottom,
    left: plate.left - trigger.left,
  };
  const acrossTop = side === "top" || side === "bottom";
  const alignEdge: MenuSide = acrossTop
    ? align === "start" ? "left" : "right"
    : align === "start" ? "top" : "bottom";
  return { sideOffset: MENU_PLATE_GAP_PX - inset[side], alignOffset: inset[alignEdge] };
}

/** What a menu measures from: a chrome control's plate (`ChromePlate`), or
 *  the button itself, whose box is the plate one sees. */
export function menuPlateOf(trigger: HTMLElement): HTMLElement {
  return trigger.querySelector<HTMLElement>("[data-chrome-plate]") ?? trigger;
}
