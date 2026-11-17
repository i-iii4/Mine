import { reportCardsRendered, scheduleAfterNextPaint } from "@/lib/startup";
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
import type {
  DeleteBlocksPlan,
  LightBlock,
  ScrollAnchor as TabScrollAnchor,
  TabLocation,
  TagCount,
} from "@/types";
import { placeKey } from "@/lib/tabPage";
import { onPointerOffMenus } from "@/lib/openMenus";
import { useTabVisible } from "@/lib/tabVisibility";
import { useDensity } from "@/lib/density";
import { CardColumnWidthContext, FeedShowContext, useFeedDisplay, type FeedShow } from "@/lib/feedDisplay";
import { Card, CardSkeleton } from "./Card";
import { EmptySpaceOnboarding } from "./EmptySpaceOnboarding";
import { MeasureCard } from "./MeasureCard";
import { CardPointMenuHost, type CardPointMenuHandle } from "./CardHoverMenu";
import { createPortal } from "react-dom";
import { GroupSelectionCommands } from "./GroupSelectionCommands";
import type { MembershipAnswer } from "./CollectionPicker";
import { GroupSelectionCardMenu } from "./GroupSelectionCardMenu";
import { GroupSelectionPointMenuHost, type GroupSelectionPointMenuHandle } from "./GroupSelectionContextMenu";
import {
  DeleteSelectionWindow,
  type DeleteSelectionAction,
  type DeleteSelectionRequest,
} from "./DeleteSelectedCardsDialog";
import { roleEasing, roleMs } from "@/lib/motion";
import { MergeCardsDialog } from "./MergeCardsDialog";
import {
  createVisibilityIndex,
  getMasonryColumnCount,
  getMasonryColumnWidth,
  getVisibleItemsFromIndex,
  type MasonryPosition,
  type MasonryLayout,
} from "@/lib/masonryLayout";
import { FEED_COLUMN_MIN_WIDTH_PX, computeCardHeight } from "@/lib/cardHeight";
import { computeFeedPlaybackSurfaceEnvelope } from "@/lib/cardHeight";
import { LayoutCache } from "@/lib/layoutCache";
import { fetchWordWidths, measureTopFirst } from "@/lib/fontMetrics";
import { useGridScroll } from "@/hooks/useGridScroll";
import type { FeedKeyboardFocus } from "@/hooks/useSidebarKeyboardFocus";
import type { WordWidths } from "@/types/fontMetrics";
import {
  buildFeedSignature,
  buildLayoutGenerationKey,
  type FeedSignature,
  type LayoutGenerationKey,
} from "@/lib/layoutGeneration";
import { normalizeFeedPlayback } from "@/lib/feedPlayback";
import { fallbackThumbsRoot } from "@/lib/assets";
import {
  computeFeedScrollReadinessWindows,
  sampleFeedScrollSignal,
  shouldPrefetchNextFeedPage,
  type FeedScrollDirection,
  type FeedScrollSignal,
  type FeedScrollSignalSample,
} from "@/lib/feedScrollReadiness";
import {
  collectViewportFirstMeasurementBatch,
  computeCommittedEndIndex,
  createGridLayoutReadinessDiagnostics,
  blockHasExactDeterministicHeight,
  type GridLayoutReadinessDiagnostics,
} from "@/lib/gridLayoutReadiness";
import {
  createGridViewportPaintDiagnostics,
  type GridViewportPaintDiagnostics,
} from "@/lib/gridViewportDiagnostics";
import {
  createCardHeightDriftReport,
  type CardHeightDriftObservation,
  type CardHeightDriftReport,
} from "@/lib/cardHeightDrift";
import {
  isDialogKeyboardTarget,
  isEditableKeyboardTarget,
  isOverlayKeyboardTarget,
} from "@/lib/keyboardTargets";
import { commandById } from "@/lib/commandRegistry";
import { setHoveredCard, setSelectedCards, useCardLitByCollection } from "@/lib/collectionHover";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { HoverIntentDragWatch, useHoverIntent } from "@/hooks/useHoverIntent";
import { createCardLiftStore, useCardRaised, type CardLiftStore } from "@/lib/cardLift";
import { CardCollectionsContext, type CardCollectionsNavigation } from "@/lib/cardCollections";
import {
  blockCanRenderFromDeterministicHeight,
  blockSlugFromKeyboardTarget,
  clampedScrollTopForAnchor,
  feedPointerPosition,
  findLayoutNeighborSlug,
  findMarqueeSelectionSlugs,
  findFirstCardAtOrBelowTop,
  findPositionForSlug,
  findViewportPreservationAnchor,
  firstVisibleSlug,
  horizontalStepBackSlug,
  type HorizontalStep,
  isEmptyGridPointerTarget,
  isGridArrowKey,
  isLiveSlug,
  isPassiveGridKeyboardTarget,
  isPositionVisibleInViewport,
  isSameFeedPointerPosition,
  isStationaryFeedPointerMove,
  layoutPointFromClientPoint,
  layoutPointFromPointerEvent,
  marqueeAutoScrollVelocity,
  marqueeIsActive,
  rectFromPoints,
  scrollPositionIntoView,
  type FeedInteractionMode,
  type FeedPointerPosition,
  type LayoutRect,
  type MarqueeSelection,
  type PendingScrollAnchor,
  type ScrollAnchorSnapshot,
} from "./grid/interaction";
import {
  columnsKept,
  everyHeightIsExact,
  layFeedOut,
  rememberedColumns,
  rememberedPositionAt,
  type ColumnMemory,
} from "./grid/feedLayout";
import { indexFeed, type FeedIndex } from "./grid/feedIndex";
import {
  createWordMetricsLedger,
  planWordMetrics,
  recordWordMetrics,
  type WordMetricsLedger,
} from "./grid/wordMetrics";

/// The feed's scroll diagnostics for developers and the browser audits
/// (SPEC_FEED_SCROLL_PERFORMANCE.md, «Diagnostics»): never shown in the app.
interface FeedScrollDebug {
  layoutGenerationKey: string;
  scrollDirection: FeedScrollDirection;
  scrollVelocityPxMs: number;
  isFastScrolling: boolean;
  mountedGridItems: number;
  renderWindowPx: { forward: number; backward: number };
  priorityWindowPx: { forward: number; backward: number };
  layout?: GridLayoutReadinessDiagnostics;
  viewport?: GridViewportPaintDiagnostics;
  heightDrift?: CardHeightDriftReport;
}

declare global {
  interface Window {
    __MINE_REQUEST_HEIGHT_DRIFT_AUDIT__?: () => void;
    __MINE_FEED_SCROLL_DEBUG__?: FeedScrollDebug;
  }
}

/// A window's two sides named by the direction of travel.
function windowByDirection(
  direction: FeedScrollDirection,
  beforePx: number,
  afterPx: number,
): { forward: number; backward: number } {
  return direction === "backward"
    ? { forward: beforePx, backward: afterPx }
    : { forward: afterPx, backward: beforePx };
}

// ─── Layout constants ───────────────────────────────────────────────────────

// One number with the card's narrow text (SPEC_NARROW_WINDOW.md, У14).
const COLUMN_MIN_WIDTH = FEED_COLUMN_MIN_WIDTH_PX;
const EMPTY_WORD_WIDTHS: ReadonlyMap<number, WordWidths> = new Map();
const NO_SELECTED_BLOCKS: LightBlock[] = [];
const NO_BLOCK_IDS: ReadonlySet<number> = new Set();
// Card gap and container insets both follow the app-wide spacing setting; they
// used to be design-variant constants baked into the alt design. See
// src/lib/density.ts.
const MEASUREMENT_BATCH_SIZE = 24;
const INITIAL_COMMIT_BLOCKS = 48;
const EMERGENCY_RENDER_OVERSCAN_PX = 128;
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
// At (or within a sub-pixel of) the very top of the feed the viewport must keep
// showing the newest content: a prepend (new clip via clipper/import → watcher
// refresh; feed is saved_at DESC) or any batch insert at the head should reveal
// the new cards, not anchor the old first card and push the fresh rows above the
// viewport. Above this threshold the anchor behaves normally.
const TOP_OF_FEED_SCROLL_EPSILON_PX = 0.5;
const EMPTY_CHANNEL_PLACEHOLDER_TEXT =
  "Elements connected to this collection will appear here.";
const EMPTY_FEED_PLACEHOLDER_TEXT = "Elements you save will appear here.";
const INITIAL_FEED_SCROLL_SIGNAL: FeedScrollSignal = {
  scrollTop: 0,
  scrollDirection: "idle",
  scrollVelocityPxMs: 0,
  isFastScrolling: false,
};

function EmptyChannelPlaceholder({
  viewportHeight,
  text = EMPTY_CHANNEL_PLACEHOLDER_TEXT,
}: {
  viewportHeight: number;
  text?: string;
}) {
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
        {text}
      </p>
    </div>
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface GridProps {
  blocks: LightBlock[];
  /// Reports whether a card currently holds keyboard focus, and how to open
  /// it, so the bottom bar can offer Focus only when there is something to
  /// open — and act on it when pressed.
  onKeyboardFocusChange?: (activate: (() => void) | null) => void;
  onCardMenuShortcutChange?: (activate: (() => void) | null) => void;
  onSelectionCommandChange?: (clear: (() => void) | null) => void;
  /// ArrowLeft at the feed's left edge (SPEC_KEYBOARD.md, М1). True when the
  /// sidebar took the keyboard's focus; the feed then holds none.
  onKeyboardFocusLeave?: () => boolean;
  /// Reports how the feed takes the focus back from the sidebar (М4).
  onKeyboardFocusReturnChange?: (feed: FeedKeyboardFocus | null) => void;
  selectionCommandsHost?: HTMLElement | null;
  vaultPath: string;
  thumbsRootPath?: string;
  /// Start the clipper setup flow from the empty-space onboarding.
  onInstallClipper?: () => void | Promise<void>;
  /// Whether the space never had a card (О14): its empty feed introduces the
  /// clipper. `false` once it had one: an emptied feed says so plainly and
  /// the introduction never returns (О15). `null` while unknown.
  spaceOnboardingOwed?: boolean | null;
  /// The first index in flight: numbers shown instead of the empty-space
  /// onboarding, because "this space is empty" is a falsehood about a space
  /// that is still being read. See SPEC_ONBOARDING.md О13.
  firstIndexProgress?: { processed: number; total: number } | null;
  /// An index pass is running, or it is over and the feed on screen was read
  /// before it. Its progress arrives by event, possibly after the first paint,
  /// so an empty feed is final only once the feed is read after the pass:
  /// until then it may be a space that is still being read. Neither the
  /// first-cards mark nor the empty-space onboarding takes it as final
  /// (SPEC_AUDIT_FIXES.md, Б5.4, В5.6).
  vaultIndexing?: boolean;
  /// Open the Are.na import from the empty-space onboarding.
  /**
   * Per-slug thumbnail cache-buster. Bumped by App on a `thumb:updated` event
   * so the affected card re-renders and refetches its regenerated
   * poster/thumbnail without a full grid reload. Slugs absent from the map are
   * version 0 (unversioned URLs).
   */
  thumbVersions?: ReadonlyMap<string, number>;
  tags: TagCount[];
  currentTag?: string;
  /** The place the feed shows; without it, the collection `currentTag` or
   *  Everything. An author's feed is no collection and no Everything: an
   *  empty one shows the empty collection's line, never the onboarding
   *  (SPEC_CARD_ASSOCIATIONS.md, «Лента автора»). */
  location?: TabLocation;
  /** Opens a collection, as its sidebar row does; a card's collection pill
   *  calls it (SPEC_CARD_STATES.md, С9). */
  onNavigateCollection?: (collectionRef?: string) => void;
  routeSnapshotReady?: boolean;
  scrollToTop: number;
  blockDragActive?: boolean;
  detailOpen?: boolean;
  keyboardNavigationDisabled?: boolean;
  restoreFocusSlug?: string | null;
  restoreFocusSequence?: number;
  onBlockClick: (block: LightBlock) => void;
  /// ⇧⌘-click opens the card in a new window (SPEC_TABS.md, В82). Absent on a
  /// page that is not a tab. ⌘-click selects on every page, as ⇧-click does.
  onOpenBlockElsewhere?: (block: LightBlock, newWindow: boolean) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => MembershipAnswer;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<unknown>;
  /// The group delete window's plan, read from the index alone
  /// (SPEC_GROUP_SELECTION.md, «Batch Delete», «План»).
  onPrepareDeleteSelectedBlocks: (slugs: string[]) => Promise<DeleteBlocksPlan>;
  /// Deletes the selection in one batch; rejects when nothing was deleted.
  onDeleteSelectedBlocks: DeleteSelectionAction;
  onMergeSelectedBlocks: (orderedSlugs: string[]) => void | Promise<void>;
  onGroupSelectionStart?: () => void;
  /// A card's action menu opened or closed. The feed above needs this to keep
  /// the card in place while its menu is open, even after an edit drops it out
  /// of the current collection.
  onCardMenuOpenChange?: (slug: string, open: boolean) => void;
  onRequestRename: (block: LightBlock) => void;
  onRequestDelete: (slug: string) => void;
  onColumnCountChange?: (count: number) => void;
  heightDriftAuditMode?: boolean;
  hasMoreBlocks?: boolean;
  loadingMoreBlocks?: boolean;
  onLoadMoreBlocks?: () => void;
  /**
   * The feed scrolled or reflowed. `read` tells where it stands now: the
   * first card whose top edge is at or below the feed's top edge and that
   * distance, or null at the very top. Read on demand, so a scroll costs the
   * caller nothing until it reports (SPEC_TABS.md, В31).
   */
  onScrollPositionChange?: (read: () => TabScrollAnchor | null) => void;
  /**
   * Where a restored tab stood (В40): once that card and every card above it
   * have their height, the feed scrolls so the card's top sits `offset_px`
   * below the feed's top, once per request. The caller hands it over only
   * when the card is in `blocks`.
   */
  restoreScrollAnchor?: TabScrollAnchor | null;
  onScrollAnchorRestored?: () => void;
  /**
   * Whether the card under the pointer marks its collections in the sidebar
   * (SPEC_CARD_STATES.md, С4). The keyboard-focused card always does.
   */
}

interface GridContext {
  vaultPath: string;
  thumbsRootPath?: string;
  /** Design-variant top inset between the chrome and the first card row. */
  gridTopInset: number;
  focusedSlug: string | null;
  pinnedActionMenuSlug: string | null;
  /** The card a right click's menu holds in its hover look (С7.8). */
  menuHeldSlug: string | null;
  selectedSlugs: ReadonlySet<string>;
  selectedBlocks: readonly LightBlock[];
  actionMenuRequest: { slug: string; sequence: number } | null;
  selectionBatchMenuRequest: { slug: string; sequence: number } | null;
  hoverEnabled: boolean;
  /** The card the pointer has arrived on, for its lift (SPEC_CARD_STATES.md, С8.6). */
  cardLift: CardLiftStore;
  onGridItemPointerMove: (slug: string, event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyboardActionMenuOpenChange: (slug: string, open: boolean) => void;
  onCardMenuOpenChange?: (slug: string, open: boolean) => void;
  onClearSelection: () => void;
  onModifiedCardClick: (block: LightBlock, event: ReactMouseEvent<HTMLDivElement>) => boolean;
  onBlockClick: (block: LightBlock) => void;
  tags: TagCount[];
  currentTag?: string;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => MembershipAnswer;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<unknown>;
  /** `requestDeleteSelection()` of the feed: the ⌘K menu's `Delete`. */
  onRequestDeleteSelection: () => void;
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

/** The feed's side insets follow a new Spacing as Перемещение (Л5;
 *  SPEC_MOTION_LEVELS.md, РД1): the role's tokens, Off at once by them. */
const FEED_INSET_TRANSITION =
  "padding-left var(--motion-move) var(--motion-move-ease), padding-right var(--motion-move) var(--motion-move-ease)";
/** At most this many cards move smoothly at once; past it they jump. */
const CARD_MOVE_LIMIT = 120;

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
  onKeyboardFocusChange,
  onCardMenuShortcutChange,
  onKeyboardFocusLeave,
  onKeyboardFocusReturnChange,
  onSelectionCommandChange,
  selectionCommandsHost,
  vaultPath,
  thumbsRootPath,
  onInstallClipper,
  spaceOnboardingOwed = true,
  firstIndexProgress = null,
  vaultIndexing = false,
  thumbVersions,
  tags,
  currentTag,
  location,
  onNavigateCollection,
  routeSnapshotReady = true,
  scrollToTop,
  blockDragActive = false,
  detailOpen = false,
  keyboardNavigationDisabled = false,
  restoreFocusSlug = null,
  restoreFocusSequence = 0,
  onBlockClick,
  onOpenBlockElsewhere,
  onToggleTag,
  onCreateAndAssign,
  onLoadBlockTags,
  onBatchSetTag,
  onCreateAndAssignBatch,
  onPrepareDeleteSelectedBlocks,
  onDeleteSelectedBlocks,
  onMergeSelectedBlocks,
  onGroupSelectionStart,
  onCardMenuOpenChange,
  onRequestRename,
  onRequestDelete,
  onColumnCountChange,
  heightDriftAuditMode = false,
  hasMoreBlocks = false,
  loadingMoreBlocks = false,
  onLoadMoreBlocks,
  onScrollPositionChange,
  restoreScrollAnchor = null,
  onScrollAnchorRestored,
}: GridProps) {
  // The place this feed shows: the key of its layout, scroll and selection
  // memory, and whether it is Everything (the only place with onboarding).
  const routeKey = location ? placeKey(location) : (currentTag ?? "__all__");
  const onEverything = location ? location.kind === "everything" : !currentTag;
  // A hidden tab plays nothing; shown again, the feed's own rules decide
  // what plays (SPEC_TABS.md, В41).
  const tabVisible = useTabVisible();
  const spacing = useDensity();
  const layoutGap = spacing;
  // Presentation of the cards (SPEC_FEED_DISPLAY.md, Д10 to Д16): read by the
  // layout, the heights and every card below.
  const { show } = useFeedDisplay();
  const gridXInset = spacing;
  const gridTopInset = spacing;
  const parentRef = useRef<HTMLDivElement>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [feedScrollSignal, setFeedScrollSignal] = useState<FeedScrollSignal>(
    INITIAL_FEED_SCROLL_SIGNAL,
  );
  /// The menus a right click opens, a card's and the selection's: each is a
  /// permanent owner opened through its handle in the click's own handler,
  /// in the menu panel or on the page, the menu's corner on the point either
  /// way (SPEC_MENU_WINDOW.md, МО10, МО19, МО41, МО68; А2, Б1). Which of the
  /// two opens is decided when the menu is summoned: that is the only moment
  /// the clicked card and the selection are both known.
  const cardPointMenuRef = useRef<CardPointMenuHandle<LightBlock>>(null);
  const selectionPointMenuRef = useRef<GroupSelectionPointMenuHandle>(null);
  /// The group delete window: the request it answers, and whether it is open.
  /// A closed window keeps its request while it leaves.
  const [deleteSelection, setDeleteSelection] = useState<{
    request: DeleteSelectionRequest;
    open: boolean;
  } | null>(null);
  const deleteSelectionSequenceRef = useRef(0);
  const [focusedSlug, setFocusedSlug] = useState<string | null>(null);

  const [selectedSlugs, setSelectedSlugs] = useState<Set<string>>(() => new Set());
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection | null>(null);
  // Last pointer position of the held marquee drag, in client coordinates. The
  // autoscroll loop needs it every frame while the pointer itself stays still.
  const marqueePointerClientRef = useRef<{ x: number; y: number } | null>(null);
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
  // The card a right click opened a menu on keeps the look the pointer's
  // hover gives it, though the context menu holds every hover answer: while
  // the menu is up, and after it closed until the pointer shows itself off
  // the card (SPEC_CARD_STATES.md, С7.8; user's decision of 16.11.2026).
  const [menuHeldSlug, setMenuHeldSlug] = useState<string | null>(null);
  const [cardPointMenuOpen, setCardPointMenuOpen] = useState(false);
  const [selectionPointMenuOpen, setSelectionPointMenuOpen] = useState(false);
  const pointMenuOpen = cardPointMenuOpen || selectionPointMenuOpen;
  useEffect(() => {
    if (menuHeldSlug === null || pointMenuOpen) return;
    return onPointerOffMenus((event) => {
      const under = event.target instanceof Element ? event.target.closest("[data-block-slug]") : null;
      if (under?.getAttribute("data-block-slug") !== menuHeldSlug) setMenuHeldSlug(null);
    });
  }, [menuHeldSlug, pointMenuOpen]);
  const lastRestoreFocusSequenceRef = useRef(0);
  const lastPointerPositionRef = useRef<FeedPointerPosition | null>(null);
  const blockedPointerPositionRef = useRef<FeedPointerPosition | null>(null);
  // The card the focus left for the sidebar, until the collection changes (М4).
  const sidebarReturnSlugRef = useRef<string | null>(null);
  const horizontalStepRef = useRef<HorizontalStep | null>(null);
  // Which card the pointer attends to reaches the sidebar through the
  // hover-intent engine, which ignores a pointer passing through, a scroll and
  // cards sliding under a still pointer (SPEC_CARD_STATES.md, С4, С7). Under
  // the arrow keys the sidebar hears about the focused card instead, at once.
  const pointerDrivesCardHoverRef = useRef(true);
  const keyboardAnswerTimerRef = useRef<number | null>(null);
  const clearKeyboardAnswerTimer = useCallback(() => {
    if (keyboardAnswerTimerRef.current !== null) window.clearTimeout(keyboardAnswerTimerRef.current);
    keyboardAnswerTimerRef.current = null;
  }, []);
  const [cardLift] = useState(createCardLiftStore);
  const cardIntent = useHoverIntent(({ raised }) => {
    cardLift.set(raised);
    if (!pointerDrivesCardHoverRef.current) return;
    clearKeyboardAnswerTimer();
    // The pointer marks no collections in the sidebar: only the keyboard's
    // focused card and a selection do (SPEC_CARD_STATES.md, С4).
    setHoveredCard(null);
  });
  const cardIntentRef = useRef(cardIntent);
  cardIntentRef.current = cardIntent;
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
  // Which measured text each entry of the map was computed for, and which
  // cards still wait for theirs (src/components/grid/wordMetrics.ts). Lets the
  // metrics effect ask only for genuinely new or edited blocks, and look only
  // at the cards that are new objects.
  const wordMetricsLedgerRef = useRef<WordMetricsLedger | null>(null);

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

  // Scroll to top on explicit signal or channel change. A feed just mounted
  // already stands at its top, so mounting is neither: only a signal or a
  // place that changed since moves it, and nothing at mount can undo a return
  // to a remembered card (SPEC_GRAPH_VIEW.md, «Возврат из графа»).
  const scrollToTopSeenRef = useRef({ scrollToTop, routeKey });
  useEffect(() => {
    const seen = scrollToTopSeenRef.current;
    if (seen.scrollToTop === scrollToTop && seen.routeKey === routeKey) return;
    scrollToTopSeenRef.current = { scrollToTop, routeKey };
    parentRef.current?.scrollTo(0, 0);
  }, [scrollToTop, routeKey]);

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
      // Cards slide under the pointer: nothing answers until they settle (С7.5).
      cardIntentRef.current.displace();
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
    const ledger = (wordMetricsLedgerRef.current ??= createWordMetricsLedger());
    const plan = planWordMetrics(ledger, blocks);

    // Drop the widths that no longer apply, before the early return so a
    // removal-only change still frees the entries: the card left the feed
    // (channel switch, pagination reset) or was edited in place. Dropping the
    // stale entry makes the edited block fall back to the skeleton until its
    // recomputed widths arrive instead of being laid out at its pre-edit
    // height, and bounds the map to the live block set across a long session.
    if (plan.dropped.length > 0) {
      setWordWidthsMap((prev) => {
        let next: Map<number, WordWidths> | null = null;
        for (const id of plan.dropped) {
          if (!prev.has(id)) continue;
          next ??= new Map(prev);
          next.delete(id);
        }
        return next ?? prev;
      });
    }

    if (plan.needsCompute.length === 0) {
      setWordMetricsSettled(true);
      return () => {
        cancelled = true;
      };
    }

    // New or edited blocks have no exact height yet; hold them in the skeleton
    // state until their widths arrive rather than flashing a fallback height.
    setWordMetricsSettled(false);
    const publish = (computed: Map<number, WordWidths>) => {
      if (cancelled || computed.size === 0) return;
      recordWordMetrics(ledger, plan, computed.keys());
      setWordWidthsMap((prev) => {
        const next = new Map(prev);
        for (const [id, widths] of computed) {
          next.set(id, widths);
        }
        return next;
      });
    };
    void measureTopFirst(plan.needsCompute, fetchWordWidths, publish, () => cancelled)
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
  // The cards' signatures folded in order, continued from the list before:
  // a page added to the end hashes its own cards alone, and a new width
  // hashes none (SPEC_GRID.md, «Кэш при карточке и продолжение раскладки»).
  const feedSignatureRef = useRef<FeedSignature | null>(null);
  const feedSignature = useMemo(
    () => buildFeedSignature(blocks, feedSignatureRef.current),
    [blocks],
  );
  feedSignatureRef.current = feedSignature;
  const generationKey = useMemo<LayoutGenerationKey>(
    () => buildLayoutGenerationKey({
      blocks,
      signature: feedSignature,
      routeKey,
      columnWidth,
      columnCount,
      // The module-level layoutCache must never serve a layout computed with
      // a different gap (design variants change it) or presentation.
      layoutGap,
      show,
    }),
    [blocks, columnCount, columnWidth, feedSignature, routeKey, layoutGap, show],
  );
  const heightDriftContextRef = useRef<{
    blocks: readonly LightBlock[];
    generationKey: LayoutGenerationKey;
    parentWidth: number;
    wordWidthsMap: Map<number, WordWidths>;
    show: FeedShow;
  }>({
    blocks,
    generationKey,
    parentWidth,
    wordWidthsMap,
    show,
  });
  heightDriftContextRef.current = {
    blocks,
    generationKey,
    parentWidth,
    wordWidthsMap,
    show,
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
    () => thumbsRootPath ?? fallbackThumbsRoot(vaultPath),
    [thumbsRootPath, vaultPath],
  );

  // Exactness is stricter than "settled": after the metrics promise resolves,
  // every block becomes render-ready (fallback heights keep the feed usable),
  // but a generation is only cacheable when no block sits on the worst-clamped
  // text fallback — otherwise the oversized fallback layout gets pinned in the
  // module-level cache and survives the later arrival of exact word widths.
  const allBlocksHaveExactHeights = useMemo(
    () => everyHeightIsExact(blocks, wordWidthsMap, show),
    [blocks, show, wordWidthsMap],
  );

  // The feed's cards by id and by slug, grown out of the index of the list
  // before (src/components/grid/feedIndex.ts).
  const feedIndexRef = useRef<FeedIndex | null>(null);
  const feedIndex = useMemo(() => indexFeed(blocks, feedIndexRef.current), [blocks]);
  feedIndexRef.current = feedIndex;
  // Every card of the feed. While all of them can render it is the set of
  // the render-ready ones itself, the same object whatever else changes.
  const allBlockIds = feedIndex.ids;
  const blocksBySlug = feedIndex.bySlug;
  const blocksBySlugRef = useRef(blocksBySlug);
  blocksBySlugRef.current = blocksBySlug;
  const renderReadyBlockIds = useMemo(() => {
    if (parentWidth <= 0) return NO_BLOCK_IDS;
    if (wordMetricsSettled || allBlocksHaveExactHeights) return allBlockIds;
    const ids = new Set<number>();
    for (const block of blocks) {
      if (blockCanRenderFromDeterministicHeight(block, wordWidthsMap, wordMetricsSettled, show)) {
        ids.add(block.id);
      }
    }
    return ids;
  }, [allBlockIds, allBlocksHaveExactHeights, blocks, parentWidth, show, wordMetricsSettled, wordWidthsMap]);

  const committedEndIndex = useMemo(
    () => (parentWidth > 0 && renderReadyBlockIds === allBlockIds
      ? blocks.length - 1
      : computeCommittedEndIndex(blocks, renderReadyBlockIds, parentWidth > 0)),
    [allBlockIds, blocks, parentWidth, renderReadyBlockIds],
  );

  // The first real cards on screen: the startup milestone waits for them,
  // not for the skeletons painted while word widths are measured. An empty
  // feed is the final picture only once no index pass can still fill it: a
  // new space or a reset cache shows an empty snapshot, then the first index
  // (SPEC_AUDIT_FIXES.md, Б5.4).
  const hasRenderedCards = committedEndIndex >= 0
    || (routeSnapshotReady && blocks.length === 0 && !vaultIndexing);
  useEffect(() => {
    if (!hasRenderedCards || typeof window === "undefined") return;
    return scheduleAfterNextPaint(reportCardsRendered);
  }, [hasRenderedCards]);

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
          const blocksById = new Map(driftContext.blocks.map((block) => [block.id, block]));
          for (const result of measuredResults) {
            const block = blocksById.get(result.id);
            if (!block) continue;
            const wordWidths = driftContext.wordWidthsMap.get(result.id) ?? null;
            const wordMetricsRequired = !blockHasExactDeterministicHeight(block, EMPTY_WORD_WIDTHS, driftContext.show);
            observations.push({
              block,
              measuredHeight: result.height,
              deterministicHeight: Math.ceil(
                computeCardHeight(block, columnWidth, wordWidths, driftContext.show),
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

  // The columns of the layout on screen: a card keeps its column while the
  // view is the same, so a height change moves only its own column (К1).
  const columnMemoryRef = useRef<ColumnMemory | null>(null);
  const columns = useMemo(
    () => rememberedColumns(columnMemoryRef.current, blocks, routeKey, parentWidth, show),
    [blocks, parentWidth, routeKey, show],
  );
  // The layout made last: a card that comes out where it stands in it keeps
  // its position object, so it is not drawn again.
  const lastLayoutRef = useRef<MasonryLayout | null>(null);
  // The visible layout always belongs to the current generation. Production
  // heights come from deterministic card geometry only; measured DOM heights
  // are never fed back into layout because that feedback loop is what caused
  // scroll jumps and blank/skeleton windows during fast scroll.
  const layout = useMemo((): MasonryLayout => {
    // Nothing to place, or no width yet (before the first measure): no
    // positions, and the column geometry the rule gives this width, so the
    // reported count is never below the two-column minimum.
    if (parentWidth <= 0 || blocks.length === 0) {
      return {
        columnCount,
        columnWidth,
        totalHeight: 0,
        positions: [],
      };
    }

    const layFeed = () => layFeedOut({
      blocks,
      parentWidth,
      layoutGap,
      show,
      wordWidths: wordWidthsMap,
      columns,
      last: lastLayoutRef.current,
    });
    if (!allCurrentGenerationDeterministic) {
      return layFeed();
    }

    const cached = layoutCache.get(generationKey);
    if (cached) return cached;

    const fresh = layFeed();
    layoutCache.set(generationKey, fresh);
    return fresh;
  }, [allCurrentGenerationDeterministic, blocks, columnCount, columns, columnWidth, generationKey, layoutGap, parentWidth, show, wordWidthsMap]);
  lastLayoutRef.current = layout;
  // A layout of the same view moves the mounted cards that shifted over
  // 200ms, each from where it stood; a new view stands at once (К3). Only
  // those cards are touched: switching a transition on for the whole feed
  // made every change restyle every card, and cost the scroll its frames.
  const layoutMovesSmoothly = columns !== null;
  useLayoutEffect(() => {
    const previous = columnMemoryRef.current;
    const scrollElement = parentRef.current;
    // A card moves to its new place as Перемещение (К3, Л4), by the level
    // whoever changed the data, a key included: the same move comes of an
    // outside edit, which has no key (УД4, п. 6).
    const moveMs = roleMs("move", "enter");
    // The same array of positions: no card moved.
    if (
      previous !== null
      && layoutMovesSmoothly
      && scrollElement !== null
      && moveMs > 0
      && previous.layout.positions !== layout.positions
    ) {
      const moveEasing = roleEasing("move");
      // Only a card on the page can move before the eyes: the shown cards,
      // in the feed's order.
      const shown = [...scrollElement.querySelectorAll<HTMLElement>("[data-feed-grid-item-slug]")]
        .map((element) => ({ element, index: Number(element.dataset.feedGridItemIndex) }))
        .sort((first, second) => first.index - second.index);
      // A card that changed its column means the feed was laid out anew in
      // spite of the memory: it stands at once, like any new view (SPEC_GRID.md,
      // «Форма ленты»). Asked once, when the first shown card has moved.
      let kept: boolean | null = null;
      let moving = 0;
      for (const { element, index } of shown) {
        if (moving >= CARD_MOVE_LIMIT) break;
        const position = layout.positions[index];
        if (position === undefined) continue;
        const was = rememberedPositionAt(previous, columns, blocks, index)?.top;
        if (was === undefined || was === position.top) continue;
        kept ??= columnsKept(previous, columns, blocks, layout);
        if (!kept) break;
        if (typeof element.animate !== "function") continue;
        moving += 1;
        element.animate(
          [
            { transform: `translate3d(${position.left}px, ${was}px, 0)` },
            { transform: `translate3d(${position.left}px, ${position.top}px, 0)` },
          ],
          { duration: moveMs, easing: moveEasing },
        );
      }
    }
    columnMemoryRef.current = {
      routeKey: routeSnapshotReady ? routeKey : null,
      parentWidth,
      layoutGap,
      show,
      blocks,
      layout,
      wordWidths: wordWidthsMap,
      exact: allCurrentGenerationDeterministic,
    };
  }, [allCurrentGenerationDeterministic, blocks, columns, layout, layoutGap, layoutMovesSmoothly, parentWidth, routeKey, routeSnapshotReady, show, wordWidthsMap]);

  useEffect(() => {
    onColumnCountChange?.(layout.columnCount);
  }, [layout.columnCount, onColumnCountChange]);

  // By the positions, not by the layout object: a layout made anew whose
  // cards did not move keeps its array of positions.
  const { positions: layoutPositions, totalHeight: layoutTotalHeight } = layout;
  const visibilityIndex = useMemo(
    () => createVisibilityIndex({ positions: layoutPositions, totalHeight: layoutTotalHeight }),
    [layoutPositions, layoutTotalHeight],
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

  const getEmergencyVisibleItems = useCallback(
    (scrollTop: number): MasonryPosition[] => {
      if (viewportHeight <= 0) return [];
      return getVisibleItemsFromIndex(
        visibilityIndex,
        scrollTop,
        viewportHeight,
        EMERGENCY_RENDER_OVERSCAN_PX,
        EMERGENCY_RENDER_OVERSCAN_PX,
      );
    },
    [visibilityIndex, viewportHeight],
  );

  const visibleItems = useGridScroll(parentRef, {
    getVisibleItems,
    getEmergencyVisibleItems,
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
    !onEverything &&
    routeSnapshotReady &&
    blocks.length === 0,
  );
  // Everything with nothing in it is a new space, not an empty filter: it is
  // the first screen a new user sees and the only place the clipper can be
  // introduced. See SPEC_ONBOARDING.md О14.
  const showEmptySpaceOnboarding = Boolean(
    onEverything &&
    routeSnapshotReady &&
    blocks.length === 0 &&
    !firstIndexProgress &&
    !vaultIndexing &&
    spaceOnboardingOwed === true &&
    onInstallClipper,
  );
  // The space had cards and they are all gone: an empty feed, not a new space.
  const showEmptyFeedPlaceholder = Boolean(
    onEverything &&
    routeSnapshotReady &&
    blocks.length === 0 &&
    !firstIndexProgress &&
    spaceOnboardingOwed === false,
  );

  useLayoutEffect(() => {
    const scrollElement = parentRef.current;
    const previous = scrollAnchorSnapshotRef.current;

    if (
      scrollElement &&
      previous &&
      previous.routeKey === routeKey &&
      Math.abs(previous.parentWidth - parentWidth) <= 0.5 &&
      viewportHeight > 0 &&
      // At the very top of the feed, do not anchor: a head insert must reveal the
      // new cards. Anchoring the old first card here (a batch insert of
      // >= columnCount cards) fixes it in place and hides the fresh rows above
      // the viewport. Away from the top this guard is inactive and
      // anchoring keeps the first visible card fixed when content above it moves.
      latestScrollTopRef.current > TOP_OF_FEED_SCROLL_EPSILON_PX &&
      // The layout object is a new one whenever the layout is made anew
      // (blocks added/removed, a block's height changed after a preview
      // upgrade, word widths arrived). Re-anchoring on every layout made — not
      // just removals — keeps the first visible card fixed when content above
      // the viewport grows or shrinks. When nothing above shifted, the anchor
      // resolves to the current scrollTop and the apply step below is a no-op.
      previous.layout !== layout
    ) {
      const scrollTopNow = latestScrollTopRef.current;
      const viewportNow = scrollElement.clientHeight || viewportHeight;
      // The anchor is a card on screen whenever one of them is still in the
      // feed: every such card comes before any card off screen. Only without
      // one is the whole previous layout read.
      const onScreen = getVisibleItemsFromIndex(
        previous.visibility,
        scrollTopNow - gridTopInset,
        viewportNow,
        0,
        0,
      ).sort((first, second) => first.index - second.index);
      const anchor = findViewportPreservationAnchor(
        onScreen,
        previous.blocks,
        blocksBySlug,
        scrollTopNow,
        viewportNow,
        gridTopInset,
      ) ?? findViewportPreservationAnchor(
        previous.positions,
        previous.blocks,
        blocksBySlug,
        scrollTopNow,
        viewportNow,
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
      layout,
      visibility: visibilityIndex,
    };
  }, [
    blocks,
    blocksBySlug,
    routeKey,
    focusedSlug,
    layout,
    parentWidth,
    renderReadyBlockIds,
    viewportHeight,
    visibilityIndex,
  ]);

  // Where the feed stands, for the tab's memory. The reader works from the
  // latest geometry whenever the caller asks, so no anchor is computed per
  // scroll frame.
  const scrollPositionInputRef = useRef({ positions: layout.positions, blocks, gridTopInset });
  scrollPositionInputRef.current = { positions: layout.positions, blocks, gridTopInset };
  const readScrollPosition = useCallback((): TabScrollAnchor | null => {
    const scrollTopNow = latestScrollTopRef.current;
    if (scrollTopNow <= TOP_OF_FEED_SCROLL_EPSILON_PX) return null;
    const input = scrollPositionInputRef.current;
    const anchor = findFirstCardAtOrBelowTop(input.positions, input.blocks, scrollTopNow, input.gridTopInset);
    return anchor ? { slug: anchor.slug, offset_px: anchor.offsetTop } : null;
  }, []);
  const onScrollPositionChangeRef = useRef(onScrollPositionChange);
  onScrollPositionChangeRef.current = onScrollPositionChange;
  useEffect(() => {
    onScrollPositionChangeRef.current?.(readScrollPosition);
  }, [blocks, layout.positions, readScrollPosition, scrollTop]);

  // A restored tab returns to its card (SPEC_TABS.md, В40). It waits until
  // the card and every card above it have their height, so the cards above
  // do not move it again, then scrolls once for this request.
  const handledScrollRestoreRef = useRef<TabScrollAnchor | null>(null);
  const onScrollAnchorRestoredRef = useRef(onScrollAnchorRestored);
  onScrollAnchorRestoredRef.current = onScrollAnchorRestored;
  useLayoutEffect(() => {
    const request = restoreScrollAnchor;
    const scrollElement = parentRef.current;
    if (!request || handledScrollRestoreRef.current === request || !scrollElement || viewportHeight <= 0) {
      return;
    }
    const position = findPositionForSlug(layout.positions, blocks, request.slug);
    if (!position || committedEndIndex < position.index) return;
    handledScrollRestoreRef.current = request;
    const nextScrollTop = clampedScrollTopForAnchor(
      layout,
      scrollElement.clientHeight || viewportHeight,
      position,
      { slug: request.slug, offsetTop: request.offset_px },
      gridTopInset,
    );
    if (Math.abs(scrollElement.scrollTop - nextScrollTop) > 0.5) {
      scrollElement.scrollTop = nextScrollTop;
      latestScrollTopRef.current = nextScrollTop;
      setScrollTop(nextScrollTop);
      scrollElement.dispatchEvent(new Event("scroll"));
    }
    onScrollAnchorRestoredRef.current?.();
  }, [blocks, committedEndIndex, gridTopInset, layout, restoreScrollAnchor, viewportHeight]);

  const autoplayEligibleBySlug = useMemo(() => {
    const eligible = new Map<string, ReturnType<typeof normalizeFeedPlayback>>();
    for (const block of blocks) {
      // Most cards have no playback: nothing is asked of them.
      if (!block.feed_playback) continue;
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

  // The diagnostics object lives as long as the feed does. The parts the
  // effects below publish (layout, viewport, height drift) stay on it when the
  // scroll signal replaces the rest.
  useEffect(() => {
    return () => {
      delete window.__MINE_FEED_SCROLL_DEBUG__;
    };
  }, []);

  useEffect(() => {
    const previous = window.__MINE_FEED_SCROLL_DEBUG__;
    window.__MINE_FEED_SCROLL_DEBUG__ = {
      layoutGenerationKey: generationKey,
      scrollDirection: feedScrollSignal.scrollDirection,
      scrollVelocityPxMs: feedScrollSignal.scrollVelocityPxMs,
      isFastScrolling: feedScrollSignal.isFastScrolling,
      mountedGridItems: visibleItems.length,
      renderWindowPx: windowByDirection(
        feedScrollSignal.scrollDirection,
        scrollReadinessWindows.renderBeforePx,
        scrollReadinessWindows.renderAfterPx,
      ),
      priorityWindowPx: windowByDirection(
        feedScrollSignal.scrollDirection,
        scrollReadinessWindows.priorityBeforePx,
        scrollReadinessWindows.priorityAfterPx,
      ),
      layout: previous?.layout,
      viewport: previous?.viewport,
      heightDrift: heightDriftReportRef.current ?? previous?.heightDrift,
    };
  }, [
    feedScrollSignal.isFastScrolling,
    feedScrollSignal.scrollDirection,
    feedScrollSignal.scrollVelocityPxMs,
    generationKey,
    scrollReadinessWindows,
    visibleItems.length,
  ]);

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

  useEffect(() => {
    suppressedFocusedScrollSlugRef.current = null;
    sidebarReturnSlugRef.current = null;
    setFocusedSlug(null);
    setFeedInteractionMode("pointer");
    setPinnedActionMenuSlug(null);
    setSelectedSlugs(new Set());
    setMarqueeSelection(null);
  }, [routeKey]);

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
    // The closed card takes the keyboard's focus back only while the feed is
    // worked with the keyboard: a card opened and closed with the pointer
    // lands unlit (user's decision of 26.10.2026).
    if (feedInteractionMode !== "keyboard") return;
    if (blocksBySlug.has(restoreFocusSlug)) {
      setFocusedSlug(restoreFocusSlug);
    }
  }, [blocksBySlug, feedInteractionMode, restoreFocusSequence, restoreFocusSlug]);

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
    // By the layout object, a new one whenever the layout is made anew.
  }, [blocks, feedInteractionMode, focusedSlug, layout]);

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

  /** The live card under the pointer, as the hover-intent target key. */
  const intentTargetAt = useCallback((target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null;
    const item = target.closest<HTMLElement>('[data-feed-grid-item-live="true"]');
    const slug = item?.dataset.feedGridItemSlug;
    const id = slug ? blocksBySlugRef.current.get(slug)?.id : undefined;
    return id === undefined ? null : String(id);
  }, []);

  const handleIntentPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    cardIntent.move(intentTargetAt(event.target), event.clientX, event.clientY);
  }, [cardIntent, intentTargetAt]);

  const handleIntentPointerLeave = useCallback(() => {
    cardIntent.leave();
  }, [cardIntent]);

  const handleCardMenuOpenChange = useCallback((slug: string, open: boolean) => {
    cardIntent.suspend("menu", open);
    onCardMenuOpenChange?.(slug, open);
  }, [cardIntent, onCardMenuOpenChange]);

  const handleKeyboardActionMenuOpenChange = useCallback((slug: string, open: boolean) => {
    setPinnedActionMenuSlug((current) => {
      if (open) return slug;
      return current === slug ? null : current;
    });
    onCardMenuOpenChange?.(slug, open);
  }, [onCardMenuOpenChange]);

  const clearSelection = useCallback(() => {
    setSelectedSlugs(new Set());
    setMarqueeSelection(null);
  }, []);

  // Without a selection the list is the same empty one: a change of the feed
  // then reaches no card through it.
  const selectedBlocks = useMemo(
    () => (selectedSlugs.size === 0 ? NO_SELECTED_BLOCKS : blocks.filter((block) => selectedSlugs.has(block.slug))),
    [blocks, selectedSlugs],
  );

  /// Every `Delete` of the selection comes here: the selection bar's button,
  /// the ⌘K menu, the right-click menu and Backspace (SPEC_GROUP_SELECTION.md,
  /// «Точки входа»). One selected element opens its own `Delete element?`,
  /// as the card's `Delete` does; the selection clears itself once the card
  /// leaves the feed. Two or more open the one group delete window.
  const requestDeleteSelection = useCallback(() => {
    const slugs = selectedBlocks.map((block) => block.slug);
    const [only, ...rest] = slugs;
    if (only === undefined) return;
    if (rest.length === 0) {
      onRequestDelete(only);
      return;
    }
    deleteSelectionSequenceRef.current += 1;
    setDeleteSelection({
      request: { slugs, sequence: deleteSelectionSequenceRef.current },
      open: true,
    });
  }, [onRequestDelete, selectedBlocks]);

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

  // Reported upward rather than lifted: the focus belongs to the grid, and the
  // bar receives only the one thing it needs — a way to open what is focused,
  // or nothing when there is no focus.
  //
  // Keyboard focus only. Moving the pointer across the feed also sets
  // `focusedSlug` — that is how hover works here — and reporting that put an
  // Enter entry in the bar for a card the user was merely passing over, with
  // no keyboard focus ring to explain it.
  useEffect(() => {
    if (detailOpen || feedInteractionMode !== "keyboard" || !focusedSlug) {
      onKeyboardFocusChange?.(null);
      return;
    }
    const block = blocks.find((candidate) => candidate.slug === focusedSlug);
    onKeyboardFocusChange?.(block ? () => handleBlockClick(block) : null);
  }, [
    blocks,
    detailOpen,
    feedInteractionMode,
    focusedSlug,
    handleBlockClick,
    onKeyboardFocusChange,
  ]);

  // A grid that goes away takes its commands with it: without this the bar keeps
  // offering Focus and the card menu after the feed is replaced by the graph.
  useEffect(() => () => {
    onKeyboardFocusChange?.(null);
    onCardMenuShortcutChange?.(null);
    onSelectionCommandChange?.(null);
    onKeyboardFocusReturnChange?.(null);
  }, [onCardMenuShortcutChange, onKeyboardFocusChange, onKeyboardFocusReturnChange, onSelectionCommandChange]);

  const handleModifiedCardClick = useCallback((
    block: LightBlock,
    event: ReactMouseEvent<HTMLDivElement>,
  ): boolean => {
    // In a tab ⇧⌘ opens the card in a new window (В82); ⌘ alone selects it
    // (user's decision of 06.11.2026).
    if (event.metaKey && event.shiftKey && onOpenBlockElsewhere) {
      event.preventDefault();
      event.stopPropagation();
      onOpenBlockElsewhere(block, true);
      return true;
    }
    if (event.metaKey || event.shiftKey || selectedSlugs.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      toggleSelectedSlug(block.slug);
      setFeedInteractionMode("pointer");
      setFocusedSlug(block.slug);
      return true;
    }

    return false;
  }, [onOpenBlockElsewhere, selectedSlugs.size, toggleSelectedSlug]);

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
    marqueePointerClientRef.current = { x: event.clientX, y: event.clientY };
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
    marqueePointerClientRef.current = { x: event.clientX, y: event.clientY };
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
    marqueePointerClientRef.current = null;
    setMarqueeSelection(null);
  }, [applyMarqueeSelection, clearSelection, marqueeSelection]);

  // A held marquee drag at the scrollport edge pulls the feed. Pointer events
  // stop arriving once the pointer stops moving, so the rectangle has to grow
  // from the scroll itself: each frame scrolls, then recomputes the layout
  // point from the unchanged client position and reselects. Selection is
  // recomputed inside the frame through refs, so the loop is not restarted by
  // the layout and readiness changes it causes.
  const applyMarqueeSelectionRef = useRef(applyMarqueeSelection);
  applyMarqueeSelectionRef.current = applyMarqueeSelection;
  const marqueeSelectionRef = useRef(marqueeSelection);
  marqueeSelectionRef.current = marqueeSelection;

  const marqueeAutoScrollActive = marqueeSelection?.active === true;

  useEffect(() => {
    if (!marqueeAutoScrollActive) return;
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    let frame = 0;
    let previousTimestamp: number | null = null;

    const step = (timestamp: number) => {
      frame = requestAnimationFrame(step);
      const elapsedMs = previousTimestamp === null ? 0 : timestamp - previousTimestamp;
      previousTimestamp = timestamp;
      if (elapsedMs <= 0) return;

      const pointer = marqueePointerClientRef.current;
      if (!pointer) return;

      const viewport = scrollElement.getBoundingClientRect();
      const velocity = marqueeAutoScrollVelocity(pointer.y, viewport.top, viewport.bottom);
      if (velocity === 0) return;

      const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      const previousScrollTop = scrollElement.scrollTop;
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, previousScrollTop + (velocity * elapsedMs) / 1000),
      );
      if (nextScrollTop === previousScrollTop) return;

      scrollElement.scrollTop = nextScrollTop;

      const current = layoutPointFromClientPoint(scrollElement, pointer.x, pointer.y);
      if (!current) return;

      const selection = marqueeSelectionRef.current;
      if (!selection?.active) return;
      const next = { ...selection, current };
      marqueeSelectionRef.current = next;
      setMarqueeSelection(next);
      applyMarqueeSelectionRef.current(next);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [marqueeAutoScrollActive]);

  // Opens the menu of the focused element — the same act whether it arrives as
  // ⌘K or as a press on the bar's Command entry. Guards match the keydown path:
  // the menu opens at the card, so the card must be live and on screen.
  const openFocusedElementMenu = useCallback((): boolean => {
    if (keyboardNavigationDisabled) return false;
    if (feedInteractionMode !== "keyboard" || !focusedSlug) return false;
    const scrollElement = parentRef.current;
    const currentScrollTop = scrollElement?.scrollTop ?? scrollTop;
    const currentViewportHeight = scrollElement?.clientHeight || viewportHeight;
    const focusedPosition = findPositionForSlug(layout.positions, blocks, focusedSlug);
    const focusedBlock = focusedPosition ? blocks[focusedPosition.index] : null;
    if (
      !focusedPosition
      || !focusedBlock
      || !renderReadyBlockIds.has(focusedBlock.id)
      || !isPositionVisibleInViewport(
        focusedPosition,
        currentScrollTop,
        currentViewportHeight,
        gridTopInset,
      )
    ) {
      return false;
    }
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
    return true;
  }, [
    blocks,
    feedInteractionMode,
    focusedSlug,
    gridTopInset,
    keyboardNavigationDisabled,
    layout.positions,
    renderReadyBlockIds,
    scrollTop,
    selectedSlugs.size,
    viewportHeight,
  ]);

  // The feed element menu answers ⌘K only under keyboard focus, so the bar is
  // told about that exact condition — and handed the act itself, so a press on
  // the bar's Command entry opens the same menu the keystroke would.
  useEffect(() => {
    const available = !detailOpen && feedInteractionMode === "keyboard" && focusedSlug !== null;
    onCardMenuShortcutChange?.(available ? () => { openFocusedElementMenu(); } : null);
  }, [detailOpen, feedInteractionMode, focusedSlug, onCardMenuShortcutChange, openFocusedElementMenu]);

  // Selection reports its one bar command — clearing — while it exists.
  useEffect(() => {
    onSelectionCommandChange?.(selectedSlugs.size > 0 ? clearSelection : null);
  }, [clearSelection, onSelectionCommandChange, selectedSlugs.size]);

  // How the focus comes back from the sidebar (SPEC_KEYBOARD.md, М4): to the card
  // it left on, or to the first visible one of a feed it has not been on. Reported
  // into a ref upward, so a layout change costs no render there.
  useEffect(() => {
    onKeyboardFocusReturnChange?.({
      take: () => {
        if (!routeSnapshotReady) return false;
        const remembered = sidebarReturnSlugRef.current;
        const scrollElement = parentRef.current;
        const slug = remembered !== null
          && isLiveSlug(layout.positions, blocks, remembered, renderReadyBlockIds)
          ? remembered
          : firstVisibleSlug(
              layout.positions,
              blocks,
              scrollElement?.scrollTop ?? scrollTop,
              scrollElement?.clientHeight || viewportHeight,
              renderReadyBlockIds,
              gridTopInset,
            );
        if (!slug) return false;
        sidebarReturnSlugRef.current = null;
        blockedPointerPositionRef.current = lastPointerPositionRef.current;
        setFeedInteractionMode("keyboard");
        setFocusedSlug(slug);
        return true;
      },
      release: () => {
        sidebarReturnSlugRef.current = null;
        setFeedInteractionMode("pointer");
      },
    });
  }, [
    blocks,
    gridTopInset,
    layout.positions,
    onKeyboardFocusReturnChange,
    renderReadyBlockIds,
    routeSnapshotReady,
    scrollTop,
    viewportHeight,
  ]);


  // Any other move of the focus ends the pair of sideways arrows: the pointer,
  // Escape, the sidebar, a new route (SPEC_KEYBOARD.md, «Feed»).
  useEffect(() => {
    if (horizontalStepRef.current?.to !== focusedSlug) {
      horizontalStepRef.current = null;
    }
  }, [focusedSlug]);

  useEffect(() => {
    if (keyboardNavigationDisabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // The menu answers the chord the registry holds at this keypress,
      // rebound or not: with a selection it is the batch menu and its own
      // command, otherwise the element menu (SPEC_AUDIT_FIXES.md, Ф11).
      const menuCommand = selectedSlugs.size > 0 ? "batch-menu" : "element-menu";
      const commandK = commandById(menuCommand).matches?.(event) ?? false;
      const scrollElement = parentRef.current;
      const currentScrollTop = scrollElement?.scrollTop ?? scrollTop;
      const currentViewportHeight = scrollElement?.clientHeight || viewportHeight;

      if (commandK) {
        // A text field or a dialog above the feed owns the chord. The card's own
        // menu does not: ⌘K pressed inside it closes it again, so popper
        // content stays allowed here (SPEC_AUDIT_FIXES.md, Г4.2).
        if (
          event.defaultPrevented
          || isEditableKeyboardTarget(event.target)
          || isDialogKeyboardTarget(event.target)
        ) {
          return;
        }
        if (openFocusedElementMenu()) {
          event.preventDefault();
          event.stopPropagation();
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

      const deleteSelection = commandById("delete-selection");
      if (selectedSlugs.size > 0 && deleteSelection.matches?.(event)) {
        event.preventDefault();
        event.stopPropagation();
        requestDeleteSelection();
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

      const stepBackSlug = horizontalStepBackSlug(
        horizontalStepRef.current,
        layout.positions,
        blocks,
        focusedSlug,
        event.key,
        renderReadyBlockIds,
      );
      const nextSlug = stepBackSlug ?? findLayoutNeighborSlug(
        layout.positions,
        blocks,
        focusedSlug,
        event.key,
        renderReadyBlockIds,
      );
      horizontalStepRef.current =
        stepBackSlug === null && nextSlug !== null && (event.key === "ArrowLeft" || event.key === "ArrowRight")
          ? { from: focusedSlug, to: nextSlug, direction: event.key, positions: layout.positions }
          : null;
      if (nextSlug) {
        setFocusedSlug(nextSlug);
      } else if (event.key === "ArrowLeft" && selectedSlugs.size === 0 && onKeyboardFocusLeave?.()) {
        // No card holds the focus while the sidebar does (М1). The mode stays
        // the keyboard's, so the card under a still pointer does not rise.
        sidebarReturnSlugRef.current = focusedSlug;
        setFocusedSlug(null);
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
    onKeyboardFocusLeave,
    openFocusedElementMenu,
    renderReadyBlockIds,
    requestDeleteSelection,
    selectedSlugs.size,
    scrollTop,
    toggleSelectedSlug,
    viewportHeight,
  ]);

  const activeHeavyPlaybackRef = useRef<ReadonlySet<string>>(new Set<string>());

  const activePlaybackSlugs = useMemo(() => {
    if (!tabVisible || renderReadyBlockIds.size === 0 || viewportHeight <= 0) {
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
        show,
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
    show,
    tabVisible,
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
    if (shouldPrefetchNextFeedPage({
      loadedItemCount: blocks.length,
      maxVisibleIndex,
      visibleItemCount: visibleItems.length,
    })) {
      onLoadMoreBlocks();
    }
  }, [
    blocks.length,
    hasMoreBlocks,
    loadingMoreBlocks,
    maxVisibleIndex,
    onLoadMoreBlocks,
    visibleItems.length,
  ]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // The menu is asked for here, in the click's handler: the page's own
      // context menu never opens, on a card or off one.
      e.preventDefault();
      const el = (e.target as HTMLElement).closest("[data-block-slug]");
      if (!el) return;
      const slug = el.getAttribute("data-block-slug")!;
      const point = { x: e.clientX, y: e.clientY };
      setMenuHeldSlug(slug);
      // Right-clicking a card that is part of the selection addresses the whole
      // selection, the way Finder does. Right-clicking outside it stays a
      // single-card menu and leaves the selection alone.
      if (selectedSlugs.has(slug)) {
        cardPointMenuRef.current?.close();
        selectionPointMenuRef.current?.open(point);
        return;
      }
      const block = blocksBySlug.get(slug);
      if (block) cardPointMenuRef.current?.open(block, point);
    },
    [blocksBySlug, selectedSlugs],
  );

  const handleRequestDelete = useCallback((slug: string) => {
    onRequestDelete(slug);
  }, [onRequestDelete]);

  const closeDeleteSelection = useCallback(() => {
    setDeleteSelection((current) => current && { ...current, open: false });
  }, []);

  const handleSelectionDeleted = useCallback(() => {
    closeDeleteSelection();
    clearSelection();
  }, [clearSelection, closeDeleteSelection]);

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
  const keyboardFocusedBlockId =
    keyboardFocusedSlug === null ? null : blocksBySlug.get(keyboardFocusedSlug)?.id ?? null;

  // Under the arrow keys the focused card answers at once (С4, С7.7). Back in
  // pointer mode the keyboard's answer holds until the pointer chooses a card,
  // or for the warm window, instead of blinking off on the first mouse move.
  useEffect(() => {
    const keyboard = feedInteractionMode === "keyboard";
    pointerDrivesCardHoverRef.current = !keyboard;
    clearKeyboardAnswerTimer();
    if (keyboard) {
      setHoveredCard(keyboardFocusedBlockId);
      return;
    }
    const { chosen } = cardIntent.current();
    if (chosen !== null) {
      setHoveredCard(null);
      return;
    }
    keyboardAnswerTimerRef.current = window.setTimeout(() => {
      keyboardAnswerTimerRef.current = null;
      if (cardIntent.current().chosen === null) setHoveredCard(null);
    }, HOVER_INTENT.warmMs);
  }, [cardIntent, clearKeyboardAnswerTimer, feedInteractionMode, keyboardFocusedBlockId]);


  useEffect(() => () => {
    clearKeyboardAnswerTimer();
    setHoveredCard(null);
  }, [clearKeyboardAnswerTimer]);

  // A new column count or collection moves every card under the pointer (С7.5).
  useEffect(() => {
    cardIntent.displace();
  }, [cardIntent, columnCount, columnWidth, routeKey]);

  // The sidebar describes and edits the whole selection (SPEC_CARD_STATES.md, С6).
  useEffect(() => {
    setSelectedCards(selectedBlocks.map((block) => ({ id: block.id, slug: block.slug })));
  }, [selectedBlocks]);
  useEffect(() => () => setSelectedCards([]), []);
  const visualFocusActive = keyboardFocusedSlug !== null || pinnedActionMenuSlug !== null;

  const gridContext: GridContext = useMemo(
    () => ({
      vaultPath,
      thumbsRootPath: resolvedThumbsRootPath,
      gridTopInset,
      focusedSlug: keyboardFocusedSlug,
      pinnedActionMenuSlug,
      menuHeldSlug,
      selectedSlugs,
      selectedBlocks,
      actionMenuRequest,
      selectionBatchMenuRequest,
      hoverEnabled: feedInteractionMode !== "keyboard" && selectedSlugs.size === 0,
      cardLift,
      onGridItemPointerMove: handleGridItemPointerMove,
      onKeyboardActionMenuOpenChange: handleKeyboardActionMenuOpenChange,
      onCardMenuOpenChange: handleCardMenuOpenChange,
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
      onRequestDeleteSelection: requestDeleteSelection,
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
      menuHeldSlug,
      selectedSlugs,
      selectedBlocks,
      actionMenuRequest,
      selectionBatchMenuRequest,
      feedInteractionMode,
      cardLift,
      handleGridItemPointerMove,
      handleKeyboardActionMenuOpenChange,
      handleCardMenuOpenChange,
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
      requestDeleteSelection,
      openMergeDialog,
      onRequestRename,
      handleRequestDelete,
    ],
  );

  // The open collection marks its pill on every card, and a pill opens its
  // collection (С9).
  const cardCollections = useMemo<CardCollectionsNavigation>(() => ({
    currentTag: currentTag ?? null,
    open: (tag: string) => onNavigateCollection?.(tag),
  }), [currentTag, onNavigateCollection]);

  return (
    <FeedShowContext.Provider value={show}>
    <CardColumnWidthContext.Provider value={columnWidth}>
    <CardCollectionsContext.Provider value={cardCollections}>
    <div className="relative h-full">
    {/* An open right-click menu holds the pointer's answers like the card's
        own menus do (С7.8, useHoverIntent): the card under it drops its hover
        and its lift at once, though WebKit keeps `:hover` until the pointer
        moves. Its owners below report it (src/lib/openMenus.ts). */}
    <div
      ref={parentRef}
      onContextMenu={handleContextMenu}
      onPointerDown={handleGridPointerDown}
      onPointerMove={(event) => {
        handleIntentPointerMove(event);
        handleGridPointerMove(event);
      }}
      // A menu going away from over a still pointer: WebKit names what is
      // under it now with this event alone, with no `pointermove` (С7.8).
      onPointerOver={handleIntentPointerMove}
      onPointerLeave={handleIntentPointerLeave}
      onPointerUp={finishMarqueeSelection}
      onPointerCancel={finishMarqueeSelection}
      className="h-full overflow-x-hidden overflow-y-auto pb-8"
      style={{
        paddingLeft: gridXInset,
        paddingRight: gridXInset,
        scrollbarGutter: "stable",
        transition: FEED_INSET_TRANSITION,
      }}
      data-grid-scroll
      data-feed-grid-interaction-mode={feedInteractionMode}
      data-feed-grid-focus-mode={visualFocusActive ? "true" : undefined}
    >
      <HoverIntentDragWatch intent={cardIntent} />
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
      {parentWidth > 0 && showEmptyFeedPlaceholder && (
        <EmptyChannelPlaceholder
          viewportHeight={viewportHeight}
          text={EMPTY_FEED_PLACEHOLDER_TEXT}
        />
      )}
      {parentWidth > 0 && showEmptySpaceOnboarding && (
        <EmptySpaceOnboarding
          viewportHeight={viewportHeight}
          onInstallClipper={onInstallClipper!}
        />
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

    {/* The selection's commands render in the secondary chrome row — the
        selection itself stays owned here, presentation moves. Without a host
        (unit renders) the row mounts in place. */}
    {!blockDragActive && (() => {
      const commands = (
        <GroupSelectionCommands
          selectedBlocks={selectedBlocks}
          tags={tags}
          currentTag={currentTag}
          onLoadBlockTags={onLoadBlockTags}
          onBatchSetTag={onBatchSetTag}
          onCreateAndAssignBatch={onCreateAndAssignBatch}
          onRequestDeleteSelection={requestDeleteSelection}
          onMergeSelectedBlocks={openMergeDialog}
          onClearSelection={clearSelection}
        />
      );
      return selectionCommandsHost
        ? createPortal(commands, selectionCommandsHost)
        : commands;
    })()}

    {/* The feed's one group delete window, one instance per request. */}
    {deleteSelection && (
      <DeleteSelectionWindow
        key={deleteSelection.request.sequence}
        open={deleteSelection.open}
        slugs={deleteSelection.request.slugs}
        vaultPath={vaultPath}
        thumbsRootPath={resolvedThumbsRootPath}
        onPrepare={onPrepareDeleteSelectedBlocks}
        onDelete={onDeleteSelectedBlocks}
        onClose={closeDeleteSelection}
        onDeleted={handleSelectionDeleted}
      />
    )}

    <MergeCardsDialog
      open={mergeDialogOpen}
      selectedBlocks={selectedBlocks}
      thumbsRootPath={resolvedThumbsRootPath}
      onOpenChange={setMergeDialogOpen}
      onConfirm={handleConfirmMerge}
    />
    <GroupSelectionPointMenuHost
      handleRef={selectionPointMenuRef}
      onOpenChange={setSelectionPointMenuOpen}
      selectedBlocks={selectedBlocks}
      tags={tags}
      currentTag={currentTag}
      onLoadBlockTags={onLoadBlockTags}
      onBatchSetTag={onBatchSetTag}
      onCreateAndAssignBatch={onCreateAndAssignBatch}
      onRequestDeleteSelection={requestDeleteSelection}
      onMergeSelectedBlocks={openMergeDialog}
      onClearSelection={clearSelection}
    />
    <CardPointMenuHost
      handleRef={cardPointMenuRef}
      onOpenChange={setCardPointMenuOpen}
      vaultPath={vaultPath}
      tags={tags}
      currentTag={currentTag}
      onToggleTag={onToggleTag}
      onCreateAndAssign={onCreateAndAssign}
      onRequestRename={onRequestRename}
      onRequestDelete={onRequestDelete}
    />
    </div>
    </CardCollectionsContext.Provider>
    </CardColumnWidthContext.Provider>
    </FeedShowContext.Provider>
  );
}

// ─── Virtualized JS path (the only layout path, SPEC_GRID.md) ───────────────

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
  // A hovered sidebar row lights the cards of its collection (SPEC_CARD_STATES.md, С3).
  const litByCollection = useCardLitByCollection(block.id);
  // Hover answers only on the card a settling pointer reached, so a sweep
  // across the feed lifts nothing (SPEC_CARD_STATES.md, С8.6).
  const hoverArmed = useCardRaised(context.cardLift, block.id);

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

  // Fires for every menu of the card, opened by pointer or keyboard, unlike the
  // handler above which only covers the keyboard-driven overflow menu.
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      context.onCardMenuOpenChange?.(block.slug, open);
    },
    [context.onCardMenuOpenChange, block.slug],
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
      data-feed-grid-item-collection-lit={isCommitted && litByCollection ? "true" : undefined}
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
            menuHeld={block.slug === context.menuHeldSlug}
            hoverArmed={hoverArmed}
            menuBadge={isFocused ? (context.selectedSlugs.size > 0 ? "batch-menu" : "element-menu") : null}
            keyboardLift={isFocused && !isSelected}
            dragBlocks={dragBlocks}
            clearSelectionOnDragStart={clearSelectionOnDragStart}
            onKeyboardMoreMenuOpenChange={handleKeyboardMoreMenuOpenChange}
            onMenuOpenChange={handleMenuOpenChange}
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
            onRequestDeleteSelection={context.onRequestDeleteSelection}
            onMergeSelectedBlocks={context.onMergeSelectedBlocks}
            onClearSelection={context.onClearSelection}
          />
        )}
      </div>
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
      // 1. Wait for fonts to be ready — text widths depend on the interface
      //    font being loaded; the system font always is, a font file
      //    (Departure Mono) may still be on its way.
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
