export interface MasonryPosition {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  column: number;
}

export interface MasonryLayout {
  columnCount: number;
  columnWidth: number;
  totalHeight: number;
  positions: MasonryPosition[];
}

function clampPositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getMasonryColumnCount(
  containerWidth: number,
  minColumnWidth: number,
  gap: number,
): number {
  const width = clampPositive(containerWidth);
  const minWidth = Math.max(1, minColumnWidth);
  const safeGap = clampPositive(gap);
  return Math.max(1, Math.floor((width + safeGap) / (minWidth + safeGap)));
}

export function computeMasonryLayout(
  itemHeights: number[],
  containerWidth: number,
  minColumnWidth: number,
  gap: number,
): MasonryLayout {
  const columnCount = getMasonryColumnCount(containerWidth, minColumnWidth, gap);
  const safeGap = clampPositive(gap);
  const innerWidth = Math.max(0, clampPositive(containerWidth) - safeGap * (columnCount - 1));
  const columnWidth = Math.max(1, innerWidth / columnCount);

  const columnHeights = new Array<number>(columnCount).fill(0);
  const positions: MasonryPosition[] = [];

  itemHeights.forEach((rawHeight, index) => {
    const height = Math.max(1, rawHeight);
    let targetColumn = 0;

    for (let i = 1; i < columnCount; i += 1) {
      if (columnHeights[i]! < columnHeights[targetColumn]!) {
        targetColumn = i;
      }
    }

    const top = columnHeights[targetColumn]!;
    const left = targetColumn * (columnWidth + safeGap);
    const bottom = top + height;

    positions.push({
      index,
      top,
      left,
      width: columnWidth,
      height,
      bottom,
      column: targetColumn,
    });

    columnHeights[targetColumn] = bottom + safeGap;
  });

  const totalHeight = Math.max(0, ...columnHeights.map((height) => (height > 0 ? height - safeGap : 0)));

  return {
    columnCount,
    columnWidth,
    totalHeight,
    positions,
  };
}

export function getVisibleMasonryItems(
  positions: MasonryPosition[],
  scrollTop: number,
  viewportHeight: number,
  overscanBefore: number,
  overscanAfter: number,
): MasonryPosition[] {
  const start = Math.max(0, scrollTop - overscanBefore);
  const end = Math.max(start, scrollTop + viewportHeight + overscanAfter);

  return positions.filter((position) => position.bottom >= start && position.top <= end);
}
