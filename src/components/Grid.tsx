import { useRef, useState, useEffect, useMemo } from "react";
import type { IndexedBlock } from "@/types";
import { Card } from "./Card";

const COLUMN_MIN_WIDTH = 240;
const GAP = 16;

interface GridProps {
  blocks: IndexedBlock[];
  vaultPath: string;
  onBlockClick: (block: IndexedBlock) => void;
}

export function Grid({ blocks, vaultPath, onBlockClick }: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);

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

  const columnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );

  // Distribute blocks into columns using shortest-column algorithm.
  // This gives a left-to-right visual flow like Pinterest.
  const columns = useMemo(() => {
    const cols: IndexedBlock[][] = Array.from({ length: columnCount }, () => []);
    // Simple round-robin for now (heights unknown until rendered).
    // A height-aware algorithm would require measuring, but round-robin
    // produces a visually balanced result when card heights are mixed.
    for (let i = 0; i < blocks.length; i++) {
      cols[i % columnCount]!.push(blocks[i]!);
    }
    return cols;
  }, [blocks, columnCount]);

  return (
    <div ref={parentRef} className="h-full overflow-y-auto p-4">
      <div className="flex items-start" style={{ gap: GAP }}>
        {columns.map((col, colIdx) => (
          <div
            key={colIdx}
            className="flex flex-1 flex-col"
            style={{ gap: GAP }}
          >
            {col.map((block) => (
              <Card
                key={block.id}
                block={block}
                vaultPath={vaultPath}
                onClick={onBlockClick}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
