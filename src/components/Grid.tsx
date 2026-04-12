import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  memo,
  useLayoutEffect,
} from "react";
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
import type { WordWidths } from "@/types/fontMetrics";
import { Card } from "./Card";
import { CardTagMenu } from "./CardContextMenu";
import {
  computeMasonryLayout,
  createVisibilityIndex,
  getVisibleItemsFromIndex,
  type MasonryPosition,
  type MasonryLayout,
} from "@/lib/masonryLayout";
import { computeCardHeight } from "@/lib/cardHeight";
import { LayoutCache } from "@/lib/layoutCache";
import { fetchWordWidths } from "@/lib/fontMetrics";
import { useGridScroll } from "@/hooks/useGridScroll";

// ─── Layout constants ───────────────────────────────────────────────────────

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;
const OVERSCAN_BACKWARD_PX = 600;
const OVERSCAN_FORWARD_PX = 2200;
const PRIORITY_BACKWARD_PX = 200;
const PRIORITY_FORWARD_PX = 1400;

// ─── Feature detection ─────────────────────────────────────────────────────

const supportsGridLanes =
  typeof CSS !== "undefined" && CSS.supports("display", "grid-lanes");

// ─── Types ─────────────────────────────────────────────────────────────────

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

// ─── Layout cache (module-level, persists across channel switches) ─────────

const layoutCache = new LayoutCache(10);

// ─── Deterministic layout computation ──────────────────────────────────────

function buildLayout(
  blocks: LightBlock[],
  parentWidth: number,
  wordWidthsMap: Map<number, WordWidths>,
): MasonryLayout {
  // Derive the column width the same way computeMasonryLayout does internally.
  // We need this value up front so we can compute per-card heights with the
  // correct column width before handing the height array to the layout engine.
  const provisionalColumnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );
  const columnWidth = Math.max(
    1,
    (Math.max(0, parentWidth - GAP * (provisionalColumnCount - 1))) /
      provisionalColumnCount,
  );

  const heights = blocks.map((block) =>
    computeCardHeight(block, columnWidth, wordWidthsMap.get(block.id) ?? null),
  );

  return computeMasonryLayout(heights, parentWidth, COLUMN_MIN_WIDTH, GAP);
}

// ─── Grid component ────────────────────────────────────────────────────────

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
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);

  // Word widths map. Populated asynchronously once the worker finishes.
  // Before it arrives, computeCardHeight uses the conservative lower-bound
  // fallback — totalHeight grows (never shrinks) when widths arrive.
  const [wordWidthsMap, setWordWidthsMap] = useState<Map<number, WordWidths>>(
    () => new Map(),
  );

  // Scroll to top on explicit signal or channel change.
  useEffect(() => {
    parentRef.current?.scrollTo(0, 0);
  }, [scrollToTop, currentTag]);

  // Measure parent dimensions.
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

  // Fetch word widths for the current block set. Cached in IndexedDB and
  // in-memory — repeat visits to the same channel resolve instantly.
  useEffect(() => {
    if (blocks.length === 0) {
      setWordWidthsMap(new Map());
      return;
    }
    let cancelled = false;
    fetchWordWidths(blocks)
      .then((map) => {
        if (!cancelled) setWordWidthsMap(map);
      })
      .catch((err) => {
        console.warn("[Grid] fontMetrics fetch failed, using fallback heights", err);
        if (!cancelled) setWordWidthsMap(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [blocks]);

  // Compute (or retrieve from cache) the masonry layout for the current
  // blocks + parentWidth combination. When word widths arrive later, the
  // memo invalidates and recomputes with precise heights.
  const layout = useMemo((): MasonryLayout => {
    if (parentWidth <= 0 || blocks.length === 0) {
      return {
        columnCount: 1,
        columnWidth: 0,
        totalHeight: 0,
        positions: [],
      };
    }

    const cached = layoutCache.get(blocks, parentWidth);
    if (cached) return cached;

    const fresh = buildLayout(blocks, parentWidth, wordWidthsMap);
    layoutCache.set(blocks, parentWidth, fresh);
    return fresh;
  }, [blocks, parentWidth, wordWidthsMap]);

  // When word widths arrive for a layout we already computed with partial
  // data, the cached entry is stale. Invalidate it so the next render
  // recomputes with precise heights.
  const wordWidthsVersion = wordWidthsMap.size;
  useLayoutEffect(() => {
    // On wordWidths change, replace the cached entry for this (blocks,
    // parentWidth) with a freshly-computed one. Other channel entries stay
    // warm. The deps list intentionally only includes wordWidthsVersion —
    // the other values are read at call time and would otherwise trigger
    // redundant recomputes on every change.
    if (parentWidth > 0 && blocks.length > 0) {
      const fresh = buildLayout(blocks, parentWidth, wordWidthsMap);
      layoutCache.set(blocks, parentWidth, fresh);
    }
  }, [wordWidthsVersion, blocks, parentWidth, wordWidthsMap]);

  useEffect(() => {
    onColumnCountChange?.(layout.columnCount);
  }, [layout.columnCount, onColumnCountChange]);

  const visibilityIndex = useMemo(
    () => createVisibilityIndex(layout),
    [layout],
  );

  // Visible-items computation callback for useGridScroll. Closes over the
  // current visibility index. When layout changes, identity of the callback
  // changes, triggering an immediate recompute in useGridScroll.
  const getVisibleItems = useCallback(
    (scrollTop: number): MasonryPosition[] => {
      if (viewportHeight <= 0) return [];
      return getVisibleItemsFromIndex(
        visibilityIndex,
        scrollTop,
        viewportHeight,
        OVERSCAN_BACKWARD_PX,
        OVERSCAN_FORWARD_PX,
      );
    },
    [visibilityIndex, viewportHeight],
  );

  const visibleItems = useGridScroll(parentRef, { getVisibleItems });

  // Priority zone — cards in this range get eager image loading.
  const priorityBounds = useMemo(() => {
    return {
      start: PRIORITY_BACKWARD_PX,
      end: PRIORITY_FORWARD_PX,
    };
  }, []);

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
    [
      vaultPath,
      focusedBlockId,
      onBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      handleRequestDelete,
    ],
  );

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
          {parentWidth > 0 && blocks.length > 0 && (
            supportsGridLanes ? (
              <GridLanesLayout
                key={currentTag ?? "__all__"}
                blocks={blocks}
                wordWidthsMap={wordWidthsMap}
                parentWidth={parentWidth}
                context={gridContext}
              />
            ) : (
              <VirtualMasonryLayout
                key={currentTag ?? "__all__"}
                blocks={blocks}
                visibleItems={visibleItems}
                totalHeight={layout.totalHeight}
                priorityBounds={priorityBounds}
                context={gridContext}
              />
            )
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

// ─── JS virtualized path (fallback for browsers without grid-lanes) ────────

function VirtualMasonryLayout({
  blocks,
  visibleItems,
  totalHeight,
  priorityBounds,
  context,
}: {
  blocks: LightBlock[];
  visibleItems: MasonryPosition[];
  totalHeight: number;
  priorityBounds: { start: number; end: number };
  context: GridContext;
}) {
  return (
    <div className="relative" style={{ height: totalHeight || 1 }}>
      {visibleItems.map((item) => {
        const block = blocks[item.index];
        if (!block) return null;
        return (
          <GridItem
            key={block.id}
            block={block}
            item={item}
            priority={
              item.top <= priorityBounds.end && item.bottom >= priorityBounds.start
            }
            context={context}
          />
        );
      })}
    </div>
  );
}

const GridItem = memo(function GridItem({
  block,
  item,
  priority,
  context,
}: {
  block: LightBlock;
  item: MasonryPosition;
  priority: boolean;
  context: GridContext;
}) {
  return (
    <div
      className="will-change-transform"
      style={{
        position: "absolute",
        width: item.width,
        height: item.height,
        transform: `translate3d(${item.left}px, ${item.top}px, 0)`,
      }}
    >
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
  );
});

// ─── Native grid-lanes path (Safari 26.4+) ─────────────────────────────────

function GridLanesLayout({
  blocks,
  wordWidthsMap,
  parentWidth,
  context,
}: {
  blocks: LightBlock[];
  wordWidthsMap: Map<number, WordWidths>;
  parentWidth: number;
  context: GridContext;
}) {
  // Derive column width the same way buildLayout does, for contain-intrinsic-size
  const provisionalColumnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );
  const columnWidth = Math.max(
    1,
    (Math.max(0, parentWidth - GAP * (provisionalColumnCount - 1))) /
      provisionalColumnCount,
  );

  return (
    <div
      style={{
        display: "grid-lanes" as unknown as string,
        gridTemplateColumns: `repeat(auto-fill, minmax(${COLUMN_MIN_WIDTH}px, 1fr))`,
        gap: GAP,
      }}
    >
      {blocks.map((block, idx) => {
        const height = computeCardHeight(
          block,
          columnWidth,
          wordWidthsMap.get(block.id) ?? null,
        );
        return (
          <div
            key={block.id}
            style={{
              contentVisibility: "auto",
              containIntrinsicSize: `auto ${height}px`,
            }}
          >
            <Card
              block={block}
              vaultPath={context.vaultPath}
              isFocused={block.id === context.focusedBlockId}
              priority={idx < 12}
              onClick={context.onBlockClick}
              tags={context.tags}
              currentTag={context.currentTag}
              onToggleTag={context.onToggleTag}
              onCreateAndAssign={context.onCreateAndAssign}
              onRequestDelete={context.onRequestDelete}
            />
          </div>
        );
      })}
    </div>
  );
}
