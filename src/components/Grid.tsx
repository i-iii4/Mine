import { useRef, useState, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { IndexedBlock } from "@/types";
import { Card } from "./Card";

const COLUMN_MIN_WIDTH = 220;
const ROW_HEIGHT = 240;
const GAP = 12;
const OVERSCAN = 5;

interface GridProps {
  blocks: IndexedBlock[];
  vaultPath: string;
  onBlockClick: (block: IndexedBlock) => void;
}

export function Grid({ blocks, vaultPath, onBlockClick }: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const parentWidth = useObservedWidth(parentRef);

  const columnCount = Math.max(1, Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)));
  const rowCount = Math.ceil(blocks.length / columnCount);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT + GAP,
    overscan: OVERSCAN,
  });

  const rows = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto p-4"
      style={{ contain: "strict" }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {rows.map((virtualRow) => {
          const startIdx = virtualRow.index * columnCount;
          const rowBlocks = blocks.slice(startIdx, startIdx + columnCount);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: virtualRow.start,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                display: "grid",
                gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
                gap: GAP,
              }}
            >
              {rowBlocks.map((block) => (
                <Card
                  key={block.id}
                  block={block}
                  vaultPath={vaultPath}
                  onClick={onBlockClick}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Observe container width for responsive column count
function useObservedWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);

  const observer = useMemo(
    () =>
      new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          setWidth(entry.contentRect.width);
        }
      }),
    [],
  );

  const callbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.disconnect();
      if (node) {
        observer.observe(node);
        setWidth(node.clientWidth);
      }
    },
    [observer],
  );

  // Sync ref
  useMemo(() => {
    if (ref.current) {
      callbackRef(ref.current);
    }
  }, [ref, callbackRef]);

  return width;
}

