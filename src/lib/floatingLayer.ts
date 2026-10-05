/// How far every floating layer keeps from the window's edges: the outer
/// padding of the chrome's controls, `--chrome-icon-edge-pad`
/// (DESIGN_SYSTEM.md, «Всплывающие элементы»). The layer wrappers take it as
/// their default `collisionPadding`; a call site may pass its own.
export const FLOATING_LAYER_EDGE_PX = 8;
