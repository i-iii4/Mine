import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { IndexedBlock, TagCount } from "@/types";
import { Card } from "./Card";
import { CardTagMenu } from "./CardContextMenu";

const COLUMN_MIN_WIDTH = 240;
const GAP = 16;
const INITIAL_BATCH = 80;
const BATCH_SIZE = 60;

interface GridProps {
  blocks: IndexedBlock[];
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  onBlockClick: (block: IndexedBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDeleteBlock: (slug: string) => void;
}

export function Grid({
  blocks,
  vaultPath,
  tags,
  currentTag,
  onBlockClick,
  onToggleTag,
  onCreateAndAssign,
  onDeleteBlock,
}: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);

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
              <ContextMenu key={block.id}>
                <ContextMenuTrigger asChild>
                  <div>
                    <Card
                      block={block}
                      vaultPath={vaultPath}
                      onClick={onBlockClick}
                    />
                  </div>
                </ContextMenuTrigger>
                <CardTagMenu
                  block={block}
                  tags={tags}
                  currentTag={currentTag}
                  onToggleTag={onToggleTag}
                  onCreateAndAssign={onCreateAndAssign}
                  onRequestDelete={setBlockToDelete}
                />
              </ContextMenu>
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

      {/* Delete confirmation — lives at Grid level, survives ContextMenu close */}
      <AlertDialog
        open={blockToDelete !== null}
        onOpenChange={(open) => { if (!open) setBlockToDelete(null); }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete card</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the card and its files.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (blockToDelete) onDeleteBlock(blockToDelete);
                setBlockToDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
