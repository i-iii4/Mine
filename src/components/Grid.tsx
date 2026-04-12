import { useRef, useState, useEffect, useLayoutEffect, useMemo, useCallback, memo } from "react";
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
import {
  computeMasonryLayout,
  getVisibleMasonryItems,
  type MasonryPosition,
} from "@/lib/masonryLayout";

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;
const OVERSCAN_BACKWARD_PX = 600;
const OVERSCAN_FORWARD_PX = 2200;
const PRIORITY_BACKWARD_PX = 200;
const PRIORITY_FORWARD_PX = 1400;
const DEFAULT_CARD_HEIGHT = 240;
const SCROLL_IDLE_MS = 120;

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

interface GridContext {
  vaultPath: string;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestDelete: (slug: string) => void;
}

// Estimates used only as a last-resort fallback, before any per-type running
// average is available. Bias toward UNDERestimation: when measurements later
// correct the height upward, `totalHeight` grows — scroll position remains
// valid (content extends below). Overestimation causes `totalHeight` to shrink
// on correction, which forces the browser to clamp scrollTop and produces a
// visible "jump".
function estimateCardHeight(block: LightBlock, columnWidth: number): number {
  switch (block.block_type) {
    case "image":
      if (block.width && block.height && block.width > 0) {
        return Math.max(120, Math.round(columnWidth * (block.height / block.width)));
      }
      // No metadata — assume a conservative default, not a square (which
      // inflates totalHeight for landscape/wide photos).
      return DEFAULT_CARD_HEIGHT;
    case "video":
      return Math.round(columnWidth * 9 / 16);
    case "link":
      // Text-only height. If a thumbnail loads later, onMeasure corrects
      // upward and totalHeight grows — no scroll jump.
      return 76;
    case "file":
      return 88;
    case "article": {
      const titleLength = block.title?.length ?? block.slug.length;
      const titleLines = Math.min(2, Math.max(1, Math.ceil(titleLength / 26)));
      const previewChars = Math.min(400, block.body.length);
      const charsPerLine = Math.max(18, Math.floor(columnWidth / 7));
      const previewLines = Math.min(
        block.first_image ? 3 : 8,
        Math.max(2, Math.ceil(previewChars / charsPerLine)),
      );
      // Smaller image coefficient — if actual image is larger, measurement
      // corrects upward (safe); if image fails to load, we haven't inflated.
      const imageHeight = block.first_image ? Math.round(columnWidth * 0.4) + 12 : 0;
      return 32 + titleLines * 20 + previewLines * 18 + imageHeight + (block.author ? 24 : 0) + 28;
    }
    default:
      return DEFAULT_CARD_HEIGHT;
  }
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
  const scrollRafRef = useRef<number | null>(null);
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);
  const pendingHeightsRef = useRef<Record<string, number>>({});
  const prevLayoutRef = useRef<ReturnType<typeof computeMasonryLayout> | null>(null);
  const prevParentWidthRef = useRef(0);
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollDirection, setScrollDirection] = useState<"up" | "down">("down");
  const [isScrolling, setIsScrolling] = useState(false);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});

  useEffect(() => {
    parentRef.current?.scrollTo(0, 0);
    setScrollTop(0);
    setMeasuredHeights({});
    pendingHeightsRef.current = {};
  }, [scrollToTop, currentTag]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (entry.contentRect.width > 0) setParentWidth(entry.contentRect.width);
      if (entry.contentRect.height > 0) setViewportHeight(entry.contentRect.height);
    });

    setParentWidth(el.clientWidth);
    setViewportHeight(el.clientHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      if (scrollIdleTimeoutRef.current !== null) {
        clearTimeout(scrollIdleTimeoutRef.current);
      }
    };
  }, []);

  // Running average of actual measured heights grouped by block_type.
  // As the user scrolls and more cards get measured, this average converges
  // to reality, and any remaining unmeasured card of the same type gets a
  // nearly-accurate height estimate. This eliminates most of the totalHeight
  // correction when reaching previously unseen cards at the end of the feed.
  const avgHeightByType = useMemo(() => {
    const acc: Record<string, { sum: number; count: number }> = {};
    for (const block of blocks) {
      const h = measuredHeights[block.slug];
      if (h == null) continue;
      const entry = acc[block.block_type] ?? { sum: 0, count: 0 };
      entry.sum += h;
      entry.count += 1;
      acc[block.block_type] = entry;
    }
    const result: Record<string, number> = {};
    for (const type of Object.keys(acc)) {
      const entry = acc[type]!;
      result[type] = entry.sum / entry.count;
    }
    return result;
  }, [blocks, measuredHeights]);

  const estimatedHeights = useMemo(() => {
    const provisionalColumnCount = Math.max(
      1,
      Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
    );
    const columnWidth = Math.max(
      1,
      (Math.max(0, parentWidth - GAP * (provisionalColumnCount - 1))) / provisionalColumnCount,
    );
    // Priority order for each block's height:
    //   1. Exact measured height — ground truth.
    //   2. Running average of same block_type — accurate once a few cards
    //      of that type are on screen.
    //   3. Static estimateCardHeight fallback — used only for the very first
    //      cards before any average is available.
    return blocks.map((block) =>
      measuredHeights[block.slug]
        ?? avgHeightByType[block.block_type]
        ?? estimateCardHeight(block, columnWidth),
    );
  }, [blocks, measuredHeights, avgHeightByType, parentWidth]);

  const layout = useMemo(
    () => computeMasonryLayout(estimatedHeights, parentWidth, COLUMN_MIN_WIDTH, GAP),
    [estimatedHeights, parentWidth],
  );

  // Scroll anchoring: when layout changes due to height corrections (not
  // container resize), preserve the visual position of the card currently at
  // the top of the viewport. Without this, totalHeight changes from measurement
  // corrections would cause visible scroll jumps, especially when reaching
  // previously unmeasured cards at the end of the feed.
  //
  // useLayoutEffect runs after React commit but before browser paint — any
  // scrollTop adjustment we make here is invisible to the user.
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current;
    const el = parentRef.current;
    const widthChanged = parentWidth !== prevParentWidthRef.current;

    // Only anchor on pure height corrections. During container resize, the
    // grid legitimately reflows (different column count/width) and the user
    // expects that — anchoring would fight the resize animation.
    if (prev && el && !widthChanged) {
      const currentScroll = el.scrollTop;

      // Anchor card: first position that straddles (or is just below) the
      // top edge of the viewport. Slight forward bias (+100) ensures we pick
      // a card the user is actively looking at, not one just out of view.
      const anchorIndex = prev.positions.findIndex(
        (p) => p.top <= currentScroll + 100 && p.bottom > currentScroll,
      );

      if (anchorIndex >= 0) {
        const oldTop = prev.positions[anchorIndex]!.top;
        const newPos = layout.positions[anchorIndex];
        if (newPos && newPos.top !== oldTop) {
          el.scrollTop = currentScroll + (newPos.top - oldTop);
        }
      }
    }

    prevLayoutRef.current = layout;
    prevParentWidthRef.current = parentWidth;
  }, [layout, parentWidth]);

  useEffect(() => {
    onColumnCountChange?.(layout.columnCount);
  }, [layout.columnCount, onColumnCountChange]);

  const visibleItems = useMemo(
    () => {
      const overscanBefore = scrollDirection === "down" ? OVERSCAN_BACKWARD_PX : OVERSCAN_FORWARD_PX;
      const overscanAfter = scrollDirection === "down" ? OVERSCAN_FORWARD_PX : OVERSCAN_BACKWARD_PX;
      return getVisibleMasonryItems(layout.positions, scrollTop, viewportHeight, overscanBefore, overscanAfter);
    },
    [layout.positions, scrollDirection, scrollTop, viewportHeight],
  );

  const priorityBounds = useMemo(() => {
    const before = scrollDirection === "down" ? PRIORITY_BACKWARD_PX : PRIORITY_FORWARD_PX;
    const after = scrollDirection === "down" ? PRIORITY_FORWARD_PX : PRIORITY_BACKWARD_PX;
    return {
      start: Math.max(0, scrollTop - before),
      end: scrollTop + viewportHeight + after,
    };
  }, [scrollDirection, scrollTop, viewportHeight]);

  const blocksBySlug = useMemo(
    () => new Map(blocks.map((block) => [block.slug, block])),
    [blocks],
  );

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

  const handleRequestDelete = useCallback((slug: string) => {
    setBlockToDelete(slug);
  }, []);

  const flushPendingHeights = useCallback(() => {
    const entries = Object.entries(pendingHeightsRef.current);
    if (entries.length === 0) return;

    setMeasuredHeights((prev) => {
      let changed = false;
      const next = { ...prev };

      for (const [slug, height] of entries) {
        if (Math.abs((next[slug] ?? 0) - height) >= 1) {
          next[slug] = height;
          changed = true;
        }
      }

      return changed ? next : prev;
    });

    pendingHeightsRef.current = {};
  }, []);

  const handleMeasure = useCallback((slug: string, height: number) => {
    if (isScrolling) {
      pendingHeightsRef.current[slug] = height;
      return;
    }

    setMeasuredHeights((prev) => {
      if (Math.abs((prev[slug] ?? 0) - height) < 1) return prev;
      return { ...prev, [slug]: height };
    });
  }, [isScrolling]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = e.currentTarget.scrollTop;
    setIsScrolling(true);

    if (scrollIdleTimeoutRef.current !== null) {
      clearTimeout(scrollIdleTimeoutRef.current);
    }
    scrollIdleTimeoutRef.current = setTimeout(() => {
      scrollIdleTimeoutRef.current = null;
      setIsScrolling(false);
      flushPendingHeights();
    }, SCROLL_IDLE_MS);

    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const nextDirection = nextScrollTop < lastScrollTopRef.current ? "up" : "down";
      lastScrollTopRef.current = nextScrollTop;
      setScrollDirection(nextDirection);
      setScrollTop(nextScrollTop);
    });
  }, [flushPendingHeights]);

  const gridContext: GridContext = useMemo(
    () => ({
      vaultPath,
      focusedBlockId,
      onBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      onRequestDelete: handleRequestDelete,
    }),
    [vaultPath, focusedBlockId, onBlockClick, tags, currentTag, onToggleTag, onCreateAndAssign, handleRequestDelete],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={parentRef}
          onScroll={handleScroll}
          onContextMenu={handleContextMenu}
          className="h-full overflow-x-hidden overflow-y-auto pb-8 pt-16"
          style={{
            paddingLeft: sidebarCollapsed ? 72 : 32,
            paddingRight: sidebarCollapsed ? 72 : 32,
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
        >
          {parentWidth > 0 && blocks.length > 0 && (
            <VirtualMasonryLayout
              key={currentTag ?? "__all__"}
              blocks={blocks}
              visibleItems={visibleItems}
              totalHeight={layout.totalHeight}
              priorityBounds={priorityBounds}
              context={gridContext}
              onMeasure={handleMeasure}
            />
          )}
        </div>
      </ContextMenuTrigger>

      {menuBlock && (
        <CardTagMenu
          block={menuBlock}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
        />
      )}

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

function VirtualMasonryLayout({
  blocks,
  visibleItems,
  totalHeight,
  priorityBounds,
  context,
  onMeasure,
}: {
  blocks: LightBlock[];
  visibleItems: MasonryPosition[];
  totalHeight: number;
  priorityBounds: { start: number; end: number };
  context: GridContext;
  onMeasure: (slug: string, height: number) => void;
}) {
  return (
    <div className="relative" style={{ height: totalHeight || 1 }}>
      {visibleItems.map((item) => {
        const block = blocks[item.index];
        if (!block) return null;
        return (
          <MeasuredGridItem
            key={block.id}
            block={block}
            item={item}
            priority={item.bottom >= priorityBounds.start && item.top <= priorityBounds.end}
            context={context}
            onMeasure={onMeasure}
          />
        );
      })}
    </div>
  );
}

const MeasuredGridItem = memo(function MeasuredGridItem({
  block,
  item,
  priority,
  context,
  onMeasure,
}: {
  block: LightBlock;
  item: MasonryPosition;
  priority: boolean;
  context: GridContext;
  onMeasure: (slug: string, height: number) => void;
}) {
  const observerRef = useRef<ResizeObserver | null>(null);

  const handleNode = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) return;

    onMeasure(block.slug, node.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        onMeasure(block.slug, entry.contentRect.height);
      }
    });
    observer.observe(node);
    observerRef.current = observer;
  }, [block.slug, onMeasure]);

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        width: item.width,
        transform: `translate(${item.left}px, ${item.top}px)`,
      }}
    >
      <div ref={handleNode}>
        <Card
          block={block}
          vaultPath={context.vaultPath}
          isFocused={block.id === context.focusedBlockId}
          priority={priority}
          onClick={context.onBlockClick}
          tags={context.tags}
          currentTag={context.currentTag}
          onToggleTag={context.onToggleTag}
          onCreateAndAssign={context.onCreateAndAssign}
          onRequestDelete={context.onRequestDelete}
        />
      </div>
    </div>
  );
});
