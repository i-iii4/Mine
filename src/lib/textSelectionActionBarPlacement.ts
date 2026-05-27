export const TEXT_SELECTION_ACTION_BAR_HEIGHT_PX = 32;
export const TEXT_SELECTION_ACTION_BAR_GAP_PX = 8;
export const TEXT_SELECTION_ACTION_BAR_VIEWPORT_MARGIN_PX = 8;

export interface TextSelectionAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TextSelectionActionBarPlacementInput {
  anchorRect: TextSelectionAnchorRect;
  toolbarWidth: number;
  toolbarHeight?: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportMargin?: number;
  gap?: number;
  safeBounds?: TextSelectionSafeBounds;
}

export interface TextSelectionActionBarPlacement {
  left: number;
  top: number;
  side: "above" | "below";
}

export interface TextSelectionSafeBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function placeTextSelectionActionBar({
  anchorRect,
  toolbarWidth,
  toolbarHeight = TEXT_SELECTION_ACTION_BAR_HEIGHT_PX,
  viewportWidth,
  viewportHeight,
  viewportMargin = TEXT_SELECTION_ACTION_BAR_VIEWPORT_MARGIN_PX,
  gap = TEXT_SELECTION_ACTION_BAR_GAP_PX,
  safeBounds,
}: TextSelectionActionBarPlacementInput): TextSelectionActionBarPlacement {
  const bounds = safeBounds ?? {
    left: viewportMargin,
    right: viewportWidth - viewportMargin,
    top: viewportMargin,
    bottom: viewportHeight - viewportMargin,
  };
  const anchorCenterX = anchorRect.left + anchorRect.width / 2;
  const idealLeft = anchorCenterX - toolbarWidth / 2;
  const maxLeft = bounds.right - toolbarWidth;
  const left = clamp(idealLeft, bounds.left, maxLeft);

  const aboveTop = anchorRect.top - toolbarHeight - gap;
  if (aboveTop >= bounds.top) {
    return { left, top: aboveTop, side: "above" };
  }

  const belowTop = anchorRect.bottom + gap;
  const maxTop = bounds.bottom - toolbarHeight;
  return {
    left,
    top: clamp(belowTop, bounds.top, maxTop),
    side: "below",
  };
}
