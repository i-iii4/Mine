import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import type { IndexedBlock } from "@/types";
import { Card } from "./Card";

const COLUMN_MIN_WIDTH = 240;
const GAP = 16;
const INITIAL_BATCH = 80;
const BATCH_SIZE = 60;

interface GridProps {
  blocks: IndexedBlock[];
  vaultPath: string;
  onBlockClick: (block: IndexedBlock) => void;
  onContextMenu?: (block: IndexedBlock, x: number, y: number) => void;
}

export function Grid({ blocks, vaultPath, onBlockClick, onContextMenu }: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH);

  // Reset visible count only when the actual set of blocks changes
  // (channel switch, search) — not on background data refreshes that
  // produce the same blocks with a new array reference.
  const blocksFingerprint = useMemo(() => {
    const len = blocks.length;
    if (len === 0) return "empty";
    return `${len}:${blocks[0]!.id}:${blocks[len - 1]!.id}`;
  }, [blocks]);

  useEffect(() => {
    setVisibleCount(INITIAL_BATCH);
  }, [blocksFingerprint]);

  // Measure parent width
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setParentWidth(entry.contentRect.width);
    });

    setParentWidth(el.clientWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Load more when sentinel enters viewport
  const loadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + BATCH_SIZE, blocks.length));
  }, [blocks.length]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "400px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const columnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );

  const visibleBlocks = useMemo(
    () => blocks.slice(0, visibleCount),
    [blocks, visibleCount],
  );

  // Distribute blocks into columns (round-robin)
  const columns = useMemo(() => {
    const cols: IndexedBlock[][] = Array.from({ length: columnCount }, () => []);
    for (let i = 0; i < visibleBlocks.length; i++) {
      cols[i % columnCount]!.push(visibleBlocks[i]!);
    }
    return cols;
  }, [visibleBlocks, columnCount]);

  const hasMore = visibleCount < blocks.length;

  return (
    <div ref={parentRef} className="h-full overflow-x-hidden overflow-y-auto p-4">
      <div className="flex items-start" style={{ gap: GAP }}>
        {columns.map((col, colIdx) => (
          <div
            key={colIdx}
            className="flex min-w-0 flex-1 flex-col"
            style={{ gap: GAP }}
          >
            {col.map((block) => (
              <Card
                key={block.id}
                block={block}
                vaultPath={vaultPath}
                onClick={onBlockClick}
                onContextMenu={onContextMenu}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Sentinel for infinite scroll */}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          <p className="text-xs text-muted-foreground">
            {visibleCount} of {blocks.length}
          </p>
        </div>
      )}
    </div>
  );
}
