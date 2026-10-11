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
