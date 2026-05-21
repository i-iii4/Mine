import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { LightBlock, TagCount } from "@/types";
import { Card, CardSkeleton } from "./Card";
import { MeasureCard } from "./MeasureCard";
import { CardTagMenu } from "./CardContextMenu";
import { GroupSelectionActionBar } from "./GroupSelectionActionBar";
import { GroupSelectionCardMenu } from "./GroupSelectionCardMenu";
import {
  computeMasonryLayout,
  createVisibilityIndex,
  getMasonryColumnWidth,
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
import {
  isEditableKeyboardTarget,
  isOverlayKeyboardTarget,
} from "@/lib/keyboardTargets";

// ─── Layout constants ───────────────────────────────────────────────────────

const COLUMN_MIN_WIDTH = 220;
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
const GRID_TOP_INSET_PX = 64;
const GRID_BOTTOM_INSET_PX = 32;
const MARQUEE_DRAG_THRESHOLD_PX = 4;
const SCROLL_ANCHOR_REFERENCE_OFFSET_PX = 32;

type GridArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";
type FeedInteractionMode = "keyboard" | "pointer";
type FeedPointerPosition = {
  x: number;
  y: number;
  pointerId: number;
};
type LayoutPoint = {
  x: number;
  y: number;
};
type LayoutRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type MarqueeSelection = {
  pointerId: number;
  start: LayoutPoint;
  current: LayoutPoint;
  active: boolean;
};
type ScrollAnchor = {
  slug: string;
  offsetTop: number;
};
type ScrollAnchorSnapshot = {
  routeKey: string;
  parentWidth: number;
  blocks: readonly LightBlock[];
  positions: readonly MasonryPosition[];
};
type PendingScrollAnchor = {
  routeKey: string;
  anchor: ScrollAnchor;
};

function isGridArrowKey(key: string): key is GridArrowKey {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

function feedPointerPosition(event: ReactPointerEvent): FeedPointerPosition {
  return {
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
  };
}

function isSameFeedPointerPosition(
  first: FeedPointerPosition | null,
  second: FeedPointerPosition,
): boolean {
  return (
    first !== null &&
    first.pointerId === second.pointerId &&
    first.x === second.x &&
    first.y === second.y
  );
}

function isStationaryFeedPointerMove(event: ReactPointerEvent): boolean {
  return event.movementX === 0 && event.movementY === 0;
}

function positionCenter(position: MasonryPosition): { x: number; y: number } {
  return {
    x: position.left + position.width / 2,
    y: position.top + position.height / 2,
  };
}

function findPositionForSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  slug: string,
): MasonryPosition | null {
  const blockIndex = blocks.findIndex((block) => block.slug === slug);
  if (blockIndex < 0) return null;
  return positions.find((position) => position.index === blockIndex) ?? null;
}

function findLayoutNeighborSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  currentSlug: string,
  direction: GridArrowKey,
  committedEndIndex: number,
): string | null {
  const current = findPositionForSlug(positions, blocks, currentSlug);
  if (!current) return null;

  const currentCenter = positionCenter(current);
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  let bestSlug: string | null = null;
  let bestScore = Infinity;

  for (const candidate of positions) {
    if (candidate.index === current.index || candidate.index > committedEndIndex) continue;
    const block = blocks[candidate.index];
    if (!block) continue;

    const candidateCenter = positionCenter(candidate);
    const dx = candidateCenter.x - currentCenter.x;
    const dy = candidateCenter.y - currentCenter.y;
    const valid =
      direction === "ArrowRight" ? dx > 10 :
      direction === "ArrowLeft" ? dx < -10 :
      direction === "ArrowDown" ? dy > 10 :
      dy < -10;
    if (!valid) continue;

    const score = horizontal
      ? Math.abs(dx) + Math.abs(dy) * 3
      : Math.abs(dy) + Math.abs(dx) * 3;

    if (score < bestScore) {
      bestScore = score;
      bestSlug = block.slug;
    }
  }

  return bestSlug;
}

function firstVisibleSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  scrollTop: number,
  viewportHeight: number,
  committedEndIndex: number,
): string | null {
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  let best: MasonryPosition | null = null;

  for (const item of positions) {
    if (item.index > committedEndIndex) continue;
    const itemTop = GRID_TOP_INSET_PX + item.top;
    const itemBottom = GRID_TOP_INSET_PX + item.bottom;
    if (itemBottom < viewportTop || itemTop > viewportBottom) continue;
    if (
      !best ||
      item.top < best.top - 0.5 ||
      (Math.abs(item.top - best.top) <= 0.5 && item.left < best.left)
    ) {
      best = item;
    }
  }

  return best ? blocks[best.index]?.slug ?? null : null;
}

function hasRemovedBlocks(
  previousBlocks: readonly LightBlock[],
  currentSlugs: ReadonlySet<string>,
): boolean {
  return previousBlocks.some((block) => !currentSlugs.has(block.slug));
}

function findViewportPreservationAnchor(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  currentSlugs: ReadonlySet<string>,
  scrollTop: number,
  viewportHeight: number,
): ScrollAnchor | null {
  if (viewportHeight <= 0) return null;

  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  const referenceY = viewportTop + Math.min(
    SCROLL_ANCHOR_REFERENCE_OFFSET_PX,
    viewportHeight / 2,
  );
  let best: (ScrollAnchor & { score: number; itemTop: number; itemLeft: number }) | null = null;

  for (const position of positions) {
    const block = blocks[position.index];
    if (!block || !currentSlugs.has(block.slug)) continue;

    const itemTop = GRID_TOP_INSET_PX + position.top;
    const itemBottom = GRID_TOP_INSET_PX + position.bottom;
    const visible = itemBottom >= viewportTop && itemTop <= viewportBottom;
    const distanceFromReference =
      referenceY < itemTop
        ? itemTop - referenceY
        : referenceY > itemBottom
          ? referenceY - itemBottom
          : 0;
    const score = (visible ? 0 : 1_000_000) + distanceFromReference;

    if (
      !best ||
      score < best.score - 0.5 ||
      (Math.abs(score - best.score) <= 0.5 && itemTop < best.itemTop - 0.5) ||
      (
        Math.abs(score - best.score) <= 0.5 &&
        Math.abs(itemTop - best.itemTop) <= 0.5 &&
        position.left < best.itemLeft
      )
    ) {
      best = {
        slug: block.slug,
        offsetTop: itemTop - viewportTop,
        score,
        itemTop,
        itemLeft: position.left,
      };
    }
  }

  return best ? { slug: best.slug, offsetTop: best.offsetTop } : null;
}

function clampedScrollTopForAnchor(
  layout: MasonryLayout,
  viewportHeight: number,
  position: MasonryPosition,
  anchor: ScrollAnchor,
): number {
  const unclamped = GRID_TOP_INSET_PX + position.top - anchor.offsetTop;
  const maxScrollTop = Math.max(
    0,
    GRID_TOP_INSET_PX + layout.totalHeight + GRID_BOTTOM_INSET_PX - viewportHeight,
  );
  return Math.min(Math.max(0, unclamped), maxScrollTop);
}

function isPositionVisibleInViewport(
  position: MasonryPosition,
  scrollTop: number,
  viewportHeight: number,
): boolean {
  if (viewportHeight <= 0) return false;
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  const itemTop = GRID_TOP_INSET_PX + position.top;
  const itemBottom = GRID_TOP_INSET_PX + position.bottom;
  return itemBottom >= viewportTop && itemTop <= viewportBottom;
}

function scrollPositionIntoView(
  scrollElement: HTMLElement,
  position: MasonryPosition,
): void {
  const padding = 32;
  const itemTop = GRID_TOP_INSET_PX + position.top;
  const itemBottom = GRID_TOP_INSET_PX + position.bottom;
  const viewportTop = scrollElement.scrollTop;
  const viewportBottom = viewportTop + scrollElement.clientHeight;
  let nextTop: number | null = null;

  if (itemTop < viewportTop + padding) {
    nextTop = Math.max(0, itemTop - padding);
  } else if (itemBottom > viewportBottom - padding) {
    nextTop = Math.max(0, itemBottom - scrollElement.clientHeight + padding);
  }

  if (nextTop !== null) {
    scrollElement.scrollTo({ top: nextTop, behavior: "smooth" });
  }
}

function rectFromPoints(first: LayoutPoint, second: LayoutPoint): LayoutRect {
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);
  return {
    left,
    top,
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y),
  };
}

function rectsIntersect(first: LayoutRect, second: LayoutRect): boolean {
  return (
    first.left <= second.left + second.width &&
    first.left + first.width >= second.left &&
    first.top <= second.top + second.height &&
    first.top + first.height >= second.top
  );
}

function marqueeIsActive(start: LayoutPoint, current: LayoutPoint): boolean {
  return (
    Math.abs(current.x - start.x) >= MARQUEE_DRAG_THRESHOLD_PX ||
    Math.abs(current.y - start.y) >= MARQUEE_DRAG_THRESHOLD_PX
  );
}

function findMarqueeSelectionSlugs(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  rect: LayoutRect,
  committedEndIndex: number,
): string[] {
  const selected: string[] = [];

  for (const candidate of positions) {
    if (candidate.index > committedEndIndex) continue;
    const block = blocks[candidate.index];
    if (!block) continue;
    if (rectsIntersect(rect, {
      left: candidate.left,
      top: candidate.top,
      width: candidate.width,
      height: candidate.height,
    })) {
      selected.push(block.slug);
    }
  }

  return selected;
}

function layoutPointFromPointerEvent(
  scrollElement: HTMLElement,
  event: ReactPointerEvent<HTMLElement>,
): LayoutPoint | null {
  const layoutElement = scrollElement.querySelector("[data-grid-layout]");
  if (!(layoutElement instanceof HTMLElement)) return null;
  const rect = layoutElement.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function isEmptyGridPointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    [
      "[data-block-slug]",
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='button']",
      "[data-radix-popper-content-wrapper]",
    ].join(","),
  );
}

function blockSlugFromKeyboardTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-block-slug]")?.getAttribute("data-block-slug") ?? null;
}

function isPassiveGridKeyboardTarget(
  target: EventTarget | null,
  scrollElement: HTMLElement | null,
): boolean {
  if (!(target instanceof HTMLElement)) return target === document.body;
  if (target === document.body || target === scrollElement) return true;
  if (!scrollElement?.contains(target)) return false;
  return !target.closest(
    [
      "[data-block-slug]",
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "[contenteditable='true']",
      "[role='button']",
      "[data-radix-popper-content-wrapper]",
    ].join(","),
  );
}

function isCommittedSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  slug: string,
  committedEndIndex: number,
): boolean {
  const position = findPositionForSlug(positions, blocks, slug);
  return Boolean(position && position.index <= committedEndIndex);
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface GridProps {
  blocks: LightBlock[];
  vaultPath: string;
  thumbsRootPath?: string;
  tags: TagCount[];
  currentTag?: string;
  scrollToTop: number;
  sidebarCollapsed?: boolean;
  blockDragActive?: boolean;
  detailOpen?: boolean;
  keyboardNavigationDisabled?: boolean;
  restoreFocusSlug?: string | null;
  restoreFocusSequence?: number;
  searchQuery?: string;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
  onGroupSelectionStart?: () => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
  hasMoreBlocks?: boolean;
  loadingMoreBlocks?: boolean;
  onLoadMoreBlocks?: () => void;
}

interface GridContext {
  vaultPath: string;
  thumbsRootPath?: string;
  focusedSlug: string | null;
  pinnedActionMenuSlug: string | null;
  selectedSlugs: ReadonlySet<string>;
  selectedBlocks: readonly LightBlock[];
  actionMenuRequest: { slug: string; sequence: number } | null;
  selectionBatchMenuRequest: { slug: string; sequence: number } | null;
  hoverEnabled: boolean;
  onGridItemPointerMove: (slug: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyboardActionMenuOpenChange: (slug: string, open: boolean) => void;
  onClearSelection: () => void;
  onModifiedCardClick: (block: LightBlock, event: ReactMouseEvent<HTMLDivElement>) => boolean;
  onBlockClick: (block: LightBlock) => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
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
  return getMasonryColumnWidth(parentWidth, COLUMN_MIN_WIDTH, GAP);
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

  return computeMasonryLayout(
    heights,
    parentWidth,
    COLUMN_MIN_WIDTH,
    GAP,
  );
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
  blockDragActive = false,
  detailOpen = false,
  keyboardNavigationDisabled = false,
  restoreFocusSlug = null,
  restoreFocusSequence = 0,
  searchQuery = "",
  onBlockClick,
  onToggleTag,
  onCreateAndAssign,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onDeleteSelectedBlocks,
  onGroupSelectionStart,
  onRequestRename,
  onRequestDelete,
  onColumnCountChange,
  hasMoreBlocks = false,
  loadingMoreBlocks = false,
  onLoadMoreBlocks,
}: GridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);
  const [focusedSlug, setFocusedSlug] = useState<string | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(() => new Set());
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection | null>(null);
  const [feedInteractionMode, setFeedInteractionMode] = useState<FeedInteractionMode>("pointer");
  const [actionMenuRequest, setActionMenuRequest] = useState<{
    slug: string;
    sequence: number;
  } | null>(null);
  const [selectionBatchMenuRequest, setSelectionBatchMenuRequest] = useState<{
    slug: string;
    sequence: number;
  } | null>(null);
  const [pinnedActionMenuSlug, setPinnedActionMenuSlug] = useState<string | null>(null);
  const lastRestoreFocusSequenceRef = useRef(0);
  const lastPointerPositionRef = useRef<FeedPointerPosition | null>(null);
  const blockedPointerPositionRef = useRef<FeedPointerPosition | null>(null);
  const latestScrollTopRef = useRef(0);
  const scrollAnchorSnapshotRef = useRef<ScrollAnchorSnapshot | null>(null);
  const pendingScrollAnchorRef = useRef<PendingScrollAnchor | null>(null);
  const suppressFocusedScrollOnceRef = useRef(false);

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
    latestScrollTopRef.current = el.scrollTop;
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
        latestScrollTopRef.current = next;
        return current === next ? current : next;
      });
    };

    const handleScroll = () => {
      latestScrollTopRef.current = el.scrollTop;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(updateScrollTop);
    };

    setScrollTop(el.scrollTop);
    latestScrollTopRef.current = el.scrollTop;
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

  useLayoutEffect(() => {
    const scrollElement = parentRef.current;
    const routeKey = currentTag ?? "__all__";
    const previous = scrollAnchorSnapshotRef.current;

    if (
      scrollElement &&
      previous &&
      previous.routeKey === routeKey &&
      Math.abs(previous.parentWidth - parentWidth) <= 0.5 &&
      viewportHeight > 0
    ) {
      const currentSlugs = new Set(blocks.map((block) => block.slug));
      if (hasRemovedBlocks(previous.blocks, currentSlugs)) {
        const anchor = findViewportPreservationAnchor(
          previous.positions,
          previous.blocks,
          currentSlugs,
          latestScrollTopRef.current,
          scrollElement.clientHeight || viewportHeight,
        );
        if (anchor) {
          pendingScrollAnchorRef.current = { routeKey, anchor };
        }
      }
    }

    const pending = pendingScrollAnchorRef.current;
    if (scrollElement && pending) {
      if (pending.routeKey !== routeKey) {
        pendingScrollAnchorRef.current = null;
      } else {
        const nextPosition = findPositionForSlug(layout.positions, blocks, pending.anchor.slug);
        if (!nextPosition) {
          pendingScrollAnchorRef.current = null;
        } else if (nextPosition.index <= committedEndIndex) {
          const nextScrollTop = clampedScrollTopForAnchor(
            layout,
            scrollElement.clientHeight || viewportHeight,
            nextPosition,
            pending.anchor,
          );
          pendingScrollAnchorRef.current = null;
          if (Math.abs(scrollElement.scrollTop - nextScrollTop) > 0.5) {
            scrollElement.scrollTop = nextScrollTop;
            latestScrollTopRef.current = nextScrollTop;
            setScrollTop(nextScrollTop);
            scrollElement.dispatchEvent(new Event("scroll"));
            suppressFocusedScrollOnceRef.current = true;
          }
        }
      }
    }

    scrollAnchorSnapshotRef.current = {
      routeKey,
      parentWidth,
      blocks,
      positions: layout.positions,
    };
  }, [blocks, committedEndIndex, currentTag, layout, parentWidth, viewportHeight]);

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

  useEffect(() => {
    setFocusedSlug(null);
    setFeedInteractionMode("pointer");
    setPinnedActionMenuSlug(null);
    setSelectedSlugs(new Set());
    setMarqueeSelection(null);
  }, [currentTag]);

  useEffect(() => {
    if (focusedSlug && !blocksBySlug.has(focusedSlug)) {
      setFocusedSlug(null);
    }
    if (pinnedActionMenuSlug && !blocksBySlug.has(pinnedActionMenuSlug)) {
      setPinnedActionMenuSlug(null);
    }
    setSelectedSlugs((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const slug of current) {
        if (blocksBySlug.has(slug)) {
          next.add(slug);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [blocksBySlug, focusedSlug, pinnedActionMenuSlug]);

  useEffect(() => {
    if (!restoreFocusSlug || restoreFocusSequence <= lastRestoreFocusSequenceRef.current) {
      return;
    }
    lastRestoreFocusSequenceRef.current = restoreFocusSequence;
    if (blocksBySlug.has(restoreFocusSlug)) {
      setFeedInteractionMode("keyboard");
      setFocusedSlug(restoreFocusSlug);
    }
  }, [blocksBySlug, restoreFocusSequence, restoreFocusSlug]);

  useEffect(() => {
    if (feedInteractionMode !== "keyboard") return;
    if (!focusedSlug) return;
    if (pendingScrollAnchorRef.current) return;
    if (suppressFocusedScrollOnceRef.current) {
      suppressFocusedScrollOnceRef.current = false;
      return;
    }
    const scrollElement = parentRef.current;
    if (!scrollElement) return;
    const position = findPositionForSlug(layout.positions, blocks, focusedSlug);
    if (!position) return;
    requestAnimationFrame(() => {
      scrollPositionIntoView(scrollElement, position);
    });
  }, [blocks, feedInteractionMode, focusedSlug, layout.positions]);

  const handleGridItemPointerMove = useCallback((
    slug: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const nextPointerPosition = feedPointerPosition(event);
    const blockedPointerPosition = blockedPointerPositionRef.current;
    lastPointerPositionRef.current = nextPointerPosition;

    if (isSameFeedPointerPosition(blockedPointerPosition, nextPointerPosition)) {
      return;
    }

    if (
      feedInteractionMode === "keyboard" &&
      !blockedPointerPosition &&
      isStationaryFeedPointerMove(event)
    ) {
      blockedPointerPositionRef.current = nextPointerPosition;
      return;
    }

    blockedPointerPositionRef.current = null;
    setFeedInteractionMode("pointer");
    setFocusedSlug(slug);
  }, [feedInteractionMode]);

  const handleKeyboardActionMenuOpenChange = useCallback((slug: string, open: boolean) => {
    setPinnedActionMenuSlug((current) => {
      if (open) return slug;
      return current === slug ? null : current;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedSlugs(new Set());
    setMarqueeSelection(null);
  }, []);

  useEffect(() => {
    if (searchQuery.trim()) {
      clearSelection();
    }
  }, [clearSelection, searchQuery]);

  useEffect(() => {
    if (selectedSlugs.size > 0) {
      onGroupSelectionStart?.();
    }
  }, [onGroupSelectionStart, selectedSlugs.size]);

  useEffect(() => {
    if (!detailOpen) return;
    clearSelection();
  }, [clearSelection, detailOpen]);

  const toggleSelectedSlug = useCallback((slug: string) => {
    setSelectedSlugs((current) => {
      const next = new Set(current);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }, []);

  const handleBlockClick = useCallback((block: LightBlock) => {
    clearSelection();
    onBlockClick(block);
  }, [clearSelection, onBlockClick]);

  const handleModifiedCardClick = useCallback((
    block: LightBlock,
    event: ReactMouseEvent<HTMLDivElement>,
  ): boolean => {
    if (event.metaKey || event.shiftKey || selectedSlugs.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      toggleSelectedSlug(block.slug);
      setFeedInteractionMode("pointer");
      setFocusedSlug(block.slug);
      return true;
    }

    return false;
  }, [selectedSlugs.size, toggleSelectedSlug]);

  const marqueeRect = useMemo(
    () => marqueeSelection?.active
      ? rectFromPoints(marqueeSelection.start, marqueeSelection.current)
      : null,
    [marqueeSelection],
  );

  const applyMarqueeSelection = useCallback((selection: MarqueeSelection) => {
    const rect = rectFromPoints(selection.start, selection.current);
    setSelectedSlugs(new Set(
      findMarqueeSelectionSlugs(
        layout.positions,
        blocks,
        rect,
        committedEndIndex,
      ),
    ));
  }, [blocks, committedEndIndex, layout.positions]);

  const handleGridPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      !isEmptyGridPointerTarget(event.target)
    ) {
      return;
    }

    const start = layoutPointFromPointerEvent(event.currentTarget, event);
    if (!start) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setMarqueeSelection({
      pointerId: event.pointerId,
      start,
      current: start,
      active: false,
    });
    setFeedInteractionMode("pointer");
    setFocusedSlug(null);
  }, []);

  const handleGridPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marqueeSelection || marqueeSelection.pointerId !== event.pointerId) return;
    const current = layoutPointFromPointerEvent(event.currentTarget, event);
    if (!current) return;

    event.preventDefault();
    const next = {
      ...marqueeSelection,
      current,
      active: marqueeSelection.active || marqueeIsActive(marqueeSelection.start, current),
    };
    setMarqueeSelection(next);
    if (next.active) {
      applyMarqueeSelection(next);
    }
  }, [applyMarqueeSelection, marqueeSelection]);

  const finishMarqueeSelection = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!marqueeSelection || marqueeSelection.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (marqueeSelection.active) {
      applyMarqueeSelection(marqueeSelection);
    } else {
      clearSelection();
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMarqueeSelection(null);
  }, [applyMarqueeSelection, clearSelection, marqueeSelection]);

  useEffect(() => {
    if (keyboardNavigationDisabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const commandK =
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === "k";
      const scrollElement = parentRef.current;
      const currentScrollTop = scrollElement?.scrollTop ?? scrollTop;
      const currentViewportHeight = scrollElement?.clientHeight || viewportHeight;

      if (commandK) {
        if (event.defaultPrevented) return;
        if (feedInteractionMode !== "keyboard") return;
        if (!focusedSlug || committedEndIndex < 0) return;
        const focusedPosition = findPositionForSlug(
          layout.positions,
          blocks,
          focusedSlug,
        );
        if (
          !focusedPosition ||
          focusedPosition.index > committedEndIndex ||
          !isPositionVisibleInViewport(
            focusedPosition,
            currentScrollTop,
            currentViewportHeight,
          )
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (selectedSlugs.size > 0) {
          setSelectionBatchMenuRequest((current) => ({
            slug: focusedSlug,
            sequence: (current?.sequence ?? 0) + 1,
          }));
        } else {
          setActionMenuRequest((current) => ({
            slug: focusedSlug,
            sequence: (current?.sequence ?? 0) + 1,
          }));
        }
        return;
      }

      if (
        event.defaultPrevented ||
        isEditableKeyboardTarget(event.target) ||
        isOverlayKeyboardTarget(event.target)
      ) {
        return;
      }

      if (event.metaKey || event.altKey || event.ctrlKey) {
        return;
      }

      if (event.key === "Escape") {
        if (selectedSlugs.size > 0) {
          event.preventDefault();
          clearSelection();
          return;
        }
        if (feedInteractionMode === "keyboard" && focusedSlug !== null) {
          event.preventDefault();
          setFocusedSlug(null);
          setFeedInteractionMode("pointer");
        }
        return;
      }

      if (event.key === "Enter") {
        if (selectedSlugs.size > 0) {
          const targetSlug = blockSlugFromKeyboardTarget(event.target);
          const keyboardSlug =
            feedInteractionMode === "keyboard" ? focusedSlug : null;
          const pointerSlug =
            feedInteractionMode === "pointer"
              ? targetSlug ?? (
                isPassiveGridKeyboardTarget(event.target, scrollElement ?? null)
                  ? focusedSlug
                  : null
              )
              : null;
          const selectionSlug = keyboardSlug ?? pointerSlug;
          if (
            !selectionSlug ||
            !isCommittedSlug(
              layout.positions,
              blocks,
              selectionSlug,
              committedEndIndex,
            )
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          toggleSelectedSlug(selectionSlug);
          setFocusedSlug(selectionSlug);
          return;
        }
        if (feedInteractionMode !== "keyboard") return;
        if (!focusedSlug) return;
        const block = blocksBySlug.get(focusedSlug);
        if (!block) return;
        event.preventDefault();
        if (event.shiftKey || selectedSlugs.size > 0) {
          toggleSelectedSlug(focusedSlug);
          return;
        }
        handleBlockClick(block);
        return;
      }

      if (!isGridArrowKey(event.key)) return;
      event.preventDefault();
      blockedPointerPositionRef.current = lastPointerPositionRef.current;
      setFeedInteractionMode("keyboard");
      if (committedEndIndex < 0) return;

      if (!focusedSlug) {
        const firstSlug = firstVisibleSlug(
          layout.positions,
          blocks,
          currentScrollTop,
          currentViewportHeight,
          committedEndIndex,
        );
        if (firstSlug) {
          setFocusedSlug(firstSlug);
        }
        return;
      }

      const focusedPosition = findPositionForSlug(
        layout.positions,
        blocks,
        focusedSlug,
      );
      if (
        !focusedPosition ||
        !isPositionVisibleInViewport(
          focusedPosition,
          currentScrollTop,
          currentViewportHeight,
        )
      ) {
        const firstSlug = firstVisibleSlug(
          layout.positions,
          blocks,
          currentScrollTop,
          currentViewportHeight,
          committedEndIndex,
        );
        if (firstSlug) {
          setFocusedSlug(firstSlug);
        }
        return;
      }

      const nextSlug = findLayoutNeighborSlug(
        layout.positions,
        blocks,
        focusedSlug,
        event.key,
        committedEndIndex,
      );
      if (nextSlug) {
        setFocusedSlug(nextSlug);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    blocks,
    blocksBySlug,
    clearSelection,
    committedEndIndex,
    feedInteractionMode,
    focusedSlug,
    handleBlockClick,
    keyboardNavigationDisabled,
    layout.positions,
    selectedSlugs.size,
    scrollTop,
    toggleSelectedSlug,
    viewportHeight,
  ]);

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
    onRequestDelete(slug);
  }, [onRequestDelete]);

  const selectedBlocks = useMemo(
    () => blocks.filter((block) => selectedSlugs.has(block.slug)),
    [blocks, selectedSlugs],
  );

  const keyboardFocusedSlug = feedInteractionMode === "keyboard" ? focusedSlug : null;
  const visualFocusActive = keyboardFocusedSlug !== null || pinnedActionMenuSlug !== null;

  const gridContext: GridContext = useMemo(
    () => ({
      vaultPath,
      thumbsRootPath,
      focusedSlug: keyboardFocusedSlug,
      pinnedActionMenuSlug,
      selectedSlugs,
      selectedBlocks,
      actionMenuRequest,
      selectionBatchMenuRequest,
      hoverEnabled: feedInteractionMode !== "keyboard" && selectedSlugs.size === 0,
      onGridItemPointerMove: handleGridItemPointerMove,
      onKeyboardActionMenuOpenChange: handleKeyboardActionMenuOpenChange,
      onClearSelection: clearSelection,
      onModifiedCardClick: handleModifiedCardClick,
      onBlockClick: handleBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      onLoadBlockTags,
      onBatchSetTag,
      onCreateAndAssignBatch,
      onDeleteSelectedBlocks,
      onRequestRename,
      onRequestDelete: handleRequestDelete,
    }),
    [
      vaultPath,
      thumbsRootPath,
      keyboardFocusedSlug,
      pinnedActionMenuSlug,
      selectedSlugs,
      selectedBlocks,
      actionMenuRequest,
      selectionBatchMenuRequest,
      feedInteractionMode,
      handleGridItemPointerMove,
      handleKeyboardActionMenuOpenChange,
      clearSelection,
      handleModifiedCardClick,
      handleBlockClick,
      tags,
      currentTag,
      onToggleTag,
      onCreateAndAssign,
      onLoadBlockTags,
      onBatchSetTag,
      onCreateAndAssignBatch,
      onDeleteSelectedBlocks,
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
          onPointerDown={handleGridPointerDown}
          onPointerMove={handleGridPointerMove}
          onPointerUp={finishMarqueeSelection}
          onPointerCancel={finishMarqueeSelection}
          className="h-full overflow-x-hidden overflow-y-auto pb-8"
          style={{
            paddingLeft: sidebarCollapsed ? 72 : 32,
            paddingRight: sidebarCollapsed ? 72 : 32,
            scrollbarGutter: "stable",
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
          data-feed-grid-interaction-mode={feedInteractionMode}
          data-feed-grid-focus-mode={visualFocusActive ? "true" : undefined}
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
              marqueeRect={marqueeRect}
              context={gridContext}
            />
          )}
          {parentWidth > 0 && blocks.length > 0 && phase !== "committed" && measurementBatch.length > 0 && (
            <MeasurementPass
              blocks={measurementBatch}
              columnWidth={deriveColumnWidth(parentWidth)}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath}
              onMeasured={handleMeasured}
            />
          )}
        </div>
      </ContextMenuTrigger>

      {!blockDragActive && (
        <GroupSelectionActionBar
          selectedBlocks={selectedBlocks}
          tags={tags}
          currentTag={currentTag}
          onLoadBlockTags={onLoadBlockTags}
          onBatchSetTag={onBatchSetTag}
          onCreateAndAssignBatch={onCreateAndAssignBatch}
          onDeleteSelectedBlocks={onDeleteSelectedBlocks}
          onClearSelection={clearSelection}
        />
      )}

      {menuBlock && (
        <CardTagMenu
          block={menuBlock}
          vaultPath={vaultPath}
          tags={tags}
          currentTag={currentTag}
          onToggleTag={onToggleTag}
          onCreateAndAssign={onCreateAndAssign}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
        />
      )}
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
  marqueeRect,
  context,
}: {
  blocks: LightBlock[];
  visibleItems: MasonryPosition[];
  totalHeight: number;
  priorityBounds: { start: number; end: number };
  committedEndIndex: number;
  activePlaybackSlugs: Set<string>;
  marqueeRect: LayoutRect | null;
  context: GridContext;
}) {
  return (
    <div
      className="relative"
      style={{ height: totalHeight || 1, marginTop: GRID_TOP_INSET_PX }}
      data-grid-layout
    >
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
            isFocused={
              block.slug === context.focusedSlug ||
              block.slug === context.pinnedActionMenuSlug
            }
            isSelected={context.selectedSlugs.has(block.slug)}
            context={context}
          />
        );
      })}
      {marqueeRect && (
        <div
          aria-hidden="true"
          data-feed-grid-marquee-selection=""
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}
    </div>
  );
}

const GridItem = memo(function GridItem({
  block,
  item,
  priority,
  isCommitted,
  allowPlayback,
  isFocused,
  isSelected,
  context,
}: {
  block: LightBlock;
  item: MasonryPosition;
  priority: boolean;
  isCommitted: boolean;
  allowPlayback: boolean;
  isFocused: boolean;
  isSelected: boolean;
  context: GridContext;
}) {
  const openMoreMenuRequestSequence =
    context.actionMenuRequest?.slug === block.slug
      ? context.actionMenuRequest.sequence
      : 0;
  const openSelectionBatchMenuRequestSequence =
    context.selectionBatchMenuRequest?.slug === block.slug
      ? context.selectionBatchMenuRequest.sequence
      : 0;
  const isPinnedActionMenuAnchor = block.slug === context.pinnedActionMenuSlug;

  return (
    <div
      className="relative will-change-transform"
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
        overflow: "visible",
        transform: `translate3d(${item.left}px, ${item.top}px, 0)`,
      }}
      data-feed-grid-item=""
      data-feed-grid-item-focused={isCommitted && isFocused ? "true" : undefined}
      data-feed-grid-item-selected={isCommitted && isSelected ? "true" : undefined}
      data-feed-grid-item-slug={block.slug}
      onPointerMove={(event) => {
        if (isCommitted) {
          context.onGridItemPointerMove(block.slug, event);
        }
      }}
    >
      <div className="relative h-full overflow-hidden" data-feed-grid-card-clip="">
        {isCommitted ? (
          <Card
            block={block}
            vaultPath={context.vaultPath}
            thumbsRootPath={context.thumbsRootPath}
            priority={priority}
            allowPlayback={allowPlayback}
            openMoreMenuRequestSequence={openMoreMenuRequestSequence}
            hoverEnabled={context.hoverEnabled && !isPinnedActionMenuAnchor}
            dragBlocks={
              isSelected
                ? [
                    block,
                    ...context.selectedBlocks.filter((item) => item.slug !== block.slug),
                  ]
                : [block]
            }
            clearSelectionOnDragStart={
              !isSelected && context.selectedSlugs.size > 0
                ? context.onClearSelection
                : undefined
            }
            onKeyboardMoreMenuOpenChange={(open) => {
              context.onKeyboardActionMenuOpenChange(block.slug, open);
            }}
            onModifiedClick={context.onModifiedCardClick}
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
        {isCommitted && isFocused && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-px z-[6]"
            data-feed-grid-action-layer=""
          >
            <div
              className="absolute left-2 top-2 flex h-6 items-center rounded-1 bg-component-fill px-[1ch] font-sans text-sm font-semibold text-foreground"
              data-feed-grid-action-badge=""
            >
              ⌘K
            </div>
          </div>
        )}
        {isCommitted &&
          context.selectedSlugs.size > 0 &&
          (block.slug === context.focusedSlug || openSelectionBatchMenuRequestSequence > 0) && (
          <GroupSelectionCardMenu
            selectedBlocks={context.selectedBlocks}
            tags={context.tags}
            currentTag={context.currentTag}
            openRequestSequence={openSelectionBatchMenuRequestSequence}
            onLoadBlockTags={context.onLoadBlockTags}
            onBatchSetTag={context.onBatchSetTag}
            onCreateAndAssignBatch={context.onCreateAndAssignBatch}
            onDeleteSelectedBlocks={context.onDeleteSelectedBlocks}
            onClearSelection={context.onClearSelection}
          />
        )}
      </div>
      {isCommitted && isSelected && (
        <div
          aria-hidden="true"
          data-feed-grid-selection-frame=""
        />
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
        // Use the exact pixel-snapped columnWidth from the layout engine.
        // Measurement and visible render must share the same width or text
        // wrapping drifts and cached heights become invalid.
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
