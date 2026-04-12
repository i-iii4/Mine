import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  memo,
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
import { Card } from "./Card";
import { MeasureCard } from "./MeasureCard";
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
import {
  bucketize,
  setCachedHeight,
  partitionByCache,
  persistHeights,
  warmFromIndexedDb,
} from "@/lib/heightCache";
import { useGridScroll } from "@/hooks/useGridScroll";

// ─── Layout constants ───────────────────────────────────────────────────────

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;
const OVERSCAN_BACKWARD_PX = 600;
const OVERSCAN_FORWARD_PX = 2200;
const PRIORITY_BACKWARD_PX = 200;
const PRIORITY_FORWARD_PX = 1400;

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

/** One-time promise for warming in-memory cache from IndexedDB on first mount. */
let warmedUp: Promise<void> | null = null;
function ensureWarmed(): Promise<void> {
  if (!warmedUp) {
    warmedUp = warmFromIndexedDb();
  }
  return warmedUp;
}

// ─── Deterministic layout computation ──────────────────────────────────────

function deriveColumnWidth(parentWidth: number): number {
  const provisionalColumnCount = Math.max(
    1,
    Math.floor((parentWidth + GAP) / (COLUMN_MIN_WIDTH + GAP)),
  );
  return Math.max(
    1,
    (Math.max(0, parentWidth - GAP * (provisionalColumnCount - 1))) /
      provisionalColumnCount,
  );
}

function buildLayout(
  blocks: LightBlock[],
  parentWidth: number,
  heightsMap: Map<number, number>,
): MasonryLayout {
  const columnWidth = deriveColumnWidth(parentWidth);

  const heights = blocks.map((block) => {
    const measured = heightsMap.get(block.id);
    if (measured !== undefined) return measured;
    // Fallback: computeCardHeight without word widths gives the conservative
    // lower bound. Used only if a measurement somehow fails. In practice the
    // measurement pass always populates every block before layout runs.
    return computeCardHeight(block, columnWidth, null);
  });

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

  // Measured pixel heights for blocks at the current columnWidth bucket.
  // Populated by the DOM measurement pass (see MeasurementPass component
  // below). Until `heightsReady` flips to true, the grid renders a loader
  // and a hidden measurement container alongside.
  const [heightsMap, setHeightsMap] = useState<Map<number, number>>(() => new Map());
  const [heightsReady, setHeightsReady] = useState(false);
  const [warmedUp, setWarmedUp] = useState(false);

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

  // Warm the in-memory height cache from IndexedDB on first mount.
  // After this resolves we can trust the memoryCache in subsequent renders.
  useEffect(() => {
    let cancelled = false;
    void ensureWarmed().then(() => {
      if (!cancelled) setWarmedUp(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Current column width bucket. Changes when parentWidth crosses a 40px
  // boundary — at that point we may need to measure blocks again at the
  // new column width, since text wraps differently.
  const bucket = useMemo(() => bucketize(deriveColumnWidth(parentWidth)), [parentWidth]);

  // Check which blocks already have cached heights at the current bucket.
  // Split into (cached, missing). If nothing is missing, heightsReady flips
  // true immediately and the grid renders without any measurement pass.
  const { cachedMap, missingBlocks } = useMemo(() => {
    if (!warmedUp || blocks.length === 0 || parentWidth <= 0) {
      return { cachedMap: new Map<number, number>(), missingBlocks: [] as LightBlock[] };
    }
    const ids = blocks.map((b) => b.id);
    const { cached, missing } = partitionByCache(ids, bucket);
    const missingSet = new Set(missing);
    const missingList = blocks.filter((b) => missingSet.has(b.id));
    return { cachedMap: cached, missingBlocks: missingList };
  }, [blocks, bucket, warmedUp, parentWidth]);

  // Reset heights state when blocks or bucket change. If everything is
  // already cached we can flip heightsReady synchronously; otherwise we
  // trigger the measurement pass and wait.
  useEffect(() => {
    if (!warmedUp) {
      setHeightsReady(false);
      return;
    }
    if (blocks.length === 0) {
      setHeightsMap(new Map());
      setHeightsReady(true);
      return;
    }
    if (missingBlocks.length === 0) {
      // All cached — instant.
      setHeightsMap(new Map(cachedMap));
      setHeightsReady(true);
    } else {
      // Need a measurement pass. MeasurementPass component will render,
      // useLayoutEffect will fire, and it calls back through onMeasured
      // below to populate state.
      setHeightsMap(new Map(cachedMap));
      setHeightsReady(false);
    }
  }, [blocks, bucket, cachedMap, missingBlocks.length, warmedUp]);

  const handleMeasured = useCallback(
    (results: Array<{ id: number; height: number }>) => {
      const newEntries: Array<{ blockId: number; bucket: number; height: number }> = [];
      for (const r of results) {
        setCachedHeight(r.id, bucket, r.height);
        newEntries.push({ blockId: r.id, bucket, height: r.height });
      }
      persistHeights(newEntries);
      setHeightsMap((prev) => {
        const next = new Map(prev);
        for (const r of results) next.set(r.id, r.height);
        return next;
      });
      setHeightsReady(true);
    },
    [bucket],
  );

  // Compute (or retrieve from cache) the masonry layout for the current
  // blocks + parentWidth combination. Only consults layoutCache when
  // heights are ready — otherwise we would cache an incomplete layout.
  const layout = useMemo((): MasonryLayout => {
    if (parentWidth <= 0 || blocks.length === 0 || !heightsReady) {
      return {
        columnCount: 1,
        columnWidth: 0,
        totalHeight: 0,
        positions: [],
      };
    }

    const cached = layoutCache.get(blocks, parentWidth);
    if (cached) return cached;

    const fresh = buildLayout(blocks, parentWidth, heightsMap);
    layoutCache.set(blocks, parentWidth, fresh);
    return fresh;
  }, [blocks, parentWidth, heightsMap, heightsReady]);

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
          {parentWidth > 0 && blocks.length > 0 && heightsReady && (
            <VirtualMasonryLayout
              key={currentTag ?? "__all__"}
              blocks={blocks}
              visibleItems={visibleItems}
              totalHeight={layout.totalHeight}
              priorityBounds={priorityBounds}
              context={gridContext}
            />
          )}
          {parentWidth > 0 && blocks.length > 0 && !heightsReady && (
            <>
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Computing layout…</p>
              </div>
              {missingBlocks.length > 0 && (
                <MeasurementPass
                  blocks={missingBlocks}
                  columnWidth={deriveColumnWidth(parentWidth)}
                  vaultPath={vaultPath}
                  onMeasured={handleMeasured}
                />
              )}
            </>
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
      className="will-change-transform overflow-hidden"
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

// ─── DOM measurement pass ──────────────────────────────────────────────────
//
// Renders MeasureCards into a hidden off-screen container, reads each
// card's actual pixel height via getBoundingClientRect, and reports the
// results through `onMeasured`. The container is positioned off-screen
// (left: -99999px) so the browser still computes layout but the cards
// are never visible to the user.
//
// This runs during the "Computing layout…" phase, before the visible grid
// renders. After measurement completes, the parent stores heights in
// memoryCache + IndexedDB and flips heightsReady=true, triggering the
// normal visible render with pixel-perfect positions.
//
// useLayoutEffect fires after React commit but before browser paint, so
// by the time the parent re-renders with the new heights, nothing has
// flickered on screen.

interface MeasurementPassProps {
  blocks: LightBlock[];
  columnWidth: number;
  vaultPath: string;
  onMeasured: (results: Array<{ id: number; height: number }>) => void;
}

function MeasurementPass({
  blocks,
  columnWidth,
  vaultPath,
  onMeasured,
}: MeasurementPassProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const run = async () => {
      // 1. Wait for fonts to be ready — text widths depend on the actual
      //    Geist font being loaded, not the fallback system font.
      if (typeof document !== "undefined" && document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {
          // fonts API failed — proceed anyway
        }
      }
      if (cancelled) return;

      // 2. Wait for all <img> elements inside the hidden container to
      //    finish loading (success or failure). Every card template uses
      //    explicit aspect-ratio wrappers so layout is deterministic even
      //    without this, but waiting eliminates the last 1% of timing
      //    races. A per-image 2-second timeout protects against images
      //    that never fire any event (network dead, broken asset://).
      const IMAGE_TIMEOUT_MS = 2000;
      const imgs = Array.from(container.querySelectorAll("img"));
      await Promise.all(
        imgs.map((img) => {
          // img.complete is true once loading has finished — whether
          // successfully (naturalWidth > 0) or with error. Either way
          // the layout size won't change any further, so we can skip
          // the wait.
          if (img.complete) return Promise.resolve();
          return new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              img.removeEventListener("load", finish);
              img.removeEventListener("error", finish);
              resolve();
            };
            img.addEventListener("load", finish, { once: true });
            img.addEventListener("error", finish, { once: true });
            setTimeout(finish, IMAGE_TIMEOUT_MS);
          });
        }),
      );
      if (cancelled) return;

      // 3. Force a synchronous layout read. By now fonts are loaded and
      //    images have finalized their intrinsic dimensions — the heights
      //    we read here match what the real visible Cards will render.
      const results: Array<{ id: number; height: number }> = [];
      const children = container.children;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i] as HTMLElement | undefined;
        if (!child) continue;
        const idAttr = child.getAttribute("data-measure-id");
        if (idAttr === null) continue;
        const id = Number(idAttr);
        if (!Number.isFinite(id)) continue;
        const rect = child.getBoundingClientRect();
        results.push({ id, height: rect.height });
      }
      if (!cancelled) onMeasured(results);
    };

    void run();
    return () => {
      cancelled = true;
    };
    // Deps intentionally covers the full measurement input: a new block
    // list or new columnWidth means we need to re-measure.
  }, [blocks, columnWidth, onMeasured]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: "-99999px",
        top: 0,
        width: Math.max(1, Math.round(columnWidth)),
        visibility: "hidden",
        pointerEvents: "none",
      }}
    >
      {blocks.map((block) => (
        <div
          key={block.id}
          data-measure-id={block.id}
          style={{ width: Math.max(1, Math.round(columnWidth)) }}
        >
          <MeasureCard block={block} vaultPath={vaultPath} />
        </div>
      ))}
    </div>
  );
}
