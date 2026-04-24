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
import { Card, CardSkeleton } from "./Card";
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
import { computeFeedPlaybackSurfaceEnvelope } from "@/lib/cardHeight";
import { LayoutCache } from "@/lib/layoutCache";
import { fetchWordWidths } from "@/lib/fontMetrics";
import {
  bucketize,
  getCachedHeight,
  setCachedHeight,
  persistHeights,
  warmFromIndexedDb,
} from "@/lib/heightCache";
import { useGridScroll } from "@/hooks/useGridScroll";
import type { WordWidths } from "@/types/fontMetrics";
import {
  buildLayoutGenerationKey,
  type LayoutGenerationKey,
} from "@/lib/layoutGeneration";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";

// ─── Layout constants ───────────────────────────────────────────────────────

const COLUMN_MIN_WIDTH = 240;
const GAP = 32;
const OVERSCAN_BACKWARD_PX = 600;
const OVERSCAN_FORWARD_PX = 2200;
const PRIORITY_BACKWARD_PX = 200;
const PRIORITY_FORWARD_PX = 1400;
const MEASUREMENT_BATCH_SIZE = 48;
const INITIAL_COMMIT_BLOCKS = 24;
const COMMIT_LOOKAHEAD_BLOCKS = 24;
const FEED_AUTOPLAY_MIN_VISIBLE_FRACTION = 0.5;
const FEED_AUTOPLAY_VIEWPORT_MARGIN_RATIO = 0.5;

// ─── Types ─────────────────────────────────────────────────────────────────

interface GridProps {
  blocks: LightBlock[];
  vaultPath: string;
  thumbsRootPath?: string;
  tags: TagCount[];
  currentTag?: string;
  scrollToTop: number;
  sidebarCollapsed?: boolean;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock) => void;
  onDeleteBlock: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
  hasMoreBlocks?: boolean;
  loadingMoreBlocks?: boolean;
  onLoadMoreBlocks?: () => void;
}

interface GridContext {
  vaultPath: string;
  thumbsRootPath?: string;
  focusedBlockId?: number | null;
  onBlockClick: (block: LightBlock) => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
}

type GridPhase = "provisional" | "measuring" | "committed";

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
  wordWidthsMap: Map<number, WordWidths>,
): MasonryLayout {
  const columnWidth = deriveColumnWidth(parentWidth);

  const heights = blocks.map((block) => {
    const measured = heightsMap.get(block.id);
    if (measured !== undefined) return measured;
    return computeCardHeight(block, columnWidth, wordWidthsMap.get(block.id) ?? null);
  });

  return computeMasonryLayout(heights, parentWidth, COLUMN_MIN_WIDTH, GAP);
}

// ─── Grid component ────────────────────────────────────────────────────────

export function Grid({
  blocks,
  vaultPath,
  thumbsRootPath,
  tags,
  currentTag,
  scrollToTop,
  sidebarCollapsed = false,
  focusedBlockId,
  onBlockClick,
  onToggleTag,
  onCreateAndAssign,
  onRequestRename,
  onDeleteBlock,
  onColumnCountChange,
  hasMoreBlocks = false,
  loadingMoreBlocks = false,
  onLoadMoreBlocks,
}: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);

  // Grid has exactly three pieces of genuine state:
  //
  //   1. warmedUp — flips true after the IndexedDB warm completes. Gates
  //      all reads from memoryCache, since memoryCache is empty before
  //      warm finishes.
  //
  //   2. measurementTick — bumped by handleMeasured every time new
  //      measurements land in memoryCache. memoryCache is a mutable
  //      singleton outside React's view; the tick is how we signal the
  //      derived `heightsMap` useMemo to recompute.
  //
  //   3. parentWidth / viewportHeight — set by ResizeObserver below.
  //
  // heightsMap, committedEndIndex, phase, and measurementBatch are all
  // derived synchronously from the current generation key. No stale
  // cross-generation layout state is kept in React state.
  const [warmedUp, setWarmedUp] = useState(false);
  const [measurementTick, setMeasurementTick] = useState(0);
  const [wordWidthsMap, setWordWidthsMap] = useState<Map<number, WordWidths>>(new Map());

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
    setScrollTop(el.scrollTop);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const updateScrollTop = () => {
      rafId = null;
      setScrollTop((current) => {
        const next = el.scrollTop;
        return current === next ? current : next;
      });
    };

    const handleScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateScrollTop);
    };

    setScrollTop(el.scrollTop);
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
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

  useEffect(() => {
    let cancelled = false;
    setWordWidthsMap(new Map());
    void fetchWordWidths(blocks).then((map) => {
      if (!cancelled) {
        setWordWidthsMap(map);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [blocks]);

  // Current column width bucket. Changes when parentWidth crosses a 40px
  // boundary — at that point we may need to measure blocks again at the
  // new column width, since text wraps differently.
  const bucket = useMemo(() => bucketize(deriveColumnWidth(parentWidth)), [parentWidth]);
  const generationKey = useMemo<LayoutGenerationKey>(
    () => buildLayoutGenerationKey({
      blocks,
      routeKey: currentTag ?? "__all__",
      heightBucket: bucket,
      parentWidth,
    }),
    [blocks, bucket, currentTag, parentWidth],
  );

  // Measured pixel heights for the current generation. Purely derived
  // from the module-level memoryCache — no setState, no reconciliation
  // effect, no stale-state window.
  //
  // `measurementTick` appears in the dep list and is `void`'d in the body
  // purely as a re-run trigger: memoryCache is a mutable singleton that
  // React cannot observe on its own, so after handleMeasured writes new
  // entries we bump the tick to force this useMemo to recompute.
  const heightsMap = useMemo(() => {
    void measurementTick;
    const map = new Map<number, number>();
    if (!warmedUp) return map;
    for (const b of blocks) {
      const h = getCachedHeight(generationKey, b.id);
      if (h !== undefined) map.set(b.id, h);
    }
    return map;
  }, [blocks, generationKey, warmedUp, measurementTick]);

  const committedEndIndex = useMemo(() => {
    if (!warmedUp) return -1;
    for (let index = 0; index < blocks.length; index += 1) {
      if (!heightsMap.has(blocks[index]!.id)) {
        return index - 1;
      }
    }
    return blocks.length - 1;
  }, [blocks, heightsMap, warmedUp]);

  const allCurrentGenerationExact =
    warmedUp &&
    blocks.length > 0 &&
    committedEndIndex === blocks.length - 1;

  const handleMeasured = useCallback(
    (results: Array<{ id: number; height: number }>) => {
      const newEntries: Array<{ generationKey: LayoutGenerationKey; blockId: number; height: number }> = [];
      for (const r of results) {
        setCachedHeight(generationKey, r.id, r.height);
        newEntries.push({ generationKey, blockId: r.id, height: r.height });
      }
      persistHeights(newEntries);
      // Force the derived heightsMap useMemo to recompute by observing
      // the new entries just written into memoryCache.
      setMeasurementTick((t) => t + 1);
    },
    [generationKey],
  );

  // The visible layout always belongs to the current generation. Exact
  // heights are used where they exist for the current generation; remaining
  // items stay provisional and render as skeletons until their contiguous
  // prefix has been committed.
  const layout = useMemo((): MasonryLayout => {
    if (parentWidth <= 0 || blocks.length === 0) {
      return {
        columnCount: 1,
        columnWidth: 0,
        totalHeight: 0,
        positions: [],
      };
    }

    if (!allCurrentGenerationExact) {
      return buildLayout(blocks, parentWidth, heightsMap, wordWidthsMap);
    }

    const cached = layoutCache.get(generationKey);
    if (cached) return cached;

    const fresh = buildLayout(blocks, parentWidth, heightsMap, wordWidthsMap);
    layoutCache.set(generationKey, fresh);
    return fresh;
  }, [allCurrentGenerationExact, blocks, generationKey, heightsMap, parentWidth, wordWidthsMap]);

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

  const visibleItems = useGridScroll(parentRef, {
    getVisibleItems,
    resetKey: generationKey,
  });

  const maxVisibleIndex = useMemo(
    () => visibleItems.reduce((max, item) => Math.max(max, item.index), -1),
    [visibleItems],
  );

  const targetCommittedEndIndex = useMemo(() => {
    if (blocks.length === 0) return -1;
    const baseEnd = maxVisibleIndex >= 0
      ? maxVisibleIndex + COMMIT_LOOKAHEAD_BLOCKS
      : INITIAL_COMMIT_BLOCKS - 1;
    return Math.min(blocks.length - 1, baseEnd);
  }, [blocks.length, maxVisibleIndex]);

  const phase: GridPhase = useMemo(() => {
    if (blocks.length === 0 || parentWidth <= 0) return "committed";
    if (committedEndIndex < 0) return "provisional";
    if (committedEndIndex < targetCommittedEndIndex) return "measuring";
    return "committed";
  }, [blocks.length, committedEndIndex, parentWidth, targetCommittedEndIndex]);

  const autoplayEligibleBySlug = useMemo(() => {
    const eligible = new Map<string, ReturnType<typeof normalizeFeedPlayback>>();
    for (const block of blocks) {
      const playback = normalizeFeedPlayback(block.feed_playback);
      if (playback) {
        eligible.set(block.slug, playback);
      }
    }
    return eligible;
  }, [blocks]);

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

  const measurementBatch = useMemo(() => {
    if (!warmedUp) return [];
    if (targetCommittedEndIndex < 0) return [];

    const missingPrefixBlocks: LightBlock[] = [];
    for (let index = 0; index <= targetCommittedEndIndex; index += 1) {
      const block = blocks[index];
      if (!block || heightsMap.has(block.id)) continue;
      missingPrefixBlocks.push(block);
      if (missingPrefixBlocks.length >= MEASUREMENT_BATCH_SIZE) break;
    }

    return missingPrefixBlocks;
  }, [blocks, heightsMap, targetCommittedEndIndex, warmedUp]);

  const activePlaybackSlugs = useMemo(() => {
    if (phase === "provisional" || viewportHeight <= 0) {
      return new Set<string>();
    }

    const autoplayViewportMarginPx = Math.round(
      viewportHeight * FEED_AUTOPLAY_VIEWPORT_MARGIN_RATIO,
    );
    const autoplayWindowTop = scrollTop - autoplayViewportMarginPx;
    const autoplayWindowBottom =
      scrollTop + viewportHeight + autoplayViewportMarginPx;
    const viewportBottom = scrollTop + viewportHeight;
    const viewportCenter = scrollTop + viewportHeight / 2;
    const active = new Set<string>();
    let activeHeavy:
      | {
          slug: string;
          inViewport: boolean;
          viewportVisibleFraction: number;
          windowVisibleFraction: number;
          centerDistance: number;
          top: number;
        }
      | null = null;

    for (const item of visibleItems) {
      if (item.index > committedEndIndex) continue;
      const block = blocks[item.index];
      if (!block) continue;
      const playback = autoplayEligibleBySlug.get(block.slug);
      if (!playback) continue;

      const playbackSurface = computeFeedPlaybackSurfaceEnvelope(
        block,
        item.width,
      );
      if (!playbackSurface) continue;

      const surfaceTop = item.top + playbackSurface.topOffsetPx;
      const surfaceBottom = surfaceTop + playbackSurface.heightPx;
      const windowVisiblePx =
        Math.min(surfaceBottom, autoplayWindowBottom) -
        Math.max(surfaceTop, autoplayWindowTop);
      if (windowVisiblePx <= 0) continue;

      const viewportVisiblePx =
        Math.min(surfaceBottom, viewportBottom) -
        Math.max(surfaceTop, scrollTop);
      const safeSurfaceHeight = Math.max(playbackSurface.heightPx, 1);
      const windowVisibleFraction = windowVisiblePx / safeSurfaceHeight;
      if (windowVisibleFraction < FEED_AUTOPLAY_MIN_VISIBLE_FRACTION) continue;

      if (playback.profile === "standard") {
        active.add(block.slug);
        continue;
      }

      const inViewport = viewportVisiblePx > 0;
      const viewportVisibleFraction = Math.max(viewportVisiblePx, 0) / safeSurfaceHeight;
      const centerDistance = Math.abs(
        surfaceTop + playbackSurface.heightPx / 2 - viewportCenter,
      );

      if (
        !activeHeavy ||
        (inViewport && !activeHeavy.inViewport) ||
        (inViewport === activeHeavy.inViewport &&
          viewportVisibleFraction > activeHeavy.viewportVisibleFraction + 0.001) ||
        (inViewport === activeHeavy.inViewport &&
          Math.abs(viewportVisibleFraction - activeHeavy.viewportVisibleFraction) <= 0.001 &&
          windowVisibleFraction > activeHeavy.windowVisibleFraction + 0.001) ||
        (inViewport === activeHeavy.inViewport &&
          Math.abs(viewportVisibleFraction - activeHeavy.viewportVisibleFraction) <= 0.001 &&
          Math.abs(windowVisibleFraction - activeHeavy.windowVisibleFraction) <= 0.001 &&
          surfaceTop < activeHeavy.top - 0.5) ||
        (inViewport === activeHeavy.inViewport &&
          Math.abs(viewportVisibleFraction - activeHeavy.viewportVisibleFraction) <= 0.001 &&
          Math.abs(windowVisibleFraction - activeHeavy.windowVisibleFraction) <= 0.001 &&
          Math.abs(surfaceTop - activeHeavy.top) <= 0.5 &&
          centerDistance < activeHeavy.centerDistance - 0.5)
      ) {
        activeHeavy = {
          slug: block.slug,
          inViewport,
          viewportVisibleFraction,
          windowVisibleFraction,
          centerDistance,
          top: surfaceTop,
        };
      }
    }

    if (activeHeavy) {
      active.add(activeHeavy.slug);
    }

    return active;
  }, [
    autoplayEligibleBySlug,
    blocks,
    committedEndIndex,
    phase,
    scrollTop,
    viewportHeight,
    visibleItems,
  ]);

  useEffect(() => {
    if (!hasMoreBlocks || loadingMoreBlocks || !onLoadMoreBlocks) {
      return;
    }
    if (maxVisibleIndex >= blocks.length - 24) {
      onLoadMoreBlocks();
    }
  }, [blocks.length, hasMoreBlocks, loadingMoreBlocks, maxVisibleIndex, onLoadMoreBlocks]);

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
      thumbsRootPath,
      focusedBlockId,
      onBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      onRequestRename,
      onRequestDelete: handleRequestDelete,
    }),
    [
      vaultPath,
      thumbsRootPath,
      focusedBlockId,
      onBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      onRequestRename,
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
            scrollbarGutter: "stable",
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
        >
          {parentWidth > 0 && blocks.length > 0 && (
            <VirtualMasonryLayout
              key={generationKey}
              blocks={blocks}
              visibleItems={visibleItems}
              totalHeight={layout.totalHeight}
              priorityBounds={priorityBounds}
              committedEndIndex={committedEndIndex}
              activePlaybackSlugs={activePlaybackSlugs}
              context={gridContext}
            />
          )}
          {parentWidth > 0 && blocks.length > 0 && phase !== "committed" && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center">
                <p className="rounded-1 border border-border bg-background/90 px-3 py-1 text-sm text-muted-foreground backdrop-blur">
                  Refining layout…
                </p>
              </div>
              {measurementBatch.length > 0 && (
                <MeasurementPass
                  blocks={measurementBatch}
                  columnWidth={deriveColumnWidth(parentWidth)}
                  vaultPath={vaultPath}
                  thumbsRootPath={thumbsRootPath}
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
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestRename={onRequestRename}
          onRequestDelete={(slug) => setBlockToDelete(slug)}
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
  committedEndIndex,
  activePlaybackSlugs,
  context,
}: {
  blocks: LightBlock[];
  visibleItems: MasonryPosition[];
  totalHeight: number;
  priorityBounds: { start: number; end: number };
  committedEndIndex: number;
  activePlaybackSlugs: Set<string>;
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
            isCommitted={item.index <= committedEndIndex}
            allowPlayback={activePlaybackSlugs.has(block.slug)}
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
  isCommitted,
  allowPlayback,
  context,
}: {
  block: LightBlock;
  item: MasonryPosition;
  priority: boolean;
  isCommitted: boolean;
  allowPlayback: boolean;
  context: GridContext;
}) {
  return (
    <div
      className="will-change-transform"
      style={{
        position: "absolute",
        width: item.width,
        // Enforce the measured layout envelope in the visible render path.
        // Without an explicit wrapper height, even a small post-measurement
        // drift (font wrapping, media readiness, browser rounding) lets the
        // card's natural height spill into the next masonry slot and appear
        // as vertical overlap. Heights are already ceil()'d during hidden
        // measurement, so clamping the wrapper here is the safer invariant.
        height: item.height,
        overflow: "hidden",
        transform: `translate3d(${item.left}px, ${item.top}px, 0)`,
      }}
    >
      {isCommitted ? (
        <Card
          block={block}
          vaultPath={context.vaultPath}
          thumbsRootPath={context.thumbsRootPath}
          isFocused={block.id === context.focusedBlockId}
          priority={priority}
          allowPlayback={allowPlayback}
          onClick={context.onBlockClick}
          tags={context.tags}
          currentTag={context.currentTag}
          onToggleTag={context.onToggleTag}
          onCreateAndAssign={context.onCreateAndAssign}
          onRequestRename={context.onRequestRename}
          onRequestDelete={context.onRequestDelete}
        />
      ) : (
        <CardSkeleton block={block} />
      )}
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
  thumbsRootPath?: string;
  onMeasured: (results: Array<{ id: number; height: number }>) => void;
}

function MeasurementPass({
  blocks,
  columnWidth,
  vaultPath,
  thumbsRootPath,
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
        // Ceil to the nearest integer pixel so the visible wrapper never
        // has a fractional height that the browser rounds down, which would
        // otherwise clip the last row of pixels of the rendered card.
        const rect = child.getBoundingClientRect();
        results.push({ id, height: Math.ceil(rect.height) });
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
        // Use the exact fractional columnWidth — same value the layout
        // engine uses for item.width in the visible grid. Rounding here
        // would create a width mismatch between measurement and render,
        // causing text to wrap slightly differently and heights to drift.
        width: Math.max(1, columnWidth),
        visibility: "hidden",
        pointerEvents: "none",
      }}
    >
      {blocks.map((block) => (
        <div
          key={block.id}
          data-measure-id={block.id}
          style={{ width: Math.max(1, columnWidth) }}
        >
          <MeasureCard
            block={block}
            vaultPath={vaultPath}
            thumbsRootPath={thumbsRootPath}
          />
        </div>
      ))}
    </div>
  );
}
