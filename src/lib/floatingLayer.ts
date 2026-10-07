import { useCallback, type Ref } from "react";

/// How far every floating layer keeps from the window's edges: the chrome's
/// edge inset, `--chrome-edge-pad` (DESIGN_SYSTEM.md, «Всплывающие
/// элементы»). The layer wrappers take it as their default
/// `collisionPadding`; a call site may pass its own.
export const FLOATING_LAYER_EDGE_PX = 8;

/**
 * Every menu, submenu and context menu is as wide as its longest row,
 * between 128px and 300px (global.css, `[data-floating-menu]`;
 * DESIGN_SYSTEM.md, «Всплывающие элементы», «Ширина»). A list with a search
 * field would narrow as its rows are filtered away, so the width the menu
 * opened with becomes its least: a row that arrives later may still widen
 * it, a query never narrows it. Merged with the caller's ref.
 */
export function useHeldMenuWidth<T extends HTMLElement>(ref?: Ref<T>): (node: T | null) => void {
  return useCallback(
    (node: T | null) => {
      if (node) {
        const width = node.offsetWidth;
        if (width > 0) node.style.minWidth = `${width}px`;
      }
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
}
