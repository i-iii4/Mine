import { scrollBehavior } from "@/lib/motion";
import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  memo,
  forwardRef,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { NavLink, useLocation } from "react-router";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { bindingLabel } from "@/lib/commandBinding";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import type { IndexedBlock, LightBlock, TagCount, PreviewCard } from "@/types";
import { getBlock } from "@/lib/commands";
import { collectionRefLabel } from "@/lib/collections";
import { SIDEBAR_ROW_HOVER_SEAM_ENABLED } from "@/lib/featureFlags";
import { getHoverPreviewOpenDelay } from "@/lib/hoverPreviewTiming";
import {
  buildSidebarRowOrder,
  filterSidebarTags,
  shouldShowSidebarEverythingRow,
  sidebarRowDomId,
} from "@/lib/sidebarSearch";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  CONNECT_ACTION_BUTTON_CLASS,
  SIDEBAR_PREVIEW_DIVIDER_GAP_PX,
  SIDEBAR_PREVIEW_SLOTS,
  SIDEBAR_ROW_ACTION_GAP_PX,
} from "@/lib/appLayout";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";
import {
  applySelectionMembership,
  setHoveredCollectionRow,
  useCardSelectionSummary,
  useRowConnectedToHoveredCard,
} from "@/lib/collectionHover";
import { scheduleAfterOptimisticUiUpdate } from "@/lib/groupSelection";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { HoverIntentDragWatch, useHoverIntent } from "@/hooks/useHoverIntent";
import { TopFadeScrim } from "./TopFadeScrim";
import { useTopFadeMask } from "@/hooks/useTopFadeMask";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { ReadOnlyCardPreview } from "./Card";
import { MicroPreviewThumbnail, microPreviewFromPreviewCard } from "./MicroPreviewThumbnail";

const SIDEBAR_PREVIEW_WIDTH = 240;
const SIDEBAR_PREVIEW_FALLBACK_HEIGHT = 320;
const SIDEBAR_PREVIEW_GAP = 8;
const SIDEBAR_PREVIEW_VIEWPORT_MARGIN = 16;
const SIDEBAR_PREVIEW_DIVIDER_GAP = SIDEBAR_PREVIEW_DIVIDER_GAP_PX;
/// The row's box: 40 tall, with the last pixel reserved for the divider that
/// closes it. Content centres in what is left, so the space above and below it
/// comes out equal — the rule the chrome already follows through `border-box`,
/// which subtracts its border before centring. Written as padding rather than
/// as height, because the row's size belongs to the modular scale and a
/// hairline must not push it off.
// A row's step, its 1px line (`pb-px`) included: `--sidebar-row-height`,
// which the tall chrome steps by too (SPEC_TABS.md, В83).
const SIDEBAR_ROW_BOX_CLASS = "relative flex min-h-[var(--sidebar-row-height)] w-full items-center pb-px";
const SIDEBAR_ROW_ACTION_BUTTON_WIDTH = `calc(var(--sidebar-zone) - ${2 * SIDEBAR_ROW_ACTION_GAP_PX}px)`;
const SIDEBAR_ROW_ACTION_BUTTON_GAP = SIDEBAR_ROW_ACTION_GAP_PX;
/// How far the button's body sits from the right edge of the row.
///
/// The plate belongs to the cell, not to the count's text alignment.
const SIDEBAR_ROW_ACTION_BUTTON_INSET = SIDEBAR_ROW_ACTION_BUTTON_GAP;
const SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH = EDGE_FADE_WIDTH;
const SIDEBAR_PREVIEW_MASK_FADE_WIDTH = EDGE_FADE_WIDTH;
/// Where the thumbnails stop: the meta zone, the guideline's own pixel, and
/// then the clear ones the divider gap asks for. Measured from the zone
/// boundary, which is where the guideline now stands — counting from the
/// button's own field instead left the previews short of their zone.
const SIDEBAR_PREVIEW_MASK_CLEAR_TAIL =
  `calc(var(--sidebar-zone) + 1px + ${SIDEBAR_PREVIEW_DIVIDER_GAP}px)`;
/** A row's `Connected` that only reports. It is the bottom bar's reference
 *  key, built the same way (ActionButton with `readOnly`): the `reference`
 *  body, mono regular type, muted colour, no hover. Only its height follows
 *  the row's action button, whose place it takes. SPEC_CARD_STATES.md, С4, С5. */
const SIDEBAR_ROW_CONNECTED_PILL_CLASS = cn(
  buttonVariants({ variant: "reference", size: "xs" }),
  "pointer-events-none h-6 font-mono font-normal text-muted-foreground",
);
/**
 * A row's answering parts cross-fade: in over `--hover-intent-fade-in` when the
 * answer appears, out over the shorter `--hover-intent-fade-out` when it goes
 * (С7.6). Both parts of a swap share the timing, so no gap opens between them.
 */
const ROW_INTENT_FADE = "transition-opacity ease-[cubic-bezier(0.22,1,0.36,1)]";
const ANSWER_ON = "duration-[var(--hover-intent-fade-in)]";
const ANSWER_OFF = "duration-[var(--hover-intent-fade-out)]";
/** Shown until a slow pointer or the keyboard reaches the row. */
const ROW_INTENT_HIDES = cn(
  "opacity-100",
  ANSWER_OFF,
  "group-data-[sidebar-row-intent=true]:opacity-0 group-data-[sidebar-row-intent=true]:duration-[var(--hover-intent-fade-in)]",
  "group-focus-within:opacity-0 group-focus-within:duration-[var(--hover-intent-fade-in)]",
);
/** Shown once a slow pointer or the keyboard reaches the row. */
const ROW_INTENT_SHOWS = cn(
  "opacity-0",
  ANSWER_OFF,
  "group-data-[sidebar-row-intent=true]:opacity-100 group-data-[sidebar-row-intent=true]:duration-[var(--hover-intent-fade-in)]",
  "group-focus-within:opacity-100 group-focus-within:duration-[var(--hover-intent-fade-in)]",
);
/** Two labels stacked in one cell, so swapping them never moves the button's text. */
const ROW_INTENT_LABEL_STACK = "grid place-items-center [&>*]:[grid-area:1/1]";
const SIDEBAR_ROW_ACTION_BUTTON_CLASS = CONNECT_ACTION_BUTTON_CLASS;
const SIDEBAR_ROW_TEXT_MASK_STYLE = createRightFadeMaskStyle(
  SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH,
  SIDEBAR_PREVIEW_DIVIDER_GAP,
);

const SIDEBAR_PREVIEW_MASK_STYLE = createRightFadeMaskStyle(
  SIDEBAR_PREVIEW_MASK_FADE_WIDTH,
  SIDEBAR_PREVIEW_MASK_CLEAR_TAIL,
);

/// One tile of the thumbnail strip, real or placeholder. Both draw from this
/// single class, so a placeholder occupies exactly the box its thumbnail will
/// take and nothing moves when the picture arrives. The fill is the feed
/// skeleton's quiet `bg-accent`: it is what a placeholder shows, and what a
/// real tile shows behind its image until that image has decoded.
const SIDEBAR_PREVIEW_TILE_CLASS = "size-8 shrink-0 overflow-hidden bg-accent";

type SidebarPreviewTarget = {
  key: string;
  rowKey: string;
  slug: string;
};

type SidebarPreviewPosition = {
  top: number;
  left: number;
};

type CardMenuPoint = {
  x: number;
  y: number;
};

/** The row's Connect / Connected / Disconnect button: for the expanded card,
 *  or for the whole feed selection (SPEC_CARD_STATES.md, С6). */
type SidebarRowLinkEditor = {
  checked: boolean;
  /** Some but not all selected cards are in the collection: `connected/total`. */
  partial?: string;
  /** Edits the feed selection: the row stays reorderable and renamable. */
  forSelection?: boolean;
  onToggle: () => void;
};

type SidebarKeyboardNavigationFocus = {
  rowKey: string;
  sequence: number;
};

const SIDEBAR_LINK_MODE_OPTIONS: SegmentedControlOption<"all" | "linked">[] = [
  { value: "all", label: "All" },
  { value: "linked", label: "Connected" },
];

type SidebarLinkMode = "all" | "linked";

interface SidebarProps {
  width: number;
  collapsed: boolean;
  isResizing: boolean;
  vaultPath?: string;
  thumbsRootPath?: string;
  tags?: TagCount[];
  currentTag?: string;
  orderedTags: TagCount[];
  /// Thumbnails per collection tag, plus `__all__` for Everything. A read
  /// answers for every known collection, empty ones included, so a key that
  /// is missing means the read has not answered for that row yet: the row
  /// then draws placeholder tiles in place of its thumbnails.
  channelPreviews: Map<string, PreviewCard[]>;
  /// The space's previews are still being built in the background. The read
  /// returns only cards whose thumbnail exists, so until the pass ends a row
  /// tops its real thumbnails up with placeholder tiles, one per card still
  /// waiting, up to what the strip holds. Without it a row shows only the
  /// thumbnails that exist.
  previewsPending?: boolean;
  totalBlocks: number;
  isDropDragging: boolean;
  /// A collection row is being reordered. Separate from `isDropDragging`
  /// because the two gestures need opposite pointer behaviour: a drop reads
  /// rows through hit-testing, a sort must make them inert.
  isTagDragging?: boolean;
  isCreatingChannel: boolean;
  onSetCreatingChannel: (v: boolean) => void;
  onDeleteTag: (tag: string) => void;
  onRenameTag: (oldTag: string, newTag: string) => void;
  onCreateChannel: (tag: string) => void;
  onOpenBlock?: (block: IndexedBlock) => void;
  onOpenCardMenu?: (block: LightBlock | IndexedBlock, point: CardMenuPoint) => void;
  hoverPreviewFrozen?: boolean;
  onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign?: (tag: string, blockSlug: string) => void;
  onRequestRename?: (block: LightBlock) => void;
  onRequestDelete?: (slug: string) => void;
  onNavClick?: () => void;
  onScrollToTop?: () => void;
  keyboardNavigationFocus?: SidebarKeyboardNavigationFocus | null;
  keyboardNavigationFocusPersistent?: boolean;
  searchQuery?: string;
  /** Optional slot for a header banner (e.g. iCloud conflict surface). */
  headerSlot?: React.ReactNode;
  /** ⌘-click on a row opens its route in a new tab, ⇧⌘-click in a new window
   *  (SPEC_TABS.md, В82). Absent on a page that is not a tab. */
  onOpenElsewhere?: (to: string, newWindow: boolean) => void;
  linkedBlockSlug?: string | null;
  linkedTags?: string[];
  onToggleLinkedTag?: (slug: string, tag: string, hasTag: boolean) => void;
  /** Connects or disconnects every selected feed card (SPEC_CARD_STATES.md, С6). */
  onBatchSetTag?: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  linkMode?: SidebarLinkMode;
  onLinkModeChange?: (mode: SidebarLinkMode) => void;
  showLinkModeChrome?: boolean;
  detailChromeClosing?: boolean;
  /** Dissolve rows into transparency as they scroll up under the chrome. */
  scrollEdgeFade?: boolean;
}

function createSidebarSeamAccentSet(
  orderedRowKeys: string[],
  focusedRowKey: string | null,
): Set<string> {
  if (!focusedRowKey) return new Set();
  const focusedIndex = orderedRowKeys.indexOf(focusedRowKey);
  if (focusedIndex === -1) return new Set();
  const accentKeys = new Set<string>([focusedRowKey]);
  if (focusedIndex > 0) {
    accentKeys.add(orderedRowKeys[focusedIndex - 1]!);
  }
  return accentKeys;
}

/// Thin shell around the sidebar whose only job is the dnd-context
/// subscription. The context updates on every `over` change — dozens of times a
/// second while a drag crosses the list — and re-rendering the whole sidebar at
/// that rate is what fast gestures stutter on. The shell derives the one value
/// the core needs (the drop target row, and only for card/media/text drops) and
/// the memoised core skips every update that leaves it unchanged. A collection
/// sort derives nothing, so during it the core does not re-render at all: only
/// the sortable rows move, each through its own useSortable subscription.
/** What a ⌘-click on a row does (В82); reaches every row without threading
 *  a prop through the row components. */
const SidebarOpenElsewhereContext = createContext<((to: string, newWindow: boolean) => void) | null>(null);

export function Sidebar(props: SidebarProps) {
  const { over } = useDndContext();
  const dropOverId = props.isDropDragging && over?.id != null ? String(over.id) : null;
  return (
    <SidebarOpenElsewhereContext.Provider value={props.onOpenElsewhere ?? null}>
      <SidebarCore {...props} dropOverId={dropOverId} />
    </SidebarOpenElsewhereContext.Provider>
  );
}

const SidebarCore = memo(function SidebarCore({
  dropOverId,
  isResizing,
  vaultPath,
  thumbsRootPath,
  orderedTags,
  channelPreviews,
  previewsPending = false,
  totalBlocks,
  isDropDragging,
  isTagDragging = false,
  isCreatingChannel,
  onSetCreatingChannel,
  onDeleteTag,
  onRenameTag,
  onCreateChannel,
  onOpenBlock,
  onOpenCardMenu,
  hoverPreviewFrozen = false,
  onNavClick,
  onScrollToTop,
  keyboardNavigationFocus,
  keyboardNavigationFocusPersistent = false,
  searchQuery = "",
  headerSlot,
  linkedBlockSlug,
  linkedTags = [],
  onToggleLinkedTag,
  onBatchSetTag,
  linkMode,
  onLinkModeChange,
  showLinkModeChrome = true,
  detailChromeClosing = false,
  scrollEdgeFade = false,
}: SidebarProps & { dropOverId: string | null }) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [uncontrolledLinkMode, setUncontrolledLinkMode] = useState<SidebarLinkMode>("all");
  const effectiveLinkMode = linkMode ?? uncontrolledLinkMode;
  const navRef = useRef<HTMLElement>(null);
  const topFade = useTopFadeMask(navRef, scrollEdgeFade);
  const previewTriggerRefs = useRef(new Map<string, HTMLElement>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewOpenTimerRef = useRef<number | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const lastPreviewOpenedAtRef = useRef<number | null>(null);
  const lastPointerPointRef = useRef<CardMenuPoint | null>(null);
  const previousHoverPreviewFrozenRef = useRef(hoverPreviewFrozen);
  // Mirror the live drag state so the deferred open timer can read the current
  // value at fire time, not the value captured when the timer was scheduled.
  const isDropDraggingRef = useRef(isDropDragging);
  isDropDraggingRef.current = isDropDragging;
  const isTagDraggingRef = useRef(isTagDragging);
  isTagDraggingRef.current = isTagDragging;
  const sidebarRowSwitchFrameRef = useRef<number | null>(null);
  const sidebarKeyboardFocusTimerRef = useRef<number | null>(null);
  const sidebarRowFocusKeyRef = useRef<string | null>(null);
  const sidebarRowFocusModeRef = useRef(false);
  const [hoveredPreview, setHoveredPreview] = useState<SidebarPreviewTarget | null>(null);
  const [hoverPreviewBlock, setHoverPreviewBlock] = useState<IndexedBlock | null>(null);
  const [hoverPreviewPosition, setHoverPreviewPosition] = useState<SidebarPreviewPosition | null>(null);
  const [sidebarRowFocusKey, setSidebarRowFocusKey] = useState<string | null>(null);
  const [sidebarRowFocusMode, setSidebarRowFocusMode] = useState(false);
  const [sidebarRowSwitching, setSidebarRowSwitching] = useState(false);
  const location = useLocation();

  // Rows answer attention, not the pointer's path (SPEC_CARD_STATES.md,
  // С7.10). What the click reaches, a row's name and its button, shows under
  // a slow pointer at once; the lit feed (С3) and the big preview wait until
  // the pointer chooses the row.
  const [intentRowKey, setIntentRowKey] = useState<string | null>(null);
  const applyPointerRowFocusRef = useRef<(rowKey: string | null) => void>(() => {});
  // The open collection's row lights nothing: the feed already shows only its
  // cards, as Everything's row would light them all (С3).
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const feedRowKey = useCallback((rowKey: string | null) => {
    if (rowKey === null || !rowKey.startsWith("tag:")) return rowKey;
    const route = `/channel/${encodeURIComponent(rowKey.slice(4))}`;
    const pathname = pathnameRef.current;
    return pathname === route || pathname.startsWith(`${route}/`) ? null : rowKey;
  }, []);
  // The engine calms only what a row lights elsewhere: the feed's cards of
  // its collection (С3) and the big preview of a thumbnail. The row's own
  // name, count and button answer the pointer at once (С7.10, user's
  // decision of 02.10.2026): they are the most responsive part of the list.
  const rowIntent = useHoverIntent(({ chosen }) => {
    setHoveredCollectionRow(feedRowKey(chosen));
  });
  // The row under the pointer, set on every move without delay or speed gate.
  // After the list scrolls, a report at the pointer's same point is the list
  // moving, not the pointer (WebKit repeats it): no row lights until the
  // pointer really moves (С7.5).
  const pointerRowKeyRef = useRef<string | null>(null);
  const lastPointerPointRowRef = useRef<{ x: number; y: number } | null>(null);
  const listSlidRef = useRef(false);
  const setPointerRow = useCallback((rowKey: string | null) => {
    if (pointerRowKeyRef.current === rowKey) return;
    pointerRowKeyRef.current = rowKey;
    applyPointerRowFocusRef.current(rowKey);
    setIntentRowKey(rowKey);
  }, []);
  useEffect(() => () => setHoveredCollectionRow(null), []);
  // Opening a collection under the pointer stops its row lighting the feed.
  useEffect(() => {
    setHoveredCollectionRow(feedRowKey(rowIntent.current().chosen));
  }, [feedRowKey, location.pathname, rowIntent]);

  useEffect(() => {
    const recordPointerPoint = (event: Event) => {
      const point = clientPointFromEvent(event);
      if (point) {
        lastPointerPointRef.current = point;
      }
    };
    window.addEventListener("pointermove", recordPointerPoint, true);
    window.addEventListener("pointerdown", recordPointerPoint, true);
    window.addEventListener("contextmenu", recordPointerPoint, true);
    return () => {
      window.removeEventListener("pointermove", recordPointerPoint, true);
      window.removeEventListener("pointerdown", recordPointerPoint, true);
      window.removeEventListener("contextmenu", recordPointerPoint, true);
    };
  }, []);

  // Auto-scroll sidebar to the active channel (e.g. after Opt+Cmd+Arrow)
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      scrollActiveSidebarItemIntoView(nav, active);
    }
  }, [location.pathname]);

  // Row callbacks are identity-stable so `memo(TagNavItem)` can actually skip
  // work: the sidebar re-renders on every dnd `over` change, and inline arrows
  // would hand each row a fresh function and force a full repaint of the list
  // mid-gesture.
  const startRenamingTag = useCallback((tag: string) => setEditingTag(tag), []);
  const cancelRenamingTag = useCallback(() => setEditingTag(null), []);

  const handleRename = useCallback(
    (oldTag: string, newValue: string) => {
      const trimmed = newValue.trim();
      if (trimmed) onRenameTag(oldTag, trimmed);
      setEditingTag(null);
    },
    [onRenameTag],
  );

  // The compact icon-rail state is gone: the panel is either the full table or
  // fully collapsed (removed). Rows always render the three-column layout.
  const compact = false;
  const isLinkingBlock = !!linkedBlockSlug && !!onToggleLinkedTag;
  const isLinkEditorActive = isLinkingBlock && !detailChromeClosing;
  // While cards are selected in the feed, the rows describe and edit the whole
  // selection the way they edit one card in an expanded card (С6). An expanded
  // card takes precedence: the sidebar then belongs to it.
  const cardSelection = useCardSelectionSummary();
  const isSelectionEditorActive = !isLinkEditorActive && cardSelection !== null && !!onBatchSetTag;
  const selectionLinkEditor = (tag: string): SidebarRowLinkEditor | undefined => {
    if (!isSelectionEditorActive || !cardSelection || !onBatchSetTag) return undefined;
    const connected = cardSelection.connectedByTag.get(tag) ?? 0;
    const checked = connected === cardSelection.total;
    return {
      checked,
      partial: connected > 0 && !checked ? `${connected}/${cardSelection.total}` : undefined,
      forSelection: true,
      onToggle: () => {
        const slugs = [...cardSelection.slugs];
        applySelectionMembership(tag, !checked);
        scheduleAfterOptimisticUiUpdate(() => {
          void Promise.resolve(onBatchSetTag(slugs, tag, !checked)).catch((err: unknown) => {
            console.error("Failed to update the selection's collection:", err);
          });
        });
      },
    };
  };
  const linkedTagSet = useMemo(() => new Set(linkedTags), [linkedTags]);
  const baseVisibleTags = useMemo(() => (
    isLinkEditorActive && effectiveLinkMode === "linked"
      ? orderedTags.filter((tc) => linkedTagSet.has(tc.tag))
      : orderedTags
  ), [effectiveLinkMode, isLinkEditorActive, linkedTagSet, orderedTags]);
  const visibleTags = useMemo(() => (
    filterSidebarTags(baseVisibleTags, searchQuery)
  ), [baseVisibleTags, searchQuery]);
  const showEverythingRow = shouldShowSidebarEverythingRow(searchQuery);
  const editingRowKey = !isLinkEditorActive && editingTag !== null
    ? `tag:${editingTag}`
    : isCreatingChannel
      ? "create-channel"
      : null;
  // The create row exists only while it has a job: naming a new collection,
  // or taking a dragged card to found one. The command itself lives in the
  // row above the list and on ⇧⌘N.
  const showCreateRow = isCreatingChannel || isDropDragging;
  const orderedRowKeys = buildSidebarRowOrder(visibleTags, showEverythingRow, showCreateRow);
  const activePreviewRowKey = hoveredPreview?.rowKey ?? null;
  const overId = dropOverId;
  const dropOverRowKey = overId?.startsWith("tag:")
    ? overId
    : overId === "create-channel"
      ? "create-channel"
      : null;
  const effectiveSidebarRowFocusKey = editingRowKey ?? dropOverRowKey ?? (sidebarRowFocusMode
    ? sidebarRowFocusKey
    : activePreviewRowKey);
  const hasSidebarRowFocusMode = editingRowKey !== null || dropOverRowKey !== null || sidebarRowFocusMode || activePreviewRowKey !== null;
  const seamAccentKeys = createSidebarSeamAccentSet(
    orderedRowKeys,
    effectiveSidebarRowFocusKey,
  );
  const [linkChromeEntered, setLinkChromeEntered] = useState(false);

  const setPreviewTriggerRef = useCallback((key: string, node: HTMLElement | null) => {
    if (node) {
      previewTriggerRefs.current.set(key, node);
    } else {
      previewTriggerRefs.current.delete(key);
    }
  }, []);

  const clearPreviewOpenTimer = useCallback(() => {
    if (previewOpenTimerRef.current !== null) {
      window.clearTimeout(previewOpenTimerRef.current);
      previewOpenTimerRef.current = null;
    }
  }, []);

  const clearPreviewCloseTimer = useCallback(() => {
    if (previewCloseTimerRef.current !== null) {
      window.clearTimeout(previewCloseTimerRef.current);
      previewCloseTimerRef.current = null;
    }
  }, []);

  const clearSidebarRowSwitchFrame = useCallback(() => {
    if (sidebarRowSwitchFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarRowSwitchFrameRef.current);
      sidebarRowSwitchFrameRef.current = null;
    }
  }, []);

  const clearSidebarKeyboardFocusTimer = useCallback(() => {
    if (sidebarKeyboardFocusTimerRef.current !== null) {
      window.clearTimeout(sidebarKeyboardFocusTimerRef.current);
      sidebarKeyboardFocusTimerRef.current = null;
    }
  }, []);

  const deactivateSidebarRowFocusMode = useCallback(() => {
    clearSidebarRowSwitchFrame();
    clearSidebarKeyboardFocusTimer();
    sidebarRowFocusKeyRef.current = null;
    sidebarRowFocusModeRef.current = false;
    setSidebarRowSwitching(false);
    setSidebarRowFocusKey(null);
    setSidebarRowFocusMode(false);
  }, [clearSidebarKeyboardFocusTimer, clearSidebarRowSwitchFrame]);

  const activateSidebarRowFocus = useCallback((rowKey: string) => {
    const previousKey = sidebarRowFocusKeyRef.current;
    const wasFocusMode = sidebarRowFocusModeRef.current;
    if (wasFocusMode && previousKey === rowKey) {
      return;
    }

    clearSidebarRowSwitchFrame();
    if (wasFocusMode && previousKey !== null) {
      setSidebarRowSwitching(true);
      sidebarRowSwitchFrameRef.current = window.requestAnimationFrame(() => {
        sidebarRowSwitchFrameRef.current = null;
        setSidebarRowSwitching(false);
      });
    } else {
      setSidebarRowSwitching(false);
    }

    sidebarRowFocusKeyRef.current = rowKey;
    sidebarRowFocusModeRef.current = true;
    setSidebarRowFocusKey(rowKey);
    setSidebarRowFocusMode(true);
  }, [clearSidebarRowSwitchFrame]);

  const focusSidebarRowFromTarget = useCallback((target: EventTarget | null, root: HTMLElement) => {
    if (!(target instanceof Element)) {
      deactivateSidebarRowFocusMode();
      return;
    }
    const row = target.closest<HTMLElement>("[data-sidebar-row]");
    if (!row || !root.contains(row)) {
      deactivateSidebarRowFocusMode();
      return;
    }
    const rowKey = row.dataset.sidebarRowKey;
    if (!rowKey) {
      deactivateSidebarRowFocusMode();
      return;
    }
    activateSidebarRowFocus(rowKey);
  }, [activateSidebarRowFocus, deactivateSidebarRowFocusMode]);

  // The row a slow pointer is over lights its name; a fast sweep lights none.
  const pointerRowFocusRef = useRef(false);
  applyPointerRowFocusRef.current = (rowKey) => {
    if (rowKey !== null) {
      pointerRowFocusRef.current = true;
      activateSidebarRowFocus(rowKey);
    } else if (pointerRowFocusRef.current) {
      pointerRowFocusRef.current = false;
      deactivateSidebarRowFocusMode();
    }
  };

  const handleSidebarPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const row = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-sidebar-row]")
      : null;
    const rowKey = row && event.currentTarget.contains(row) ? row.dataset.sidebarRowKey ?? null : null;
    rowIntent.move(rowKey, event.clientX, event.clientY);
    const last = lastPointerPointRowRef.current;
    const still = last !== null && last.x === event.clientX && last.y === event.clientY;
    lastPointerPointRowRef.current = { x: event.clientX, y: event.clientY };
    if (listSlidRef.current && still) return;
    listSlidRef.current = false;
    setPointerRow(rowKey);
  }, [rowIntent, setPointerRow]);

  const handleSidebarPointerLeave = useCallback(() => {
    setPointerRow(null);
    lastPointerPointRowRef.current = null;
    pointerRowFocusRef.current = false;
    deactivateSidebarRowFocusMode();
    rowIntent.leave();
  }, [deactivateSidebarRowFocusMode, rowIntent, setPointerRow]);

  const handleSidebarFocusCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    focusSidebarRowFromTarget(event.target, event.currentTarget);
  }, [focusSidebarRowFromTarget]);

  const handleSidebarBlurCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      deactivateSidebarRowFocusMode();
    }
  }, [deactivateSidebarRowFocusMode]);

  useEffect(() => {
    if (!keyboardNavigationFocus) {
      clearSidebarKeyboardFocusTimer();
      deactivateSidebarRowFocusMode();
      return;
    }
    const rowKey = keyboardNavigationFocus.rowKey;
    const rowIsVisible = rowKey === "all"
      ? showEverythingRow
      : visibleTags.some((tc) => `tag:${tc.tag}` === rowKey);
    if (!rowIsVisible) return;

    clearSidebarKeyboardFocusTimer();
    activateSidebarRowFocus(rowKey);
    if (keyboardNavigationFocusPersistent) {
      return;
    }
    sidebarKeyboardFocusTimerRef.current = window.setTimeout(() => {
      sidebarKeyboardFocusTimerRef.current = null;
      deactivateSidebarRowFocusMode();
    }, 1000);
  }, [
    activateSidebarRowFocus,
    clearSidebarKeyboardFocusTimer,
    deactivateSidebarRowFocusMode,
    keyboardNavigationFocus?.rowKey,
    keyboardNavigationFocus?.sequence,
    keyboardNavigationFocusPersistent,
    showEverythingRow,
    visibleTags,
  ]);

  useEffect(() => () => {
    clearSidebarKeyboardFocusTimer();
  }, [clearSidebarKeyboardFocusTimer]);

  const closePreview = useCallback(() => {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    setHoveredPreview(null);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer]);

  const requestPreviewClose = useCallback(() => {
    if (hoverPreviewFrozen) return;
    closePreview();
  }, [closePreview, hoverPreviewFrozen]);

  // Tear down an already-open preview the moment a drag begins.
  useEffect(() => {
    if (isDropDragging || isTagDragging) {
      closePreview();
    }
  }, [isDropDragging, isTagDragging, closePreview]);

  const openPreview = useCallback((target: SidebarPreviewTarget) => {
    // Never reveal the hover preview while a drag is in flight — pointer-enter
    // events still fire over the sidebar during a drag-and-drop gesture.
    if (hoverPreviewFrozen) return;
    if (isDropDraggingRef.current || isTagDraggingRef.current) return;
    if (!previewTriggerRefs.current.has(target.key)) return;
    setHoveredPreview(target);
  }, [hoverPreviewFrozen]);

  const schedulePreviewOpen = useCallback((target: SidebarPreviewTarget) => {
    if (hoverPreviewFrozen) return;
    if (isDropDraggingRef.current || isTagDraggingRef.current) return;
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    setHoveredPreview(null);
    // The big preview also waits for a slow pointer (С7.10): past its delay,
    // a pointer still sweeping the row is checked again a moment later.
    const openWhenSlow = () => {
      if (rowIntent.isSlow()) {
        openPreview(target);
        return;
      }
      previewOpenTimerRef.current = window.setTimeout(() => {
        previewOpenTimerRef.current = null;
        openWhenSlow();
      }, HOVER_INTENT.velocityWindowMs);
    };
    const delay = getHoverPreviewOpenDelay(lastPreviewOpenedAtRef.current);
    if (delay <= 0) {
      openWhenSlow();
      return;
    }
    previewOpenTimerRef.current = window.setTimeout(() => {
      previewOpenTimerRef.current = null;
      openWhenSlow();
    }, delay);
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer, hoverPreviewFrozen, openPreview, rowIntent]);

  useEffect(() => {
    if (hoverPreviewFrozen) {
      clearPreviewOpenTimer();
    }
  }, [clearPreviewOpenTimer, hoverPreviewFrozen]);

  const pointerIsInsidePreviewTrigger = useCallback((target: SidebarPreviewTarget) => {
    const point = lastPointerPointRef.current;
    const trigger = previewTriggerRefs.current.get(target.key);
    if (!point || !trigger) return false;
    return pointIsInsideRect(point, trigger.getBoundingClientRect());
  }, []);

  useEffect(() => {
    const wasFrozen = previousHoverPreviewFrozenRef.current;
    previousHoverPreviewFrozenRef.current = hoverPreviewFrozen;
    if (!wasFrozen || hoverPreviewFrozen || !hoveredPreview) return;
    if (!pointerIsInsidePreviewTrigger(hoveredPreview)) {
      closePreview();
    }
  }, [closePreview, hoveredPreview, hoverPreviewFrozen, pointerIsInsidePreviewTrigger]);

  const openPreviewBlock = useCallback((target: SidebarPreviewTarget) => {
    if (!onOpenBlock) return;
    closePreview();
    void getBlock(target.slug)
      .then((block) => {
        if (block) {
          onOpenBlock(block);
        }
      })
      .catch((error) => {
        void error;
      });
  }, [closePreview, onOpenBlock]);

  const openPreviewCardMenu = useCallback((target: SidebarPreviewTarget, point: CardMenuPoint) => {
    if (!onOpenCardMenu) return;
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    void getBlock(target.slug)
      .then((block) => {
        if (block) {
          onOpenCardMenu(block, point);
        }
      })
      .catch((error) => {
        void error;
      });
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer, onOpenCardMenu]);

  useEffect(() => () => {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    clearSidebarRowSwitchFrame();
  }, [clearPreviewCloseTimer, clearPreviewOpenTimer, clearSidebarRowSwitchFrame]);

  useEffect(() => {
    if (!hoveredPreview) {
      setHoverPreviewBlock(null);
      setHoverPreviewPosition(null);
      return;
    }
    let cancelled = false;
    setHoverPreviewBlock(null);

    const trigger = previewTriggerRefs.current.get(hoveredPreview.key);
    if (trigger) {
      setHoverPreviewPosition(
        computeSidebarPreviewPosition(
          trigger.getBoundingClientRect(),
          previewRef.current?.getBoundingClientRect().height ?? SIDEBAR_PREVIEW_FALLBACK_HEIGHT,
        ),
      );
    } else {
      setHoverPreviewPosition(null);
    }

    void getBlock(hoveredPreview.slug)
      .then((block) => {
        if (cancelled) return;
        if (block) {
          lastPreviewOpenedAtRef.current = Date.now();
        }
        setHoverPreviewBlock(block);
      })
      .catch(() => {
        if (cancelled) return;
        setHoverPreviewBlock(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hoveredPreview]);

  useEffect(() => {
    if (!hoveredPreview || !hoverPreviewBlock || !hoverPreviewPosition || !previewRef.current) {
      return;
    }
    const trigger = previewTriggerRefs.current.get(hoveredPreview.key);
    if (!trigger) return;

    const nextPosition = computeSidebarPreviewPosition(
      trigger.getBoundingClientRect(),
      previewRef.current.getBoundingClientRect().height,
    );
    if (
      Math.abs(nextPosition.top - hoverPreviewPosition.top) > 1 ||
      Math.abs(nextPosition.left - hoverPreviewPosition.left) > 1
    ) {
      setHoverPreviewPosition(nextPosition);
    }
  }, [hoveredPreview, hoverPreviewBlock, hoverPreviewPosition]);

  useEffect(() => {
    if (!isLinkingBlock) {
      setLinkChromeEntered(false);
      return;
    }
    if (detailChromeClosing) {
      setLinkChromeEntered(false);
      return;
    }
    setLinkChromeEntered(false);
    const frame = window.requestAnimationFrame(() => {
      setLinkChromeEntered(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isLinkingBlock, detailChromeClosing]);

  return (
    <aside
      className={cn(
        // overflow-hidden is always on: below the minimum width the panel keeps
        // narrowing while the nav holds --sidebar-min-width, so the right edge
        // clips the frozen menu like a curtain.
        // bg-sidebar also re-bases --surface for the zone, so every fill and
        // hover inside the panel lifts from the sidebar surface, not the page.
        "relative flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar",
      )}
      style={{
        width: "var(--sidebar-width)",
        transition: isResizing ? "none" : "width 200ms ease",
      }}
    >
      {isLinkingBlock && showLinkModeChrome && (
        <SidebarLinkModeSwitch
          value={effectiveLinkMode}
          entered={linkChromeEntered}
          onChange={(mode) => {
            setUncontrolledLinkMode(mode);
            onLinkModeChange?.(mode);
          }}
        />
      )}
      {/* Navigation. The wrapper exists so the fade band can be a sibling of
          the scrollport: inside the nav it would inherit its padding and settle
          below the real top edge. */}
      {/* Matches the nav's frozen min-width: the band is sized by this wrapper,
          and a narrower wrapper would leave the right edge of the rows
          uncovered as the panel is resized down. */}
      <div className="relative flex min-h-0 min-w-[var(--sidebar-min-width)] flex-1 flex-col">
      <nav
        ref={topFade.ref}
        className={cn(
          // min-width freezes the menu at the three-equal-columns layout: below
          // it the nav keeps this width and the panel's overflow-hidden clips it.
          "relative min-w-[var(--sidebar-min-width)] flex-1 overflow-y-auto",
          "pb-8",
          // Table insets are design-variant metrics: the alt design pulls the
          // table flush to the divider and edges, rows get inner padding.
          compact
            ? "px-2 pt-8"
            : "px-[var(--sidebar-nav-pad-x)] pt-[var(--sidebar-nav-pad-top)]",
        )}
        data-sidebar-scroll
        data-sidebar-tag-dragging={isTagDragging ? "true" : undefined}
        data-sidebar-top-fade={topFade.scrolled ? "true" : undefined}
        data-sidebar-link-editor-mode={isLinkEditorActive ? "true" : undefined}
        data-sidebar-row-hover-seam={SIDEBAR_ROW_HOVER_SEAM_ENABLED ? "true" : "false"}
        data-sidebar-row-focus-mode={hasSidebarRowFocusMode ? "true" : undefined}
        data-sidebar-row-switching={sidebarRowSwitching ? "true" : undefined}
        onPointerMove={handleSidebarPointerMove}
        onPointerLeave={handleSidebarPointerLeave}
        onScroll={() => {
          // The list slid under the pointer: the next real move names the row.
          listSlidRef.current = true;
          setPointerRow(null);
          rowIntent.displace();
        }}
        onFocusCapture={handleSidebarFocusCapture}
        onBlurCapture={handleSidebarBlurCapture}
      >
        <HoverIntentDragWatch intent={rowIntent} />
        {!isLinkingBlock && headerSlot}

        <div className="relative" data-sidebar-rows>
          {!compact && (
            <div className="pointer-events-none absolute inset-0" data-sidebar-guidelines>
              <span
                aria-hidden="true"
                data-sidebar-guideline="left"
                className="absolute inset-y-0 w-px bg-sidebar-border"
                style={{ left: "calc(var(--sidebar-row-pad-x) + var(--sidebar-name-col))" }}
              />
              <span
                aria-hidden="true"
                data-sidebar-guideline="right"
                className="absolute inset-y-0 w-px bg-sidebar-border"
                style={{ right: "var(--sidebar-zone)" }}
              />
            </div>
          )}

          {showEverythingRow && (
            <NavItem
              to="/"
              label="Everything"
              count={totalBlocks}
              cards={channelPreviews.get("__all__")}
              previewsPending={previewsPending}
              previewKeyPrefix="all"
              onPreviewEnter={schedulePreviewOpen}
              onPreviewLeave={requestPreviewClose}
              onPreviewClick={openPreviewBlock}
              onPreviewContextMenu={openPreviewCardMenu}
              onPreviewTriggerRef={setPreviewTriggerRef}
              activePreviewKey={hoveredPreview?.key ?? null}
              compact={compact}
              end
              onClick={onNavClick}
              onSameClick={isLinkEditorActive ? onNavClick : onScrollToTop}
              rowKey="all"
              isSidebarRowFocused={effectiveSidebarRowFocusKey === "all"}
              isSidebarRowSeamAccent={seamAccentKeys.has("all")}
              staticConnected={isLinkEditorActive || isSelectionEditorActive}
            />
          )}

          {/* A new collection is named at the top of the list, under
              Everything, and takes the first place there. The list parts to
              make room for the row, quickly (global.css, data-sidebar-row-part). */}
          {showCreateRow && (
            <div data-sidebar-row-part=""><div>
            <NewChannelRow
              compact={compact}
              isEditing={isCreatingChannel}
              // A filter typed before the plus becomes the new name's start.
              defaultName={searchQuery.trim()}
              isSidebarRowFocused={effectiveSidebarRowFocusKey === "create-channel"}
              isSidebarRowSeamAccent={seamAccentKeys.has("create-channel")}
              onStartCreate={() => onSetCreatingChannel(true)}
              onCreate={(value) => {
                onCreateChannel(value);
                onSetCreatingChannel(false);
              }}
              onCancel={() => onSetCreatingChannel(false)}
            />
            </div></div>
          )}

          <SortableContext
            items={visibleTags.map((tc) => `tag:${tc.tag}`)}
            strategy={verticalListSortingStrategy}
          >
            {visibleTags.map((tc) => {
              const checked = linkedTagSet.has(tc.tag);
              return (
                <TagNavItem
                  key={tc.tag}
                  to={`/channel/${encodeURIComponent(tc.tag)}`}
                  label={collectionRefLabel(tc.tag)}
                  count={tc.count}
                  tag={tc.tag}
                  cards={channelPreviews.get(tc.tag)}
                  previewsPending={previewsPending}
                  previewKeyPrefix={`tag:${tc.tag}`}
                  onPreviewEnter={schedulePreviewOpen}
                  onPreviewLeave={requestPreviewClose}
                  onPreviewClick={openPreviewBlock}
                  onPreviewContextMenu={openPreviewCardMenu}
                  onPreviewTriggerRef={setPreviewTriggerRef}
                  activePreviewKey={hoveredPreview?.key ?? null}
                  compact={compact}
                  isDropDragging={isDropDragging}
                  isEditing={!isLinkEditorActive && editingTag === tc.tag}
                  linkEditor={isLinkEditorActive ? {
                    checked,
                    onToggle: () => onToggleLinkedTag(linkedBlockSlug, tc.tag, checked),
                  } : selectionLinkEditor(tc.tag)}
                  onDoubleClick={startRenamingTag}
                  onRenameSubmit={handleRename}
                  onRenameCancel={cancelRenamingTag}
                  onDelete={onDeleteTag}
                  onClick={onNavClick}
                  onSameClick={isLinkEditorActive ? undefined : onScrollToTop}
                  rowKey={`tag:${tc.tag}`}
                  isIntentRow={intentRowKey === `tag:${tc.tag}`}
                  isSidebarRowFocused={effectiveSidebarRowFocusKey === `tag:${tc.tag}`}
                  isSidebarRowSeamAccent={seamAccentKeys.has(`tag:${tc.tag}`)}
                />
              );
            })}
          </SortableContext>

        </div>


      </nav>
      <TopFadeScrim scrolled={topFade.scrolled} surface="sidebar" color="var(--sidebar)" />
      </div>

      {vaultPath
        && hoverPreviewPosition
        && hoverPreviewBlock && (
          <div
            ref={previewRef}
            className="pointer-events-none fixed z-50"
            style={{
              top: hoverPreviewPosition.top,
              left: hoverPreviewPosition.left,
              width: SIDEBAR_PREVIEW_WIDTH,
            }}
            data-sidebar-thumbnail-hover-preview
          >
            <ReadOnlyCardPreview
              block={hoverPreviewBlock}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath}
              width={SIDEBAR_PREVIEW_WIDTH}
              previewMode="micro"
            />
          </div>
      )}

    </aside>
  );
});

// ─── Components ──────────────────────────────────────────────────────────────

function scrollActiveSidebarItemIntoView(nav: HTMLElement, active: HTMLElement) {
  const navRect = nav.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const style = getComputedStyle(nav);
  const topInset = parseFloat(style.paddingTop) || 0;
  const bottomInset = parseFloat(style.paddingBottom) || 0;
  const topLimit = navRect.top + topInset;
  const bottomLimit = navRect.bottom - bottomInset;

  let nextTop = nav.scrollTop;
  if (activeRect.top < topLimit) {
    nextTop -= topLimit - activeRect.top;
  } else if (activeRect.bottom > bottomLimit) {
    nextTop += activeRect.bottom - bottomLimit;
  } else {
    return;
  }

  if (typeof nav.scrollTo === "function") {
    nav.scrollTo({ top: Math.max(0, nextTop), behavior: scrollBehavior() });
  } else {
    nav.scrollTop = Math.max(0, nextTop);
  }
}

function computeSidebarPreviewPosition(
  triggerRect: DOMRect,
  previewHeight: number,
): SidebarPreviewPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(
    SIDEBAR_PREVIEW_VIEWPORT_MARGIN,
    Math.min(
      triggerRect.left,
      viewportWidth - SIDEBAR_PREVIEW_VIEWPORT_MARGIN - SIDEBAR_PREVIEW_WIDTH,
    ),
  );
  const canOpenDown =
    triggerRect.bottom + SIDEBAR_PREVIEW_GAP + previewHeight <=
    viewportHeight - SIDEBAR_PREVIEW_VIEWPORT_MARGIN;
  const top = canOpenDown
    ? triggerRect.bottom + SIDEBAR_PREVIEW_GAP
    : Math.max(
        SIDEBAR_PREVIEW_VIEWPORT_MARGIN,
        triggerRect.top - SIDEBAR_PREVIEW_GAP - previewHeight,
      );
  return { top, left };
}

function clientPointFromEvent(event: Event): CardMenuPoint | null {
  if (!(event instanceof MouseEvent)) return null;
  return { x: event.clientX, y: event.clientY };
}

function pointIsInsideRect(point: CardMenuPoint, rect: DOMRect): boolean {
  return point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom;
}

const SidebarLinkModeSwitch = memo(function SidebarLinkModeSwitch({
  value,
  entered,
  onChange,
}: {
  value: "all" | "linked";
  entered: boolean;
  onChange: (value: "all" | "linked") => void;
}) {
  const label = (
    <span className="shrink-0 font-mono text-sm text-muted-foreground">
      Collections:
    </span>
  );
  const control = (
    <SegmentedControl
      value={value}
      options={SIDEBAR_LINK_MODE_OPTIONS}
      onChange={onChange}
      aria-label="Collection filter"
      data-sidebar-link-mode-control
    />
  );

  return (
    <div
      className={cn(
        "detail-top-bar-enter absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-2 px-8",
        "bg-accent",
      )}
      data-entered={entered ? "true" : "false"}
      data-sidebar-link-mode-bar
    >
      {label}
      {control}
      <span
        aria-hidden="true"
        data-entered={entered ? "true" : "false"}
        className="detail-top-bar-line-enter pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
      />
    </div>
  );
});

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

type SidebarRowFrameProps = {
  /** A slow pointer is on this row (SPEC_CARD_STATES.md, С7.10). */
  isIntentRow?: boolean;
  compact?: boolean;
  rowKey: string;
  isCurrentRoute: boolean;
  isLinked?: boolean;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  surface?: boolean;
  isEditing?: boolean;
  className?: string;
  style?: CSSProperties;
  nodeRef?: (node: HTMLDivElement | null) => void;
  textDropTag?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "style" | "className">;

const SidebarRowFrame = forwardRef<HTMLDivElement, SidebarRowFrameProps>(function SidebarRowFrame({
  isIntentRow = false,
  compact,
  rowKey,
  isCurrentRoute,
  isLinked = false,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  surface,
  isEditing = false,
  className,
  style,
  nodeRef,
  textDropTag,
  children,
  ...domProps
}, forwardedRef) {
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    assignRef(forwardedRef, node);
    nodeRef?.(node);
  }, [forwardedRef, nodeRef]);
  const hasSurface = surface ?? !compact;

  return (
    <div
      id={sidebarRowDomId(rowKey)}
      ref={setRefs}
      style={style}
      {...domProps}
      // A slow pointer is on this row (С7.10): its button shows.
      data-sidebar-row-intent={isIntentRow ? "true" : undefined}
      data-sidebar-row=""
      data-sidebar-row-surface={hasSurface ? "" : undefined}
      data-sidebar-row-key={rowKey}
      data-sidebar-row-active={isCurrentRoute ? "true" : undefined}
      data-sidebar-row-linked={isLinked ? "true" : undefined}
      data-sidebar-row-focused={isSidebarRowFocused ? "true" : undefined}
      data-sidebar-row-seam-accent={!compact && isSidebarRowSeamAccent ? "true" : undefined}
      data-sidebar-row-editing={isEditing ? "true" : undefined}
      data-sidebar-text-drop-tag={textDropTag}
      className={cn(
        "group relative rounded-1",
        isEditing && "z-10 bg-sidebar",
        className,
      )}
    >
      {children}
    </div>
  );
});

function SidebarRowTitleCell({
  compact,
  children,
  className,
}: {
  compact?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-sidebar-row-text=""
      data-sidebar-title-fade-width={compact ? undefined : String(SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH)}
      data-sidebar-title-protected-width={compact ? undefined : String(SIDEBAR_PREVIEW_DIVIDER_GAP)}
      className={cn(
        compact
          ? "flex-1 truncate"
          : "w-[var(--sidebar-name-col)] shrink-0 translate-x-px overflow-hidden whitespace-nowrap",
        className,
      )}
      style={compact ? undefined : SIDEBAR_ROW_TEXT_MASK_STYLE}
    >
      {children}
    </span>
  );
}

function SidebarPreviewRail({ children }: { children: ReactNode }) {
  return (
    <div
      // The floor matches the other columns' keystone: the previews may not
      // drop below it whatever width the panel is dragged to.
      className="relative min-w-[var(--sidebar-col-floor)] flex-1"
      data-sidebar-preview-rail
      // Measured from the far edge of the guideline, not from the column it
      // closes: the line owns its pixel, the gap follows it.
      style={{ paddingLeft: `${SIDEBAR_PREVIEW_DIVIDER_GAP + 1}px` }}
    >
      {children}
    </div>
  );
}

function SidebarRowBody({
  to,
  end,
  label,
  count,
  cards,
  previewsPending,
  previewKeyPrefix,
  rowKey,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  activePreviewKey,
  compact,
  isCurrentRoute,
  isDragging = false,
  isDropDragging = false,
  onClick,
  onSameClick,
  onDoubleClick,
  linkEditor,
  staticConnected = false,
}: {
  to: string;
  end?: boolean;
  label: string;
  count: number;
  /** `undefined` until the preview read has answered for this row. */
  cards: PreviewCard[] | undefined;
  /** The space's previews are still being built; see `SidebarProps`. */
  previewsPending: boolean;
  previewKeyPrefix: string;
  rowKey: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  compact?: boolean;
  isCurrentRoute: boolean;
  isDragging?: boolean;
  isDropDragging?: boolean;
  onClick?: () => void;
  onSameClick?: () => void;
  onDoubleClick?: () => void;
  linkEditor?: SidebarRowLinkEditor;
  staticConnected?: boolean;
}) {
  const isLinkEditor = !!linkEditor;
  // The expanded card's editor locks the row; the selection's editor (С6) does not.
  const isCardLinkEditor = isLinkEditor && !linkEditor.forSelection;
  // The button stays shown when the collection holds the card, or some of the
  // selected cards; otherwise it appears on hover over the count.
  const linkButtonPinned = !!linkEditor && (linkEditor.checked || linkEditor.partial !== undefined);
  // A reference `Connected` replaces the count: always for Everything in an
  // expanded card (С5), and in the feed for the collections of the card under
  // the pointer (С4). The link editor's own buttons keep that place otherwise.
  const connectedToHoveredCard = useRowConnectedToHoveredCard(rowKey);
  const showConnectedPill = !compact && (staticConnected || (!isLinkEditor && connectedToHoveredCard));
  const openElsewhere = useContext(SidebarOpenElsewhereContext);
  const handleNavLinkClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (isDragging || isDropDragging) {
      e.preventDefault();
      return;
    }
    // ⌘ opens the row's route in a new tab, with ⇧ in a new window (В82).
    if (e.metaKey && openElsewhere) {
      e.preventDefault();
      openElsewhere(to, e.shiftKey);
      return;
    }
    if (isCurrentRoute && onSameClick) {
      e.preventDefault();
      onSameClick();
    } else {
      onClick?.();
    }
  };
  const handleNavLinkDoubleClick = onDoubleClick ? (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (isCardLinkEditor) return;
    e.preventDefault();
    onDoubleClick();
  } : undefined;

  return (
    <>
      <NavLink
        to={to}
        end={end}
        draggable="false"
        onClick={handleNavLinkClick}
        onDoubleClick={handleNavLinkDoubleClick}
        className={() =>
          compact
            ? cn(
                "flex w-full items-center gap-2 overflow-hidden text-base",
                "rounded-1 p-2",
                "text-muted-foreground",
              )
            : cn(
                SIDEBAR_ROW_BOX_CLASS,
                "font-sans text-base text-muted-foreground",
                // Inner row padding is a design-variant metric (alt: 16px so
                // text and count do not touch the divider and screen edge).
                "pl-[var(--sidebar-row-pad-x)]",
              )
        }
      >
        <SidebarRowTitleCell compact={compact}>
          {label}
        </SidebarRowTitleCell>
        {!compact && (
          <SidebarPreviewRail>
            <SidebarPreviewStrip
              cards={cards}
              count={count}
              previewsPending={previewsPending}
              previewKeyPrefix={previewKeyPrefix}
              rowKey={rowKey}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewContextMenu={onPreviewContextMenu}
              onPreviewTriggerRef={onPreviewTriggerRef}
              activePreviewKey={activePreviewKey}
              allowHoverPreview
            />
          </SidebarPreviewRail>
        )}
        {compact && isLinkEditor && (
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-end text-right">
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-center justify-end text-sm transition-opacity duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                "font-mono",
                "text-muted-foreground",
                !compact && "-translate-x-px",
                linkButtonPinned
                  ? "opacity-0"
                  : ROW_INTENT_HIDES,
              )}
              data-sidebar-row-text=""
            >
              {count || ""}
            </span>
          </div>
        )}
        {compact && !isLinkEditor && (
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-end text-right">
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-center justify-end text-sm",
                "font-mono",
                "text-muted-foreground",
                !compact && "-translate-x-px",
              )}
              data-sidebar-row-text=""
            >
              {count || ""}
            </span>
          </div>
        )}
        {!compact && (
          <span
            className={cn(
              "absolute inset-y-0 right-[var(--sidebar-row-pad-x)] flex w-8 items-center justify-end text-right text-sm font-mono text-muted-foreground",
              "-translate-x-px",
              isLinkEditor
                ? cn(
                    ROW_INTENT_FADE,
                    linkButtonPinned
                      ? "opacity-0"
                      : ROW_INTENT_HIDES,
                  )
                : cn(ROW_INTENT_FADE, showConnectedPill ? cn("opacity-0", ANSWER_ON) : cn("opacity-100", ANSWER_OFF)),
            )}
            data-sidebar-row-text=""
          >
            {count || ""}
          </span>
        )}
      </NavLink>
      {!compact && (
        // Always mounted: pill and count cross-fade in place instead of
        // popping in and out (С7.6).
        <span
          className={cn(
            SIDEBAR_ROW_CONNECTED_PILL_CLASS,
            ROW_INTENT_FADE,
            "absolute top-1/2 z-10 -translate-y-1/2",
            showConnectedPill ? cn("opacity-100", ANSWER_ON) : cn("opacity-0", ANSWER_OFF),
          )}
          style={{
            right: SIDEBAR_ROW_ACTION_BUTTON_INSET,
            width: SIDEBAR_ROW_ACTION_BUTTON_WIDTH,
          }}
          aria-hidden={showConnectedPill ? undefined : true}
          data-sidebar-row-connected-pill=""
          data-state={showConnectedPill ? "on" : "off"}
        >
          Connected
        </span>
      )}
      {linkEditor && (
        <button
          type="button"
          data-sidebar-link-action
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            linkEditor.onToggle();
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          className={cn(
            SIDEBAR_ROW_ACTION_BUTTON_CLASS,
            "absolute top-1/2 z-10 -translate-y-1/2",
            ROW_INTENT_FADE,
            linkButtonPinned
              ? "opacity-100"
              : cn(
                  ROW_INTENT_SHOWS,
                  "pointer-events-none group-data-[sidebar-row-intent=true]:pointer-events-auto group-focus-within:pointer-events-auto",
                ),
          )}
          style={{
            right: SIDEBAR_ROW_ACTION_BUTTON_INSET,
            width: SIDEBAR_ROW_ACTION_BUTTON_WIDTH,
          }}
          aria-label={`${linkEditor.checked ? "Disconnect" : "Connect"} ${label}`}
        >
          {linkEditor.checked ? (
            <span className={ROW_INTENT_LABEL_STACK}>
              <span className={cn(ROW_INTENT_FADE, ROW_INTENT_HIDES)}>Connected</span>
              <span className={cn(ROW_INTENT_FADE, ROW_INTENT_SHOWS, "text-detach")}>Disconnect</span>
            </span>
          ) : linkEditor.partial !== undefined ? (
            <span className={ROW_INTENT_LABEL_STACK}>
              <span className={cn(ROW_INTENT_FADE, ROW_INTENT_HIDES, "font-mono font-normal")} data-sidebar-link-partial="">
                {linkEditor.partial}
              </span>
              <span className={cn(ROW_INTENT_FADE, ROW_INTENT_SHOWS)}>Connect</span>
            </span>
          ) : (
            "Connect"
          )}
        </button>
      )}
    </>
  );
}

function SidebarEditableRowBody({
  defaultValue,
  placeholder,
  ariaLabel,
  compact,
  submitAction,
  onSubmit,
  onCancel,
}: {
  defaultValue: string;
  placeholder: string;
  ariaLabel: string;
  compact?: boolean;
  submitAction?: {
    label: string;
    shortcut: string;
    shortcutKey: string;
  };
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={
        compact
          ? cn(
              "flex w-full items-center overflow-hidden text-base",
              "rounded-1 p-2",
              "text-muted-foreground",
            )
          : cn(SIDEBAR_ROW_BOX_CLASS, "pl-[var(--sidebar-row-pad-x)] font-sans text-base text-muted-foreground")
      }
      data-sidebar-editable-row-body
      data-sidebar-editable-row-full-width
    >
      {submitAction && !compact && (
        // The list's right zone runs through this row too: the guideline the
        // other rows show, the submit button inside the zone.
        <span
          aria-hidden="true"
          data-sidebar-editable-row-guideline=""
          className="pointer-events-none absolute inset-y-0 w-px bg-sidebar-border"
          style={{ right: "var(--sidebar-zone)" }}
        />
      )}
      <InlineChannelNameEditor
        defaultValue={defaultValue}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        submitAction={submitAction}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </div>
  );
}

const NavItem = memo(function NavItem({
  to,
  label,
  count,
  cards,
  previewsPending,
  previewKeyPrefix,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  activePreviewKey,
  compact,
  end,
  onClick,
  onSameClick,
  rowKey,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  staticConnected = false,
}: {
  to: string;
  label: string;
  count: number;
  /** `undefined` until the preview read has answered for this row. */
  cards: PreviewCard[] | undefined;
  /** The space's previews are still being built; see `SidebarProps`. */
  previewsPending: boolean;
  previewKeyPrefix: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  compact?: boolean;
  end?: boolean;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  /** Everything while a card is expanded: connected, and nothing can change that. */
  staticConnected?: boolean;
}) {
  const loc = useLocation();
  const isCurrentRoute = end ? loc.pathname === to : loc.pathname.startsWith(to);

  return (
    <SidebarRowFrame
      compact={compact}
      rowKey={rowKey}
      isCurrentRoute={isCurrentRoute}
      isSidebarRowFocused={isSidebarRowFocused}
      isSidebarRowSeamAccent={isSidebarRowSeamAccent}
    >
      <SidebarRowBody
        to={to}
        end={end}
        label={label}
        count={count}
        cards={cards}
        previewsPending={previewsPending}
        previewKeyPrefix={previewKeyPrefix}
        rowKey={rowKey}
        onPreviewEnter={onPreviewEnter}
        onPreviewLeave={onPreviewLeave}
        onPreviewClick={onPreviewClick}
        onPreviewContextMenu={onPreviewContextMenu}
        onPreviewTriggerRef={onPreviewTriggerRef}
        activePreviewKey={activePreviewKey}
        compact={compact}
        isCurrentRoute={isCurrentRoute}
        onClick={onClick}
        onSameClick={onSameClick}
        staticConnected={staticConnected}
      />
    </SidebarRowFrame>
  );
});

const TagNavItem = memo(function TagNavItem({
  to,
  label,
  count,
  tag,
  cards,
  previewsPending,
  previewKeyPrefix,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  activePreviewKey,
  compact,
  isDropDragging,
  isEditing,
  linkEditor,
  onDoubleClick,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
  onClick,
  onSameClick,
  rowKey,
  isIntentRow = false,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
}: {
  to: string;
  label: string;
  count: number;
  tag: string;
  /** `undefined` until the preview read has answered for this row. */
  cards: PreviewCard[] | undefined;
  /** The space's previews are still being built; see `SidebarProps`. */
  previewsPending: boolean;
  previewKeyPrefix: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  compact?: boolean;
  isDropDragging: boolean;
  isEditing: boolean;
  linkEditor?: SidebarRowLinkEditor;
  onDoubleClick: (tag: string) => void;
  onRenameSubmit: (tag: string, value: string) => void;
  onRenameCancel: () => void;
  onDelete: (tag: string) => void;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isIntentRow?: boolean;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
}) {
  const location = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isLinkEditor = !!linkEditor;
  // The parent hands out one callback for every row; each row binds its own tag.
  const startRename = useCallback(() => onDoubleClick(tag), [onDoubleClick, tag]);
  const submitRename = useCallback(
    (value: string) => onRenameSubmit(tag, value),
    [onRenameSubmit, tag],
  );
  const deleteTag = useCallback(() => onDelete(tag), [onDelete, tag]);
  const isCurrentRoute = location.pathname === to || location.pathname.startsWith(`${to}/`);

  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `tag:${tag}` });

  // No `content-visibility` here. Drag-and-drop needs every row's real
  // geometry, and skipped content reports the intrinsic placeholder instead —
  // dnd-kit then sorts against sizes that do not match the screen. A list of
  // collections is tens of rows, not thousands; the render it saved was never
  // worth the geometry it broke.
  //
  // The dragged row keeps its transform and turns invisible: it is the moving
  // hole that shows where the drop will land, while the visible copy travels in
  // the DragOverlay. A translucent ghost left at the origin reads as a second
  // row that belongs to no one.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  if (isEditing) {
    return (
      <SidebarRowFrame
        compact={compact}
        rowKey={rowKey}
        isIntentRow={isIntentRow}
        isCurrentRoute={isCurrentRoute}
        isLinked={linkEditor?.checked}
        isSidebarRowFocused={isSidebarRowFocused}
        isSidebarRowSeamAccent={isSidebarRowSeamAccent}
        isEditing
        className={cn(
          isDragging && "pointer-events-none opacity-0",
        )}
        style={style}
        nodeRef={setNodeRef}
        textDropTag={tag}
      >
        <SidebarEditableRowBody
          defaultValue={label}
          placeholder={label}
          ariaLabel={`Переименовать ${label}`}
          compact={compact}
          onSubmit={submitRename}
          onCancel={onRenameCancel}
        />
      </SidebarRowFrame>
    );
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarRowFrame
            compact={compact}
            rowKey={rowKey}
            isIntentRow={isIntentRow}
            isCurrentRoute={isCurrentRoute}
            isLinked={linkEditor?.checked}
            isSidebarRowFocused={isSidebarRowFocused}
            isSidebarRowSeamAccent={isSidebarRowSeamAccent}
            className={cn(
              isDragging && "pointer-events-none opacity-0",
            )}
            style={style}
            nodeRef={setNodeRef}
            textDropTag={tag}
            {...(!isLinkEditor || linkEditor.forSelection ? attributes : {})}
            {...(!isLinkEditor || linkEditor.forSelection ? listeners : {})}
          >
            <SidebarRowBody
              to={to}
              label={label}
              count={count}
              cards={cards}
              previewsPending={previewsPending}
              previewKeyPrefix={previewKeyPrefix}
              rowKey={rowKey}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewContextMenu={onPreviewContextMenu}
              onPreviewTriggerRef={onPreviewTriggerRef}
              activePreviewKey={activePreviewKey}
              compact={compact}
              isCurrentRoute={isCurrentRoute}
              isDragging={isDragging}
              isDropDragging={isDropDragging}
              onClick={onClick}
              onSameClick={onSameClick}
              onDoubleClick={startRename}
              linkEditor={linkEditor}
            />
          </SidebarRowFrame>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={startRename}>
            <Pencil className="size-[13px]" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="size-[13px]" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete channel</AlertDialogTitle>
            <AlertDialogDescription>
              Remove tag &ldquo;{label}&rdquo; from all cards. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteTag}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});

function NewChannelRow({
  compact,
  isEditing,
  defaultName,
  isSidebarRowFocused,
  isSidebarRowSeamAccent,
  onStartCreate,
  onCreate,
  onCancel,
}: {
  compact?: boolean;
  isEditing: boolean;
  defaultName: string;
  isSidebarRowFocused: boolean;
  isSidebarRowSeamAccent: boolean;
  onStartCreate: () => void;
  onCreate: (value: string) => void;
  onCancel: () => void;
}) {
  const { setNodeRef } = useDroppable({
    id: "create-channel",
    disabled: isEditing,
  });

  return (
    <SidebarRowFrame
      compact={compact}
      rowKey="create-channel"
      isCurrentRoute={false}
      isSidebarRowFocused={isSidebarRowFocused}
      isSidebarRowSeamAccent={isSidebarRowSeamAccent}
      surface={isEditing && !compact}
      isEditing={isEditing}
      nodeRef={setNodeRef}
      data-sidebar-new-channel-row=""
    >
      {isEditing ? (
        <SidebarEditableRowBody
          defaultValue={defaultName}
          placeholder=""
          ariaLabel="Имя нового канала"
          compact={compact}
          // The key's label comes from the one key table the bottom bar uses.
          submitAction={{ label: "Create", shortcut: bindingLabel({ key: "Enter" }), shortcutKey: "Enter" }}
          onSubmit={onCreate}
          onCancel={onCancel}
        />
      ) : (
        <button
          type="button"
          className="block w-full text-left"
          onClick={onStartCreate}
        >
          <SidebarCreateChannelRowBody
            compact={compact}
            isEditing={false}
          />
        </button>
      )}
    </SidebarRowFrame>
  );
}

function SidebarCreateChannelRowBody({
  compact,
  isEditing,
}: {
  compact?: boolean;
  isEditing: boolean;
}) {
  return (
    <div
      className={
        compact
          ? cn(
              "flex w-full items-center gap-2 overflow-hidden rounded-1 p-2 font-sans text-base text-muted-foreground",
              // A slow pointer lights it like any row (С7.10); the keyboard at once.
              !isEditing && "group-focus-within:text-foreground",
            )
          : cn(
              SIDEBAR_ROW_BOX_CLASS,
              "pl-[var(--sidebar-row-pad-x)] font-sans text-base text-muted-foreground",
              // A slow pointer lights it like any row (С7.10); the keyboard at once.
              !isEditing && "group-focus-within:text-foreground",
            )
      }
      data-sidebar-create-channel-row-body
    >
      <span
        data-sidebar-row-text=""
        className="shrink-0 whitespace-nowrap text-left"
      >
        Create New Collection
      </span>
      <Plus
        aria-hidden="true"
        data-sidebar-create-channel-plus=""
        className={cn(
          "ml-2 size-4 shrink-0 text-muted-foreground",
          isEditing && "opacity-0",
        )}
      />
      <span className="min-w-0 flex-1" aria-hidden="true" />
    </div>
  );
}

/// How many placeholder tiles a row draws while its thumbnails are on the way:
/// one per card not shown yet, up to what the strip holds. `shown` is the
/// number of real thumbnails already in the strip; they keep the first slots
/// and the placeholders fill the rest. A row with no cards draws none.
function sidebarPreviewPlaceholderCount(count: number, shown: number): number {
  return Math.max(0, Math.min(count, SIDEBAR_PREVIEW_SLOTS) - shown);
}

function SidebarPreviewStrip({
  cards,
  count,
  previewsPending = false,
  previewKeyPrefix,
  rowKey,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  activePreviewKey,
  allowHoverPreview = false,
}: {
  /** `undefined` until the preview read has answered for this row. */
  cards: PreviewCard[] | undefined;
  /** The row's card count; sizes the placeholder run while thumbnails are on the way. */
  count: number;
  /** The space's previews are still being built; see `SidebarProps`. */
  previewsPending?: boolean;
  previewKeyPrefix: string;
  rowKey: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  allowHoverPreview?: boolean;
}) {
  // The count reaches the row before the thumbnails do (startup, a space
  // opening). Until they arrive the strip holds placeholder tiles in the
  // thumbnails' own boxes rather than standing empty; the strip element itself
  // stays the same, so its width, gap and fade never move. While the space's
  // previews are still being built, the read answers with only the thumbnails
  // that exist, so the strip keeps placeholders after them for the cards still
  // waiting: each new thumbnail takes the next slot in place of one.
  const pending = cards === undefined;
  const thumbnails = pending ? [] : cards.filter((card) => card.hasThumb);
  const placeholderCount = pending || previewsPending
    ? sidebarPreviewPlaceholderCount(count, thumbnails.length)
    : 0;
  return (
    <div
      data-sidebar-thumbnail-strip=""
      data-sidebar-previews={pending ? "pending" : "ready"}
      data-sidebar-preview-fade-width={String(SIDEBAR_PREVIEW_MASK_FADE_WIDTH)}
      data-sidebar-preview-protected-tail={SIDEBAR_PREVIEW_MASK_CLEAR_TAIL}
      className="flex h-8 min-w-0 flex-1 items-end gap-1 overflow-hidden"
      style={SIDEBAR_PREVIEW_MASK_STYLE}
    >
      {thumbnails.map((card, index) => {
        const previewKey = `${previewKeyPrefix}:${card.slug ?? index}:${index}`;
        const canPreview = allowHoverPreview
          && card.hasThumb
          && !!card.slug;
        const isPreviewActive = activePreviewKey === previewKey;
        return (
          <div
            key={previewKey}
            ref={(node) => {
              if (canPreview) {
                onPreviewTriggerRef(previewKey, node);
              }
            }}
            className={cn(
              SIDEBAR_PREVIEW_TILE_CLASS,
              canPreview &&
                "outline-0 outline-transparent hover:outline-1 hover:-outline-offset-1 hover:outline-component-fill-hover",
              isPreviewActive &&
                "outline-1 -outline-offset-1 outline-component-fill-hover",
            )}
            onPointerEnter={() => {
              if (card.slug && canPreview) {
                onPreviewEnter({ key: previewKey, rowKey, slug: card.slug });
              }
            }}
            onPointerLeave={() => {
              if (canPreview) {
                onPreviewLeave();
              }
            }}
            onClick={(event) => {
              if (!card.slug || !canPreview) return;
              event.preventDefault();
              event.stopPropagation();
              onPreviewClick({ key: previewKey, rowKey, slug: card.slug });
            }}
            onContextMenu={(event) => {
              if (!card.slug || !canPreview || !onPreviewContextMenu) return;
              event.preventDefault();
              event.stopPropagation();
              onPreviewContextMenu(
                { key: previewKey, rowKey, slug: card.slug },
                { x: event.clientX, y: event.clientY },
              );
            }}
            onPointerDown={(event) => {
              if (canPreview) {
                event.stopPropagation();
              }
            }}
            data-sidebar-preview-thumbnail={canPreview ? "trigger" : "placeholder"}
            data-sidebar-preview-active={isPreviewActive ? "true" : undefined}
          >
            <MicroPreviewThumbnail
              preview={microPreviewFromPreviewCard(card)}
              loading="lazy"
              draggable={false}
            />
          </div>
        );
      })}
      {Array.from({ length: placeholderCount }, (_, index) => (
        <div
          key={`placeholder:${index}`}
          aria-hidden="true"
          className={SIDEBAR_PREVIEW_TILE_CLASS}
          data-sidebar-preview-placeholder=""
        />
      ))}
    </div>
  );
}

function InlineChannelNameEditor({
  placeholder,
  defaultValue = "",
  ariaLabel,
  submitAction,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  defaultValue?: string;
  ariaLabel: string;
  submitAction?: {
    label: string;
    /** The key as every hotkey in the interface writes it (`bindingLabel`). */
    shortcut: string;
    /** The key's name for assistive technology (`aria-keyshortcuts`). */
    shortcutKey: string;
  };
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  const doSubmit = (value: string) => {
    if (submitted.current) return;
    submitted.current = true;
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <div
      className="flex w-full min-w-0 items-center gap-3"
      // With a submit button the name ends before the right zone, where the
      // button stands.
      style={submitAction ? { paddingRight: `calc(var(--sidebar-zone) + 1px + ${SIDEBAR_ROW_ACTION_BUTTON_GAP}px)` } : undefined}
      data-sidebar-inline-channel-editor-row
    >
      <input
        ref={ref}
        type="text"
        aria-label={ariaLabel}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="block h-5 min-w-0 flex-1 translate-x-px border-0 bg-transparent p-0 font-sans text-base leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:outline-none focus:ring-0"
        data-sidebar-inline-channel-editor=""
        onClick={(e) => {
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            doSubmit((e.target as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            submitted.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => doSubmit(e.target.value)}
      />
      {submitAction && (
        <button
          type="button"
          aria-label={submitAction.label}
          aria-keyshortcuts={submitAction.shortcutKey}
          // Placed like a row's Connect button: 8px from the zone's edges,
          // the zone's width less those 8px on both sides.
          className={cn(
            SIDEBAR_ROW_ACTION_BUTTON_CLASS,
            "absolute top-1/2 z-10 -translate-y-1/2 gap-[1ch] px-[1ch]",
          )}
          style={{
            right: SIDEBAR_ROW_ACTION_BUTTON_INSET,
            width: SIDEBAR_ROW_ACTION_BUTTON_WIDTH,
          }}
          data-sidebar-inline-submit-action=""
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            doSubmit(ref.current?.value ?? "");
          }}
        >
          <span>{submitAction.label}</span>
          <span
            // Set like the bottom bar's hotkeys.
            className="font-mono text-sm font-normal text-muted-foreground"
            data-sidebar-inline-submit-shortcut=""
          >
            {submitAction.shortcut}
          </span>
        </button>
      )}
    </div>
  );
}

const DRAG_PREVIEW_NOOP = () => {};

/// The row copy that travels in the DragOverlay while a collection is being
/// reordered.
///
/// It repeats the resting row's own layout pieces — title cell, preview rail
/// with the real thumbnail strip, count column — so the picked-up row is the
/// row, media included, not an abbreviation of it. What it deliberately drops
/// is behaviour: no NavLink and no preview interactivity (the strip renders
/// with `allowHoverPreview` off and no-op handlers). A control inside a drag
/// overlay can never be interacted with, so wiring it up would only re-run
/// effects for nothing. The lifted look (surface, border, shadow) marks the row
/// as picked up, matching the system's floating elements.
export function SidebarTagRowDragPreview({
  label,
  count,
  cards,
  previewsPending = false,
}: {
  label: string;
  count: number;
  cards: PreviewCard[];
  /** The same flag the row gets, so the lifted copy keeps the row's placeholders. */
  previewsPending?: boolean;
}) {
  return (
    <div
      className="flex h-full w-full items-center rounded-1 border border-border bg-sidebar shadow-md"
      data-sidebar-tag-drag-preview=""
    >
      <div className="relative flex w-full min-w-0 items-center py-1 pl-[var(--sidebar-row-pad-x)] font-sans text-base text-muted-foreground">
        <SidebarRowTitleCell>{label}</SidebarRowTitleCell>
        <SidebarPreviewRail>
          <SidebarPreviewStrip
            cards={cards}
            count={count}
            previewsPending={previewsPending}
            previewKeyPrefix="drag-preview"
            rowKey="drag-preview"
            onPreviewEnter={DRAG_PREVIEW_NOOP}
            onPreviewLeave={DRAG_PREVIEW_NOOP}
            onPreviewClick={DRAG_PREVIEW_NOOP}
            onPreviewTriggerRef={DRAG_PREVIEW_NOOP}
            activePreviewKey={null}
          />
        </SidebarPreviewRail>
        <span
          className="absolute inset-y-0 right-[var(--sidebar-row-pad-x)] flex w-8 -translate-x-px items-center justify-end text-right font-mono text-sm"
          data-sidebar-row-text=""
        >
          {count || ""}
        </span>
      </div>
    </div>
  );
}
