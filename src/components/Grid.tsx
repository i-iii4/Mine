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
import { MergeCardsDialog } from "./MergeCardsDialog";
import {
  computeMasonryLayout,
  createVisibilityIndex,
  getMasonryColumnCount,
  getMasonryColumnWidth,
  getVisibleItemsFromIndex,
  type MasonryPosition,
  type MasonryLayout,
} from "@/lib/masonryLayout";
import { computeCardHeight } from "@/lib/cardHeight";
import { computeFeedPlaybackSurfaceEnvelope } from "@/lib/cardHeight";
import { LayoutCache } from "@/lib/layoutCache";
import { createFontMetricsCacheIdentity, fetchWordWidths } from "@/lib/fontMetrics";
import { useGridScroll } from "@/hooks/useGridScroll";
import { useFeedMediaPreloader } from "@/hooks/useFeedMediaPreloader";
import type { WordWidths } from "@/types/fontMetrics";
import {
  buildLayoutGenerationKey,
  type LayoutGenerationKey,
} from "@/lib/layoutGeneration";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";
import { legacyThumbsRoot } from "@/lib/assets";
import {
  computeFeedScrollReadinessWindows,
  sampleFeedScrollSignal,
  type FeedScrollSignal,
  type FeedScrollSignalSample,
} from "@/lib/feedScrollReadiness";
import {
  blockHasExactDeterministicHeight,
  collectViewportFirstMeasurementBatch,
  computeCommittedEndIndex,
  createGridLayoutReadinessDiagnostics,
  generationHasExactDeterministicHeights,
} from "@/lib/gridLayoutReadiness";
import { createGridViewportPaintDiagnostics } from "@/lib/gridViewportDiagnostics";
import {
  createCardHeightDriftReport,
  type CardHeightDriftObservation,
  type CardHeightDriftReport,
} from "@/lib/cardHeightDrift";
import {
  isEditableKeyboardTarget,
  isOverlayKeyboardTarget,
} from "@/lib/keyboardTargets";
import { useDesignMode } from "@/lib/designMode";

declare global {
  interface Window {
    __MINE_REQUEST_HEIGHT_DRIFT_AUDIT__?: () => void;
  }
}

// ─── Layout constants ───────────────────────────────────────────────────────

const COLUMN_MIN_WIDTH = 220;
// Card gap and container side insets are design-variant metrics: the alt
// design (data-design="alt", src/lib/designMode.ts) tightens both to 16px.
const GAP_DEFAULT = 32;
const GAP_ALT = 16;
const GRID_X_INSET_DEFAULT = 32;
const GRID_X_INSET_ALT = 16;
const GRID_TOP_INSET_DEFAULT = 32;
const GRID_TOP_INSET_ALT = 16;
const MEASUREMENT_BATCH_SIZE = 24;
const INITIAL_COMMIT_BLOCKS = 48;
const FEED_AUTOPLAY_MIN_VISIBLE_FRACTION = 0.5;
const FEED_AUTOPLAY_VIEWPORT_MARGIN_RATIO = 0.5;
// Heavy autoplay clips play direct-from-disk, so a small bounded pool can run at
// once instead of a single global slot. Keep this small: each active heavy clip
// is a decoding <video> surface, and the backend lifts the heavy file-size cap
// on the assumption that only a few heavy clips are ever live simultaneously.
export const FEED_HEAVY_MAX_ACTIVE = 2;
// A currently-active heavy clip keeps its pool slot until a challenger exceeds
// its viewport-visible fraction by more than this margin. The hysteresis stops
// two similarly-visible heavy clips from swapping the marginal slot on every
// frame during slow scrolling near a pool boundary.
export const FEED_HEAVY_HYSTERESIS_FRACTION = 0.1;
const GRID_BOTTOM_INSET_PX = 32;
const MARQUEE_DRAG_THRESHOLD_PX = 4;
const SCROLL_ANCHOR_REFERENCE_OFFSET_PX = 32;
// At (or within a sub-pixel of) the very top of the feed the viewport must keep
// showing the newest content: a prepend (new clip via clipper/import → watcher
// refresh; feed is saved_at DESC) or any batch insert at the head should reveal
// the new cards, not anchor the old first card and push the fresh rows above the
// viewport. Above this threshold the anchor behaves normally.
const TOP_OF_FEED_SCROLL_EPSILON_PX = 0.5;
const EMPTY_CHANNEL_PLACEHOLDER_TEXT =
  "Elements connected to this collection will appear here.";
const INITIAL_FEED_SCROLL_SIGNAL: FeedScrollSignal = {
  scrollTop: 0,
  scrollDirection: "idle",
  scrollVelocityPxMs: 0,
  isFastScrolling: false,
};

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
  liveBlockIds: ReadonlySet<number>,
): string | null {
  const current = findPositionForSlug(positions, blocks, currentSlug);
  if (!current) return null;

  const currentCenter = positionCenter(current);
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  let bestSlug: string | null = null;
  let bestScore = Infinity;

  for (const candidate of positions) {
    if (candidate.index === current.index) continue;
    const block = blocks[candidate.index];
    if (!block) continue;
    if (!liveBlockIds.has(block.id)) continue;

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
  liveBlockIds: ReadonlySet<number>,
  topInset: number,
): string | null {
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  let best: MasonryPosition | null = null;

  for (const item of positions) {
    const block = blocks[item.index];
    if (!block || !liveBlockIds.has(block.id)) continue;
    const itemTop = topInset + item.top;
    const itemBottom = topInset + item.bottom;
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

function findViewportPreservationAnchor(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  currentSlugs: ReadonlySet<string>,
  scrollTop: number,
  viewportHeight: number,
  topInset: number,
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

    const itemTop = topInset + position.top;
    const itemBottom = topInset + position.bottom;
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
  topInset: number,
): number {
  const unclamped = topInset + position.top - anchor.offsetTop;
  const maxScrollTop = Math.max(
    0,
    topInset + layout.totalHeight + GRID_BOTTOM_INSET_PX - viewportHeight,
  );
  return Math.min(Math.max(0, unclamped), maxScrollTop);
}

function isPositionVisibleInViewport(
  position: MasonryPosition,
  scrollTop: number,
  viewportHeight: number,
  topInset: number,
): boolean {
  if (viewportHeight <= 0) return false;
  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;
  const itemTop = topInset + position.top;
  const itemBottom = topInset + position.bottom;
  return itemBottom >= viewportTop && itemTop <= viewportBottom;
}

function scrollPositionIntoView(
  scrollElement: HTMLElement,
  position: MasonryPosition,
  topInset: number,
): void {
  const padding = 32;
  const itemTop = topInset + position.top;
  const itemBottom = topInset + position.bottom;
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

function blockCanRenderFromDeterministicHeight(
  block: LightBlock,
  wordWidthsMap: ReadonlyMap<number, WordWidths>,
  wordMetricsSettled: boolean,
): boolean {
  return blockHasExactDeterministicHeight(block, wordWidthsMap) || wordMetricsSettled;
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

function EmptyChannelPlaceholder({ viewportHeight }: { viewportHeight: number }) {
  return (
    <div
      className="grid place-items-center"
      style={{ minHeight: Math.max(240, viewportHeight) }}
      data-grid-empty-channel-placeholder=""
    >
      <p
        className="max-w-xl text-center text-base leading-relaxed text-muted-foreground italic"
        data-grid-empty-channel-placeholder-text=""
      >
        {EMPTY_CHANNEL_PLACEHOLDER_TEXT}
      </p>
    </div>
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
  liveBlockIds: ReadonlySet<number>,
): string[] {
  const selected: string[] = [];

  for (const candidate of positions) {
    const block = blocks[candidate.index];
    if (!block) continue;
    if (!liveBlockIds.has(block.id)) continue;
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

function isLiveSlug(
  positions: readonly MasonryPosition[],
  blocks: readonly LightBlock[],
  slug: string,
  liveBlockIds: ReadonlySet<number>,
): boolean {
  const position = findPositionForSlug(positions, blocks, slug);
  const block = position ? blocks[position.index] : null;
  return Boolean(block && liveBlockIds.has(block.id));
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface GridProps {
  blocks: LightBlock[];
  vaultPath: string;
  thumbsRootPath?: string;
  /**
   * Per-slug thumbnail cache-buster. Bumped by App on a `thumb:updated` event
   * so the affected card re-renders and refetches its regenerated
   * poster/thumbnail without a full grid reload. Slugs absent from the map are
   * version 0 (unversioned URLs).
   */
  thumbVersions?: ReadonlyMap<string, number>;
  tags: TagCount[];
  currentTag?: string;
  routeSnapshotReady?: boolean;
  scrollToTop: number;
  blockDragActive?: boolean;
  detailOpen?: boolean;
  keyboardNavigationDisabled?: boolean;
  restoreFocusSlug?: string | null;
  restoreFocusSequence?: number;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
  onMergeSelectedBlocks: (orderedSlugs: string[]) => void | Promise<void>;
  onGroupSelectionStart?: () => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
  heightDriftAuditMode?: boolean;
  hasMoreBlocks?: boolean;
  loadingMoreBlocks?: boolean;
  onLoadMoreBlocks?: () => void;
}

interface GridContext {
  vaultPath: string;
  thumbsRootPath?: string;
  /** Design-variant top inset between the chrome and the first card row. */
  gridTopInset: number;
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
  onMergeSelectedBlocks: () => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
}

// ─── Layout cache (module-level, persists across channel switches) ─────────

const layoutCache = new LayoutCache(10);

// ─── Deterministic layout computation ──────────────────────────────────────

function deriveColumnWidth(parentWidth: number, gap: number): number {
  return getMasonryColumnWidth(parentWidth, COLUMN_MIN_WIDTH, gap);
}

function scheduleIdleTask(callback: () => void): number {
  if (typeof window === "undefined") return -1;
  if (typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(callback, { timeout: 1000 });
  }
  return window.setTimeout(callback, 0);
}

function cancelIdleTask(handle: number): void {
  if (handle < 0 || typeof window === "undefined") return;
  if (typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle);
    return;
  }
  window.clearTimeout(handle);
}

function buildLayout(
  blocks: LightBlock[],
  parentWidth: number,
  wordWidthsMap: Map<number, WordWidths>,
  gap: number,
): MasonryLayout {
  const columnWidth = deriveColumnWidth(parentWidth, gap);

  const heights = blocks.map((block) => {
    return computeCardHeight(block, columnWidth, wordWidthsMap.get(block.id) ?? null);
  });

  return computeMasonryLayout(
    heights,
    parentWidth,
    COLUMN_MIN_WIDTH,
    gap,
  );
}

// ─── Heavy autoplay pool arbitration ───────────────────────────────────────

export interface HeavyPlaybackCandidate {
  slug: string;
  /** Whether the playback surface overlaps the strict viewport at all. */
  inViewport: boolean;
  /** Surface fraction covered by the strict viewport. */
  viewportVisibleFraction: number;
  /** Surface fraction covered by the expanded autoplay window. */
  windowVisibleFraction: number;
  /** Distance of the surface center from the viewport center. */
  centerDistance: number;
  /** Surface top in layout coordinates; smaller wins ties (top-most first). */
  top: number;
}

// Strict, total ordering of heavy candidates from strongest to weakest. The
// final slug tie-break makes the order independent of visibleItems iteration
// order, so the pool never flickers on incidental reordering.
function compareHeavyPlaybackStrength(
  a: HeavyPlaybackCandidate,
  b: HeavyPlaybackCandidate,
): number {
  if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
  if (Math.abs(a.viewportVisibleFraction - b.viewportVisibleFraction) > 0.001) {
    return b.viewportVisibleFraction - a.viewportVisibleFraction;
  }
  if (Math.abs(a.windowVisibleFraction - b.windowVisibleFraction) > 0.001) {
    return b.windowVisibleFraction - a.windowVisibleFraction;
  }
  if (Math.abs(a.top - b.top) > 0.5) return a.top - b.top;
  if (Math.abs(a.centerDistance - b.centerDistance) > 0.5) {
    return a.centerDistance - b.centerDistance;
  }
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * Pick which heavy autoplay clips play, bounded to `maxActive`, with hysteresis
 * against the currently-active set so a marginal challenger cannot displace an
 * incumbent unless it is decisively more visible.
 *
 * The ranking is deterministic (see {@link compareHeavyPlaybackStrength}). An
 * incumbent that just fell out of the winner set reclaims its slot from the
 * weakest non-incumbent winner unless that winner beats it by more than
 * `hysteresisFraction` on viewport-visible fraction.
 */
export function selectActiveHeavyPlaybackSlugs(
  candidates: readonly HeavyPlaybackCandidate[],
  previousActive: ReadonlySet<string>,
  maxActive: number = FEED_HEAVY_MAX_ACTIVE,
  hysteresisFraction: number = FEED_HEAVY_HYSTERESIS_FRACTION,
): Set<string> {
  if (maxActive <= 0 || candidates.length === 0) return new Set<string>();

  const ranked = [...candidates].sort(compareHeavyPlaybackStrength);
  const keep = new Set(ranked.slice(0, maxActive).map((candidate) => candidate.slug));

  // No boundary contention: either nothing was active before, or every
  // candidate already fits, so hysteresis cannot change the outcome.
  if (previousActive.size === 0 || ranked.length <= maxActive) {
    return keep;
  }

  const bySlug = new Map(ranked.map((candidate) => [candidate.slug, candidate]));
  const atRiskIncumbents = ranked.filter(
    (candidate) => previousActive.has(candidate.slug) && !keep.has(candidate.slug),
  );

  for (const incumbent of atRiskIncumbents) {
    // Weakest challenger (non-incumbent) currently holding a slot.
    let weakestChallenger: HeavyPlaybackCandidate | null = null;
    for (const slug of keep) {
      if (previousActive.has(slug)) continue;
      const challenger = bySlug.get(slug);
      if (!challenger) continue;
      if (
        weakestChallenger === null ||
        compareHeavyPlaybackStrength(challenger, weakestChallenger) > 0
      ) {
        weakestChallenger = challenger;
      }
    }
    if (!weakestChallenger) break;
    // Hysteresis must not carry across the inViewport boundary: an incumbent
    // that has scrolled out of the strict viewport cannot hold its slot against
    // a challenger that is already inside it, however small the challenger's
    // visible fraction. The fraction-margin protection only applies when both
    // are on the same side of the boundary.
    if (weakestChallenger.inViewport && !incumbent.inViewport) {
      continue;
    }
    if (
      weakestChallenger.viewportVisibleFraction <=
      incumbent.viewportVisibleFraction + hysteresisFraction
    ) {
      keep.delete(weakestChallenger.slug);
      keep.add(incumbent.slug);
    }
  }

  return keep;
}

// ─── Grid component ────────────────────────────────────────────────────────

export function Grid({
  blocks,
  vaultPath,
  thumbsRootPath,
  thumbVersions,
  tags,
  currentTag,
  routeSnapshotReady = true,
  scrollToTop,
  blockDragActive = false,
  detailOpen = false,
  keyboardNavigationDisabled = false,
  restoreFocusSlug = null,
  restoreFocusSequence = 0,
  onBlockClick,
  onToggleTag,
  onCreateAndAssign,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onDeleteSelectedBlocks,
  onMergeSelectedBlocks,
  onGroupSelectionStart,
  onRequestRename,
  onRequestDelete,
  onColumnCountChange,
  heightDriftAuditMode = false,
  hasMoreBlocks = false,
  loadingMoreBlocks = false,
  onLoadMoreBlocks,
}: GridProps) {
  const designMode = useDesignMode();
  const layoutGap = designMode === "alt" ? GAP_ALT : GAP_DEFAULT;
  const gridXInset = designMode === "alt" ? GRID_X_INSET_ALT : GRID_X_INSET_DEFAULT;
  const gridTopInset = designMode === "alt" ? GRID_TOP_INSET_ALT : GRID_TOP_INSET_DEFAULT;
  const parentRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [feedScrollSignal, setFeedScrollSignal] = useState<FeedScrollSignal>(
    INITIAL_FEED_SCROLL_SIGNAL,
  );
  const [menuBlock, setMenuBlock] = useState<LightBlock | null>(null);
  const [focusedSlug, setFocusedSlug] = useState<string | null>(null);
  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(() => new Set());
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
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
  const scrollSignalSampleRef = useRef<FeedScrollSignalSample | null>(null);
  const scrollAnchorSnapshotRef = useRef<ScrollAnchorSnapshot | null>(null);
  const pendingScrollAnchorRef = useRef<PendingScrollAnchor | null>(null);
  const suppressedFocusedScrollSlugRef = useRef<string | null>(null);
  const lastViewportBlankWarningRef = useRef<string | null>(null);
  const heightDriftReportRef = useRef<CardHeightDriftReport | null>(null);
  const heightDriftIdleTaskRef = useRef<number | null>(null);
  const heightDriftAuditInputRef = useRef<{
    canMeasure: boolean;
    blocks: readonly LightBlock[];
    positions: readonly MasonryPosition[];
    visibleItems: readonly MasonryPosition[];
    scrollTop: number;
    viewportHeight: number;
    targetEndIndex: number;
  } | null>(null);

  // Grid production geometry is deterministic: layout is derived from block
  // data, the current column width and precomputed word metrics. DOM
  // measurement is no longer a production source of card height; it exists
  // only as an explicit drift-audit probe in development.
  const [wordWidthsMap, setWordWidthsMap] = useState<Map<number, WordWidths>>(new Map());
  const [wordMetricsSettled, setWordMetricsSettled] = useState(blocks.length === 0);
  const [heightDriftAuditBatch, setHeightDriftAuditBatch] = useState<LightBlock[]>([]);
  // Font-metrics cache identity (createFontMetricsCacheIdentity.cacheKey) per
  // block id, tracking exactly which measured text each map entry was computed
  // for. Lets the metrics effect fetch only genuinely new or edited blocks
  // instead of clearing every word width on each blocks identity change.
  const wordWidthsIdentityRef = useRef<Map<number, string>>(new Map());

  const readGridScrollMetrics = useCallback((
    element: HTMLElement,
    fallbackContentRect?: DOMRectReadOnly,
  ) => {
    const style = window.getComputedStyle(element);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const layoutWidth = element.clientWidth > 0
      ? Math.max(0, element.clientWidth - paddingLeft - paddingRight)
      : Math.max(0, fallbackContentRect?.width ?? 0);
    const measuredViewportHeight = element.clientHeight > 0
      ? element.clientHeight
      : Math.max(0, fallbackContentRect?.height ?? 0);
    return {
      layoutWidth,
      viewportHeight: measuredViewportHeight,
    };
  }, []);

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
      const metrics = readGridScrollMetrics(el, entry.contentRect);
      if (metrics.layoutWidth > 0) setParentWidth(metrics.layoutWidth);
      if (metrics.viewportHeight > 0) setViewportHeight(metrics.viewportHeight);
    });

    const metrics = readGridScrollMetrics(el);
    setParentWidth(metrics.layoutWidth);
    setViewportHeight(metrics.viewportHeight);
    setScrollTop(el.scrollTop);
    latestScrollTopRef.current = el.scrollTop;
    scrollSignalSampleRef.current = {
      scrollTop: el.scrollTop,
      timeMs: performance.now(),
      scrollVelocityPxMs: 0,
      isFastScrolling: false,
    };
    setFeedScrollSignal({
      ...INITIAL_FEED_SCROLL_SIGNAL,
      scrollTop: el.scrollTop,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [readGridScrollMetrics]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const updateScrollTop = () => {
      rafId = null;
      const next = el.scrollTop;
      latestScrollTopRef.current = next;
      const sampled = sampleFeedScrollSignal({
        previous: scrollSignalSampleRef.current,
        scrollTop: next,
        timeMs: performance.now(),
      });
      scrollSignalSampleRef.current = sampled.sample;
      setFeedScrollSignal(sampled.signal);
      setScrollTop((current) => {
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
    scrollSignalSampleRef.current = {
      scrollTop: el.scrollTop,
      timeMs: performance.now(),
      scrollVelocityPxMs: 0,
      isFastScrolling: false,
    };
    setFeedScrollSignal({
      ...INITIAL_FEED_SCROLL_SIGNAL,
      scrollTop: el.scrollTop,
    });
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // A block needs (re)measuring only when we have no word widths recorded for
    // its id, or the recorded widths were computed for a different text slice
    // (cacheKey mismatch after an in-place edit). Blocks whose widths are still
    // valid keep their exact height and stay rendered — no map reset, no
    // skeleton flash, no O(N) IndexedDB re-query on every pagination page.
    const identityByBlockId = new Map<number, string>();
    const needsCompute: LightBlock[] = [];
    for (const block of blocks) {
      const identity = createFontMetricsCacheIdentity(block);
      identityByBlockId.set(block.id, identity.cacheKey);
      if (wordWidthsIdentityRef.current.get(block.id) !== identity.cacheKey) {
        needsCompute.push(block);
      }
    }

    // Prune metrics that no longer apply, before the early return so a
    // removal-only change still frees the entries. An id absent from the current
    // block set has left the feed (channel switch, pagination reset); an id whose
    // recorded cacheKey no longer matches was edited in place. Dropping the stale
    // entry makes the edited block fall back to the skeleton until its recomputed
    // widths arrive instead of being laid out at its pre-edit height, and bounds
    // both structures to the live block set across a long session.
    for (const id of [...wordWidthsIdentityRef.current.keys()]) {
      const currentKey = identityByBlockId.get(id);
      if (currentKey === undefined || wordWidthsIdentityRef.current.get(id) !== currentKey) {
        wordWidthsIdentityRef.current.delete(id);
      }
    }
    setWordWidthsMap((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (!wordWidthsIdentityRef.current.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    if (needsCompute.length === 0) {
      setWordMetricsSettled(true);
      return () => {
        cancelled = true;
      };
    }

    // New or edited blocks have no exact height yet; hold them in the skeleton
    // state until their widths arrive rather than flashing a fallback height.
    setWordMetricsSettled(false);
    void fetchWordWidths(needsCompute)
      .then((computed) => {
        if (cancelled || computed.size === 0) return;
        for (const id of computed.keys()) {
          const cacheKey = identityByBlockId.get(id);
          if (cacheKey !== undefined) {
            wordWidthsIdentityRef.current.set(id, cacheKey);
          }
        }
        setWordWidthsMap((prev) => {
          const next = new Map(prev);
          for (const [id, widths] of computed) {
            next.set(id, widths);
          }
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) {
          setWordMetricsSettled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [blocks]);

  // Exact masonry column geometry. The layout is a pure function of these plus
  // the gap and block heights, so the generation key changes only when the
  // layout would actually change — not on every pixel of a sidebar/scrollbar
  // resize. That keeps VirtualMasonryLayout mounted and the module-level
  // layoutCache warm across sub-column-width width changes.
  const columnWidth = useMemo(
    () => deriveColumnWidth(parentWidth, layoutGap),
    [layoutGap, parentWidth],
  );
  const columnCount = useMemo(
    () => getMasonryColumnCount(parentWidth, COLUMN_MIN_WIDTH, layoutGap),
    [layoutGap, parentWidth],
  );
  const generationKey = useMemo<LayoutGenerationKey>(
    () => buildLayoutGenerationKey({
      blocks,
      routeKey: currentTag ?? "__all__",
      columnWidth,
      columnCount,
      // The module-level layoutCache must never serve a layout computed with
      // a different gap (design variants change it).
      layoutGap,
    }),
    [blocks, columnCount, columnWidth, currentTag, layoutGap],
  );
  const heightDriftBlocksById = useMemo(() => {
    const map = new Map<number, LightBlock>();
    for (const block of blocks) {
      map.set(block.id, block);
    }
    return map;
  }, [blocks]);
  const heightDriftContextRef = useRef<{
    blocksById: ReadonlyMap<number, LightBlock>;
    generationKey: LayoutGenerationKey;
    parentWidth: number;
    wordWidthsMap: Map<number, WordWidths>;
  }>({
    blocksById: heightDriftBlocksById,
    generationKey,
    parentWidth,
    wordWidthsMap,
  });
  heightDriftContextRef.current = {
    blocksById: heightDriftBlocksById,
    generationKey,
    parentWidth,
    wordWidthsMap,
  };
  useEffect(() => {
    return () => {
      if (heightDriftIdleTaskRef.current !== null) {
        cancelIdleTask(heightDriftIdleTaskRef.current);
        heightDriftIdleTaskRef.current = null;
      }
    };
  }, []);
  const resolvedThumbsRootPath = useMemo(
    () => thumbsRootPath ?? legacyThumbsRoot(vaultPath),
    [thumbsRootPath, vaultPath],
  );

  const renderReadyBlockIds = useMemo(() => {
    const ids = new Set<number>();
    if (parentWidth <= 0) return ids;
    for (const block of blocks) {
      if (blockCanRenderFromDeterministicHeight(block, wordWidthsMap, wordMetricsSettled)) {
        ids.add(block.id);
      }
    }
    return ids;
  }, [blocks, parentWidth, wordMetricsSettled, wordWidthsMap]);

  const committedEndIndex = useMemo(
    () => computeCommittedEndIndex(blocks, renderReadyBlockIds, parentWidth > 0),
    [blocks, parentWidth, renderReadyBlockIds],
  );

  // Exactness is stricter than "settled": after the metrics promise resolves,
  // every block becomes render-ready (fallback heights keep the feed usable),
  // but a generation is only cacheable when no block sits on the worst-clamped
  // text fallback — otherwise the oversized fallback layout gets pinned in the
  // module-level cache and survives the later arrival of exact word widths.
  const allBlocksHaveExactHeights = useMemo(
    () => generationHasExactDeterministicHeights(blocks, wordWidthsMap),
    [blocks, wordWidthsMap],
  );

  const allCurrentGenerationDeterministic =
    wordMetricsSettled &&
    parentWidth > 0 &&
    blocks.length > 0 &&
    committedEndIndex === blocks.length - 1 &&
    allBlocksHaveExactHeights;

  const publishHeightDriftReport = useCallback(
    (results: Array<{ id: number; height: number }>) => {
      const driftContext = heightDriftContextRef.current;
      if (
        driftContext.generationKey === generationKey &&
        driftContext.parentWidth > 0 &&
        results.length > 0 &&
        typeof window !== "undefined"
      ) {
        if (heightDriftIdleTaskRef.current !== null) {
          cancelIdleTask(heightDriftIdleTaskRef.current);
        }
        const measuredResults = results.slice();
        heightDriftIdleTaskRef.current = scheduleIdleTask(() => {
          heightDriftIdleTaskRef.current = null;
          const debug = window.__MINE_FEED_SCROLL_DEBUG__;
          if (!debug || debug.layoutGenerationKey !== generationKey) return;

          // generationKey embeds the gap, so a matching driftContext is
          // guaranteed to have been built with the current layoutGap.
          const columnWidth = deriveColumnWidth(driftContext.parentWidth, layoutGap);
          const observations: CardHeightDriftObservation[] = [];
          for (const result of measuredResults) {
            const block = driftContext.blocksById.get(result.id);
            if (!block) continue;
            const wordWidths = driftContext.wordWidthsMap.get(result.id) ?? null;
            const wordMetricsRequired = block.card_kind !== "media";
            observations.push({
              block,
              measuredHeight: result.height,
              deterministicHeight: Math.ceil(
                computeCardHeight(block, columnWidth, wordWidths),
              ),
              wordMetricsReady: !wordMetricsRequired || wordWidths !== null,
            });
          }
          if (observations.length === 0) return;

          const report = createCardHeightDriftReport({
            layoutGenerationKey: generationKey,
            columnWidth,
            observations,
          });
          heightDriftReportRef.current = report;
          debug.heightDrift = report;
        });
      }
    },
    [generationKey],
  );

  // The visible layout always belongs to the current generation. Production
  // heights come from deterministic card geometry only; measured DOM heights
  // are never fed back into layout because that feedback loop is what caused
  // scroll jumps and blank/skeleton windows during fast scroll.
  const layout = useMemo((): MasonryLayout => {
    if (parentWidth <= 0 || blocks.length === 0) {
      return {
        columnCount: 1,
        columnWidth: 0,
        totalHeight: 0,
        positions: [],
      };
    }

    if (!allCurrentGenerationDeterministic) {
      return buildLayout(blocks, parentWidth, wordWidthsMap, layoutGap);
    }

    const cached = layoutCache.get(generationKey);
    if (cached) return cached;

    const fresh = buildLayout(blocks, parentWidth, wordWidthsMap, layoutGap);
    layoutCache.set(generationKey, fresh);
    return fresh;
  }, [allCurrentGenerationDeterministic, blocks, generationKey, layoutGap, parentWidth, wordWidthsMap]);

  useEffect(() => {
    onColumnCountChange?.(layout.columnCount);
  }, [layout.columnCount, onColumnCountChange]);

  const visibilityIndex = useMemo(
    () => createVisibilityIndex(layout),
    [layout],
  );
  const scrollReadinessWindows = useMemo(
    () => computeFeedScrollReadinessWindows({
      viewportHeight,
      scrollVelocityPxMs: feedScrollSignal.scrollVelocityPxMs,
      scrollDirection: feedScrollSignal.scrollDirection,
      visibleItemCount: 0,
    }),
    [
      feedScrollSignal.scrollDirection,
      feedScrollSignal.scrollVelocityPxMs,
      viewportHeight,
    ],
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
        scrollReadinessWindows.renderBeforePx,
        scrollReadinessWindows.renderAfterPx,
      );
    },
    [
      scrollReadinessWindows.renderAfterPx,
      scrollReadinessWindows.renderBeforePx,
      visibilityIndex,
      viewportHeight,
    ],
  );

  const visibleItems = useGridScroll(parentRef, {
    getVisibleItems,
    resetKey: generationKey,
    viewportHeight,
  });

  const maxVisibleIndex = useMemo(
    () => visibleItems.reduce((max, item) => Math.max(max, item.index), -1),
    [visibleItems],
  );

  const targetCommittedEndIndex = useMemo(() => {
    if (blocks.length === 0) return -1;
    const commitLookaheadBlocks = Math.max(
      scrollReadinessWindows.commitLookaheadBlocks,
      visibleItems.length * 2,
    );
    const baseEnd = maxVisibleIndex >= 0
      ? maxVisibleIndex + commitLookaheadBlocks
      : INITIAL_COMMIT_BLOCKS - 1;
    return Math.min(blocks.length - 1, baseEnd);
  }, [
    blocks.length,
    maxVisibleIndex,
    scrollReadinessWindows.commitLookaheadBlocks,
    visibleItems.length,
  ]);

  heightDriftAuditInputRef.current = {
    canMeasure:
      heightDriftAuditMode &&
      wordMetricsSettled &&
      targetCommittedEndIndex >= 0 &&
      renderReadyBlockIds.size > 0,
    blocks,
    positions: layout.positions,
    visibleItems,
    scrollTop,
    viewportHeight,
    targetEndIndex: targetCommittedEndIndex,
  };
  useEffect(() => {
    const canMeasure = heightDriftAuditInputRef.current?.canMeasure ?? false;
    if (!heightDriftAuditMode || typeof window === "undefined" || !canMeasure) {
      if (typeof window !== "undefined") {
        delete window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__;
      }
      return;
    }
    window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__ = () => {
      const input = heightDriftAuditInputRef.current;
      if (!input?.canMeasure) return;
      setHeightDriftAuditBatch(
        collectViewportFirstMeasurementBatch({
          blocks: input.blocks,
          positions: input.positions,
          visibleItems: input.visibleItems,
          measuredBlockIds: new Set<number>(),
          scrollTop: input.scrollTop,
          viewportHeight: input.viewportHeight,
          targetEndIndex: input.targetEndIndex,
          batchSize: MEASUREMENT_BATCH_SIZE,
        }),
      );
    };
    return () => {
      delete window.__MINE_REQUEST_HEIGHT_DRIFT_AUDIT__;
    };
  }, [
    heightDriftAuditMode,
    renderReadyBlockIds.size,
    targetCommittedEndIndex,
    wordMetricsSettled,
    wordWidthsMap.size,
  ]);

  const showEmptyChannelPlaceholder = Boolean(
    currentTag &&
    routeSnapshotReady &&
    blocks.length === 0,
  );

  useLayoutEffect(() => {
    const scrollElement = parentRef.current;
    const routeKey = currentTag ?? "__all__";
    const previous = scrollAnchorSnapshotRef.current;

    if (
      scrollElement &&
      previous &&
      previous.routeKey === routeKey &&
      Math.abs(previous.parentWidth - parentWidth) <= 0.5 &&
      viewportHeight > 0 &&
      // At the very top of the feed, do not anchor: a head insert must reveal the
      // new cards. Anchoring the old first card here (single-column, or a batch
      // insert of >= columnCount cards) fixes it in place and hides the fresh
      // rows above the viewport. Away from the top this guard is inactive and
      // anchoring keeps the first visible card fixed when content above it moves.
      latestScrollTopRef.current > TOP_OF_FEED_SCROLL_EPSILON_PX &&
      // The layout object changes identity only when positions actually change
      // (blocks added/removed, or a block's height changed after a preview
      // upgrade). Re-anchoring on every layout change — not just removals —
      // keeps the first visible card fixed when content above the viewport
      // grows or shrinks. When nothing above shifted, the anchor resolves to
      // the current scrollTop and the apply step below is a no-op.
      previous.positions !== layout.positions
    ) {
      const currentSlugs = new Set(blocks.map((block) => block.slug));
      const anchor = findViewportPreservationAnchor(
        previous.positions,
        previous.blocks,
        currentSlugs,
        latestScrollTopRef.current,
        scrollElement.clientHeight || viewportHeight,
        gridTopInset,
      );
      if (anchor) {
        pendingScrollAnchorRef.current = { routeKey, anchor };
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
        } else if (renderReadyBlockIds.has(blocks[nextPosition.index]?.id ?? -1)) {
          const nextScrollTop = clampedScrollTopForAnchor(
            layout,
            scrollElement.clientHeight || viewportHeight,
            nextPosition,
            pending.anchor,
            gridTopInset,
          );
          pendingScrollAnchorRef.current = null;
          suppressedFocusedScrollSlugRef.current = focusedSlug;
          if (Math.abs(scrollElement.scrollTop - nextScrollTop) > 0.5) {
            scrollElement.scrollTop = nextScrollTop;
            latestScrollTopRef.current = nextScrollTop;
            setScrollTop(nextScrollTop);
            scrollElement.dispatchEvent(new Event("scroll"));
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
  }, [
    blocks,
    currentTag,
    focusedSlug,
    layout,
    parentWidth,
    renderReadyBlockIds,
    viewportHeight,
  ]);

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
      start: Math.max(0, scrollTop - scrollReadinessWindows.priorityBeforePx),
      end: scrollTop + viewportHeight + scrollReadinessWindows.priorityAfterPx,
    };
  }, [
    scrollReadinessWindows.priorityAfterPx,
    scrollReadinessWindows.priorityBeforePx,
    scrollTop,
    viewportHeight,
  ]);
  const feedMediaPreloadStats = useFeedMediaPreloader({
    enabled: blocks.length > 0 && parentWidth > 0,
    blocks,
    layout,
    visibilityIndex,
    scrollTop,
    viewportHeight,
    scrollDirection: feedScrollSignal.scrollDirection,
    scrollVelocityPxMs: feedScrollSignal.scrollVelocityPxMs,
    isFastScrolling: feedScrollSignal.isFastScrolling,
    generationKey,
    thumbsRootPath: resolvedThumbsRootPath,
    mountedGridItems: visibleItems.length,
    windows: scrollReadinessWindows,
  });
  void feedMediaPreloadStats;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const debug = window.__MINE_FEED_SCROLL_DEBUG__;
    if (debug && heightDriftReportRef.current) {
      debug.heightDrift = heightDriftReportRef.current;
    }
  }, [feedMediaPreloadStats, generationKey]);

  const layoutReadinessDiagnostics = useMemo(
    () => createGridLayoutReadinessDiagnostics({
      layoutGenerationKey: generationKey,
      blocks,
      visibleItems,
      measuredBlockIds: renderReadyBlockIds,
      committedEndIndex,
      targetCommittedEndIndex,
      maxVisibleIndex,
      scrollTop,
      viewportHeight,
      measurementBatchSize: heightDriftAuditBatch.length,
    }),
    [
      blocks,
      committedEndIndex,
      generationKey,
      heightDriftAuditBatch.length,
      maxVisibleIndex,
      renderReadyBlockIds,
      scrollTop,
      targetCommittedEndIndex,
      viewportHeight,
      visibleItems,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const debug = window.__MINE_FEED_SCROLL_DEBUG__;
    if (debug) {
      debug.layout = layoutReadinessDiagnostics;
    }
  }, [layoutReadinessDiagnostics]);

  const publishViewportPaintDiagnostics = useCallback(() => {
    if (typeof window === "undefined") return;
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    const diagnostics = createGridViewportPaintDiagnostics({
      layoutGenerationKey: generationKey,
      positions: layout.positions,
      visibleItemCount: visibleItems.length,
      scrollTop: scrollElement.scrollTop,
      viewportHeight: scrollElement.clientHeight || viewportHeight,
      layoutTotalHeight: layout.totalHeight,
      scrollElement,
    });

    const debug = window.__MINE_FEED_SCROLL_DEBUG__;
    if (debug) {
      debug.viewport = diagnostics;
    }

    if (!diagnostics.blankViewportRisk) {
      if (diagnostics.reason === "ok") {
        lastViewportBlankWarningRef.current = null;
      }
      return;
    }

    const signature = [
      diagnostics.layoutGenerationKey,
      Math.round(diagnostics.scrollTop),
      diagnostics.viewportHeight,
      diagnostics.layoutViewportPositionCount,
      diagnostics.visibleItemCount,
      diagnostics.mountedDomItemCount,
    ].join(":");
    if (lastViewportBlankWarningRef.current === signature) return;
    lastViewportBlankWarningRef.current = signature;

    if (import.meta.env.DEV) {
      console.warn("[Mine/Grid] blank viewport risk", diagnostics);
    }
  }, [
    generationKey,
    layout.positions,
    layout.totalHeight,
    viewportHeight,
    visibleItems.length,
  ]);

  useLayoutEffect(() => {
    publishViewportPaintDiagnostics();
  }, [publishViewportPaintDiagnostics]);

  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;
    scrollElement.addEventListener("scroll", publishViewportPaintDiagnostics, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", publishViewportPaintDiagnostics);
    };
  }, [publishViewportPaintDiagnostics]);

  const blocksBySlug = useMemo(
    () => new Map(blocks.map((block) => [block.slug, block])),
    [blocks],
  );

  useEffect(() => {
    suppressedFocusedScrollSlugRef.current = null;
    setFocusedSlug(null);
    setFeedInteractionMode("pointer");
    setPinnedActionMenuSlug(null);
    setSelectedSlugs(new Set());
    setMarqueeSelection(null);
  }, [currentTag]);

  useEffect(() => {
    if (focusedSlug && !blocksBySlug.has(focusedSlug)) {
      suppressedFocusedScrollSlugRef.current = null;
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
    if (suppressedFocusedScrollSlugRef.current) {
      if (suppressedFocusedScrollSlugRef.current === focusedSlug) return;
      suppressedFocusedScrollSlugRef.current = null;
    }
    const scrollElement = parentRef.current;
    if (!scrollElement) return;
    const position = findPositionForSlug(layout.positions, blocks, focusedSlug);
    if (!position) return;
    const scheduledScrollTop = scrollElement.scrollTop;
    const rafId = requestAnimationFrame(() => {
      if (pendingScrollAnchorRef.current) return;
      if (Math.abs(scrollElement.scrollTop - scheduledScrollTop) > 0.5) return;
      if (suppressedFocusedScrollSlugRef.current) {
        if (suppressedFocusedScrollSlugRef.current === focusedSlug) return;
        suppressedFocusedScrollSlugRef.current = null;
      }
      scrollPositionIntoView(scrollElement, position, gridTopInset);
    });
    return () => cancelAnimationFrame(rafId);
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
        renderReadyBlockIds,
      ),
    ));
  }, [blocks, layout.positions, renderReadyBlockIds]);

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
        if (!focusedSlug) return;
        const focusedPosition = findPositionForSlug(
          layout.positions,
          blocks,
          focusedSlug,
        );
        const focusedBlock = focusedPosition ? blocks[focusedPosition.index] : null;
        if (
          !focusedPosition ||
          !focusedBlock ||
          !renderReadyBlockIds.has(focusedBlock.id) ||
          !isPositionVisibleInViewport(
            focusedPosition,
            currentScrollTop,
            currentViewportHeight,
            gridTopInset,
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
            !isLiveSlug(
              layout.positions,
              blocks,
              selectionSlug,
              renderReadyBlockIds,
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
      if (renderReadyBlockIds.size === 0) return;

      if (!focusedSlug) {
        const firstSlug = firstVisibleSlug(
          layout.positions,
          blocks,
          currentScrollTop,
          currentViewportHeight,
          renderReadyBlockIds,
          gridTopInset,
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
      const focusedBlock = focusedPosition ? blocks[focusedPosition.index] : null;
      if (
        !focusedPosition ||
        !focusedBlock ||
        !renderReadyBlockIds.has(focusedBlock.id) ||
        !isPositionVisibleInViewport(
          focusedPosition,
          currentScrollTop,
          currentViewportHeight,
          gridTopInset,
        )
      ) {
        const firstSlug = firstVisibleSlug(
          layout.positions,
          blocks,
          currentScrollTop,
          currentViewportHeight,
          renderReadyBlockIds,
          gridTopInset,
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
        renderReadyBlockIds,
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
    feedInteractionMode,
    focusedSlug,
    handleBlockClick,
    keyboardNavigationDisabled,
    layout.positions,
    renderReadyBlockIds,
    selectedSlugs.size,
    scrollTop,
    toggleSelectedSlug,
    viewportHeight,
  ]);

  const activeHeavyPlaybackRef = useRef<ReadonlySet<string>>(new Set<string>());

  const activePlaybackSlugs = useMemo(() => {
    if (renderReadyBlockIds.size === 0 || viewportHeight <= 0) {
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
    const heavyCandidates: HeavyPlaybackCandidate[] = [];

    for (const item of visibleItems) {
      const block = blocks[item.index];
      if (!block) continue;
      if (!renderReadyBlockIds.has(block.id)) continue;
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

      // Standard clips buffer through a size-capped blob, so any number of them
      // may play at once.
      if (playback.profile === "standard") {
        active.add(block.slug);
        continue;
      }

      // Heavy clips compete for the bounded heavy pool.
      heavyCandidates.push({
        slug: block.slug,
        inViewport: viewportVisiblePx > 0,
        viewportVisibleFraction: Math.max(viewportVisiblePx, 0) / safeSurfaceHeight,
        windowVisibleFraction,
        centerDistance: Math.abs(
          surfaceTop + playbackSurface.heightPx / 2 - viewportCenter,
        ),
        top: surfaceTop,
      });
    }

    for (const slug of selectActiveHeavyPlaybackSlugs(
      heavyCandidates,
      activeHeavyPlaybackRef.current,
    )) {
      active.add(slug);
    }

    return active;
  }, [
    autoplayEligibleBySlug,
    blocks,
    renderReadyBlockIds,
    scrollTop,
    viewportHeight,
    visibleItems,
  ]);

  // Remember which heavy clips are currently active so the next arbitration
  // applies hysteresis against the committed set, not a fresh computation.
  useEffect(() => {
    const heavy = new Set<string>();
    for (const slug of activePlaybackSlugs) {
      if (autoplayEligibleBySlug.get(slug)?.profile === "heavy") {
        heavy.add(slug);
      }
    }
    activeHeavyPlaybackRef.current = heavy;
  }, [activePlaybackSlugs, autoplayEligibleBySlug]);

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

  const openMergeDialog = useCallback(() => {
    if (selectedSlugs.size < 2) return;
    setMergeDialogOpen(true);
  }, [selectedSlugs.size]);

  const handleConfirmMerge = useCallback(
    async (orderedSlugs: string[]) => {
      await onMergeSelectedBlocks(orderedSlugs);
      clearSelection();
    },
    [clearSelection, onMergeSelectedBlocks],
  );

  const keyboardFocusedSlug = feedInteractionMode === "keyboard" ? focusedSlug : null;
  const visualFocusActive = keyboardFocusedSlug !== null || pinnedActionMenuSlug !== null;

  const gridContext: GridContext = useMemo(
    () => ({
      vaultPath,
      thumbsRootPath: resolvedThumbsRootPath,
      gridTopInset,
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
      onMergeSelectedBlocks: openMergeDialog,
      onRequestRename,
      onRequestDelete: handleRequestDelete,
    }),
    [
      vaultPath,
      resolvedThumbsRootPath,
      gridTopInset,
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
      openMergeDialog,
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
            paddingLeft: gridXInset,
            paddingRight: gridXInset,
            scrollbarGutter: "stable",
            transition: "padding-left 200ms ease, padding-right 200ms ease",
          }}
          data-grid-scroll
          data-feed-grid-interaction-mode={feedInteractionMode}
          data-feed-grid-focus-mode={visualFocusActive ? "true" : undefined}
        >
          {parentWidth > 0 && blocks.length > 0 && (
            <VirtualMasonryLayout
              blocks={blocks}
              visibleItems={visibleItems}
              totalHeight={layout.totalHeight}
              priorityBounds={priorityBounds}
              liveBlockIds={renderReadyBlockIds}
              activePlaybackSlugs={activePlaybackSlugs}
              thumbVersions={thumbVersions}
              marqueeRect={marqueeRect}
              context={gridContext}
            />
          )}
          {parentWidth > 0 && showEmptyChannelPlaceholder && (
            <EmptyChannelPlaceholder viewportHeight={viewportHeight} />
          )}
          {parentWidth > 0 && heightDriftAuditBatch.length > 0 && (
            <MeasurementPass
              blocks={heightDriftAuditBatch}
              columnWidth={deriveColumnWidth(parentWidth, layoutGap)}
              vaultPath={vaultPath}
              thumbsRootPath={resolvedThumbsRootPath}
              onMeasured={publishHeightDriftReport}
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
          onMergeSelectedBlocks={openMergeDialog}
          onClearSelection={clearSelection}
        />
      )}

      <MergeCardsDialog
        open={mergeDialogOpen}
        selectedBlocks={selectedBlocks}
        thumbsRootPath={resolvedThumbsRootPath}
        onOpenChange={setMergeDialogOpen}
        onConfirm={handleConfirmMerge}
      />

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
  liveBlockIds,
  activePlaybackSlugs,
  thumbVersions,
  marqueeRect,
  context,
}: {
  blocks: LightBlock[];
  visibleItems: MasonryPosition[];
  totalHeight: number;
  priorityBounds: { start: number; end: number };
  liveBlockIds: ReadonlySet<number>;
  activePlaybackSlugs: Set<string>;
  thumbVersions?: ReadonlyMap<string, number>;
  marqueeRect: LayoutRect | null;
  context: GridContext;
}) {
  return (
    <div
      className="relative"
      style={{ height: totalHeight || 1, marginTop: context.gridTopInset }}
      data-grid-layout
    >
      {visibleItems.map((item) => {
        const block = blocks[item.index];
        if (!block) return null;
        const isLive = liveBlockIds.has(block.id);
        return (
          <GridItem
            key={block.id}
            block={block}
            item={item}
            priority={
              item.top <= priorityBounds.end && item.bottom >= priorityBounds.start
            }
            isCommitted={isLive}
            allowPlayback={activePlaybackSlugs.has(block.slug)}
            thumbVersion={thumbVersions?.get(block.slug) ?? 0}
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
  thumbVersion,
  isFocused,
  isSelected,
  context,
}: {
  block: LightBlock;
  item: MasonryPosition;
  priority: boolean;
  isCommitted: boolean;
  allowPlayback: boolean;
  thumbVersion: number;
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

  // Stabilize the reference-identity props handed to the memoized Card. A fresh
  // dragBlocks array or a fresh inline callback on every GridItem render defeats
  // Card's memo, so any re-render of GridItem (focus change, gridContext
  // identity churn) would needlessly re-render the whole Card subtree. These
  // deps are all stable during a pure scroll, so scrolling never re-renders Card.
  const dragBlocks = useMemo(
    () =>
      isSelected
        ? [
            block,
            ...context.selectedBlocks.filter((other) => other.slug !== block.slug),
          ]
        : [block],
    [block, isSelected, context.selectedBlocks],
  );
  const clearSelectionOnDragStart =
    !isSelected && context.selectedSlugs.size > 0
      ? context.onClearSelection
      : undefined;
  const handleKeyboardMoreMenuOpenChange = useCallback(
    (open: boolean) => {
      context.onKeyboardActionMenuOpenChange(block.slug, open);
    },
    [context.onKeyboardActionMenuOpenChange, block.slug],
  );

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
      data-feed-grid-item-index={item.index}
      data-feed-grid-item-top={item.top}
      data-feed-grid-item-bottom={item.bottom}
      data-feed-grid-item-live={isCommitted ? "true" : "false"}
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
            thumbVersion={thumbVersion}
            priority={priority}
            allowPlayback={allowPlayback}
            openMoreMenuRequestSequence={openMoreMenuRequestSequence}
            hoverEnabled={context.hoverEnabled && !isPinnedActionMenuAnchor}
            dragBlocks={dragBlocks}
            clearSelectionOnDragStart={clearSelectionOnDragStart}
            onKeyboardMoreMenuOpenChange={handleKeyboardMoreMenuOpenChange}
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
            onMergeSelectedBlocks={context.onMergeSelectedBlocks}
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
// Measurement waits for fonts only. It must not wait for images: feed card
// media slots reserve deterministic aspect-ratio boxes and hidden image loads
// can take seconds or fail. Waiting for image load would turn layout readiness
// into media readiness and recreate the fast-scroll blank-viewport problem.

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

      // 2. Force a synchronous layout read. By now fonts are loaded and media
      //    boxes have deterministic aspect-ratio envelopes, so the heights we
      //    read here match what the real visible Cards will render.
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
