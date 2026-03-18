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
import type { LightBlock, TagCount } from "@/types";
import { Card } from "./Card";
import { CardTagMenu } from "./CardContextMenu";

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;
const INITIAL_BATCH = 80;
const BATCH_SIZE = 60;

interface GridProps {
  blocks: LightBlock[];
  vaultPath: string;
  tags: TagCount[];
  currentTag?: string;
  scrollToTop: number;
  sidebarCollapsed?: boolean;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onDeleteBlock: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
}

export function Grid({
  blocks,
  vaultPath,
  tags,
  currentTag,
  scrollToTop,
  sidebarCollapsed = false,
  focusedBlockId,
  onBlockClick,
  onToggleTag,
  onCreateAndAssign,
  onDeleteBlock,
  onColumnCountChange,
}: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(INITIAL_BATCH);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);

  // Fingerprint detects real dataset changes (channel switch, search)
  // while ignoring background refreshes with the same data.
  const blocksFingerprint = useMemo(() => {
    const len = blocks.length;
    if (len === 0) return "empty";
    return `${len}:${blocks[0]!.id}:${blocks[len - 1]!.id}`;
  }, [blocks]);

  // Synchronous reset: runs DURING render, before browser paint.
  // useEffect would run AFTER paint, causing a heavy frame with stale
  // visibleCount (e.g. 300 cards from the previous channel).
  const [prevFingerprint, setPrevFingerprint] = useState(blocksFingerprint);
  if (blocksFingerprint !== prevFingerprint) {
    setPrevFingerprint(blocksFingerprint);
    setVisibleCount(INITIAL_BATCH);
  }

  // Scroll to top only on explicit signal (same-channel click)
  useEffect(() => {
    if (scrollToTop > 0) {
      parentRef.current?.scrollTo(0, 0);
    }
  }, [scrollToTop]);

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

  // O(1) block lookup for context menu event delegation
  const blocksBySlug = useMemo(
    () => new Map(blocks.map((b) => [b.slug, b])),
    [blocks],
  );

  // Event delegation: single handler identifies which card was right-clicked.
  // composeEventHandlers in Radix checks defaultPrevented — calling
  // e.preventDefault() suppresses the menu on empty-space clicks.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const el = (e.target as HTMLElement).closest("[data-block-slug]");
      if (!el) {
        e.preventDefault();
        return;
      }
      const slug = el.getAttribute("data-block-slug")!;
      const block = blocksBySlug.get(slug);
      if (block) {
        setMenuBlock(block);
      } else {
        e.preventDefault();
      }
    },
    [blocksBySlug],
  );

  const columnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );

  useEffect(() => {
    onColumnCountChange?.(columnCount);
  }, [columnCount, onColumnCountChange]);

  const visibleBlocks = useMemo(
    () => blocks.slice(0, visibleCount),
    [blocks, visibleCount],
  );

  // Distribute blocks into columns (round-robin)
  const columns = useMemo(() => {
    const cols: LightBlock[][] = Array.from({ length: columnCount }, () => []);
    for (let i = 0; i < visibleBlocks.length; i++) {
      cols[i % columnCount]!.push(visibleBlocks[i]!);
    }
    return cols;
  }, [visibleBlocks, columnCount]);

  const hasMore = visibleCount < blocks.length;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={parentRef}
          onContextMenu={handleContextMenu}
          className="h-full overflow-x-hidden overflow-y-auto pb-8 pt-16"
          style={{
            paddingLeft: sidebarCollapsed ? 72 : 32,
            paddingRight: sidebarCollapsed ? 72 : 32,
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
        >
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
                    isFocused={block.id === focusedBlockId}
                    onClick={onBlockClick}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Sentinel for infinite scroll */}
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-8">
              <p className="text-sm text-muted-foreground">
                {visibleCount} of {blocks.length}
              </p>
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      {/* Single CardTagMenu instance — renders only when a card was right-clicked */}
      {menuBlock && (
        <CardTagMenu
          block={menuBlock}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestDelete={setBlockToDelete}
        />
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
    </ContextMenu>
  );
}
