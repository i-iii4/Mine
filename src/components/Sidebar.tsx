import { scrollBehavior } from "@/lib/motion";
import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { flushSync } from "react-dom";
import { NavLink, useLocation } from "react-router";
import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { revealInFinder } from "@/lib/systemActions";
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
import type { MembershipAnswer } from "@/components/CollectionPicker";
import { collectionPagePath, getBlock, nameRefusal } from "@/lib/commands";
import { errorMessage } from "@/lib/errorMessage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAME_REFUSED_SHAKE_MS, useNameEdit, type NameEdit } from "@/hooks/useNameEdit";
import { collectionRefLabel } from "@/lib/collections";
import {
  filterSidebarTags,
  shouldShowSidebarEverythingRow,
  sidebarRowDomId,
} from "@/lib/sidebarSearch";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  CONNECT_ACTION_BUTTON_CLASS,
  SIDEBAR_PREVIEW_DIVIDER_GAP_PX,
  sidebarBesideMinWidthPx,
  SIDEBAR_ROW_ACTION_GAP_PX,
  sidebarStripTileCount,
  sidebarStripTrackWidth,
} from "@/lib/appLayout";
import { observeStripWidth } from "@/lib/sidebarStripWidth";
import { sidebarWidthHost } from "@/lib/sidebarWidth";
import { SidebarOverlayWidthContext } from "./SidebarOverlay";
import { holdStripPicture } from "@/lib/stripPictures";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";
import { observeTextClip } from "@/lib/textClip";
import {
  applySelectionMembership,
  setHoveredCollectionRow,
  useCardSelectionSummary,
  useRowConnectedToHoveredCard,
} from "@/lib/collectionHover";
import { scheduleAfterOptimisticUiUpdate } from "@/lib/groupSelection";
import { publishCollectionOrder } from "@/lib/cardCollections";
import { SIDEBAR_THUMBNAIL_DRAG_ID_PREFIX, type BlockDragData } from "@/lib/blockDrag";
import { HoverIntentDragWatch, useHoverIntent } from "@/hooks/useHoverIntent";
import { useHoverPreviewOpener } from "@/hooks/useHoverPreviewOpener";
import { TopFadeScrim } from "./TopFadeScrim";
import { useTopFadeMask } from "@/hooks/useTopFadeMask";
import { SIDEBAR_WIDTH_MOTION_MS } from "@/hooks/useSidebarResize";
import { ReadOnlyCardPreview } from "./Card";
import {
  MicroPreviewThumbnail,
  microPreviewFromPreviewCard,
  microPreviewImageClass,
  useMicroPreviewPicture,
  type MicroPreviewPicture,
  type MicroPreviewModel,
} from "./MicroPreviewThumbnail";
import { CHANNEL_ICON_CARD_CLASS, ChannelIcon } from "./ChannelIcon";
import { CHANNEL_ICON_MAX_CARDS, channelIconCardStyle, channelIconSpringStyle } from "@/lib/channelIcon";
import { observeSidebarRowsMorph } from "@/lib/sidebarRowsMorph";

const SIDEBAR_PREVIEW_WIDTH = 240;
/// Where a part of the sidebar laid out by its width takes it from: beside
/// the feed the sidebar's width, written on the part itself
/// (sidebarWidth.ts); over the feed the panel's own width
/// (SidebarOverlay.tsx). The width does not inherit, so a frame of a drag
/// restyles these parts and nothing under them.
type SidebarWidthSource = {
  ref: ((element: HTMLElement | null) => (() => void) | undefined) | undefined;
  style: CSSProperties | undefined;
};

function useSidebarWidthSource(): SidebarWidthSource {
  const overlayWidth = useContext(SidebarOverlayWidthContext);
  return useMemo(() => (overlayWidth === null
    ? { ref: sidebarWidthHost, style: undefined }
    // A custom property by construction; CSSProperties has no key for it.
    : { ref: undefined, style: { "--sidebar-width": overlayWidth } as CSSProperties }), [overlayWidth]);
}

/// The panel's box, as wide as the sidebar's width. The nav takes the panel's width less
/// its 1px border, never less than the narrowest sidebar beside the feed
/// less that border: a collapse slides the curtain over the list at that
/// width (PLAN 50.36). Any wider panel holds the nav without the floor
/// (`S_beside` is 280 since 25.10.2026), so the floor is a constant and no
/// frame of a drag changes a value the rows inherit.
function sidebarPanelStyle(widthAnimating: boolean): CSSProperties {
  // A custom property by construction; CSSProperties has no key for it.
  return {
    width: "var(--sidebar-width)",
    transition: widthAnimating ? `width ${SIDEBAR_WIDTH_MOTION_MS}ms ease` : "none",
    "--sidebar-nav-min-width": `${sidebarBesideMinWidthPx() - 1}px`,
  } as CSSProperties;
}
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
/// Where Connect and Connected stand from the row's right edge: the inset
/// from the meta zone's edge, the zone moved by a trial order of the columns
/// (`--sidebar-meta-right`, sidebarColumnLayout.ts, PLAN 47.6; 0 by default).
/// A compact item stands them as shadcn stands `SidebarMenuAction`, `right-1`
/// (`--sidebar-action-inset`, global.css, «Compact rows»).
const SIDEBAR_ROW_META_ACTION_RIGHT = `calc(var(--sidebar-meta-right, 0px) + var(--sidebar-action-inset, ${SIDEBAR_ROW_ACTION_BUTTON_INSET}px))`;
const SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH = EDGE_FADE_WIDTH;
const SIDEBAR_PREVIEW_MASK_FADE_WIDTH = EDGE_FADE_WIDTH;
/// The air between the previews and the right guideline, set by the theme:
/// none in the light theme, where the cell's edge cuts the previews; the
/// divider gap in the dark one, where they dissolve before it (global.css,
/// «Previews' right edge»; user's decision of 07.10.2026).
const SIDEBAR_PREVIEW_EDGE_GAP = `var(--preview-edge-gap, ${SIDEBAR_PREVIEW_DIVIDER_GAP}px)`;
/// The previews' inset after the guideline before them, with that
/// guideline's pixel, which their cell owns: none when a trial order puts them
/// first (`--sidebar-previews-lead`, sidebarColumnLayout.ts, PLAN 47.6).
const SIDEBAR_PREVIEW_LEAD_GAP = `calc(var(--sidebar-previews-lead, 1px) + ${SIDEBAR_PREVIEW_DIVIDER_GAP}px)`;
/** A row's `Connected` that only reports. It is the bottom bar's reference
 *  key, built the same way (ActionButton with `readOnly`): the `reference`
 *  body, mono regular type, muted colour, no hover. Only its height follows
 *  the row's action button, whose place it takes. SPEC_CARD_STATES.md, С4, С5. */
const SIDEBAR_ROW_CONNECTED_PILL_CLASS = cn(
  buttonVariants({ variant: "reference", size: "xs" }),
  "pointer-events-none h-6 font-mono font-normal",
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
/// The Contents list's plus turns into a cross on the stack's spring
/// (DESIGN_SYSTEM.md, компактный пункт): the hover's 150 ms ease-out put
/// most of the turn into the first frames, too quick to be seen.
const LINK_ICON_SPRING_STYLE = channelIconSpringStyle();
/// The names' optical shift: a name stands a pixel further in than the row's
/// inset (DESIGN_SYSTEM.md, «оптический сдвиг»), as the bottom bar's first
/// plate under it expects.
const SIDEBAR_NAME_OPTICAL_SHIFT_PX = 1;
/// The clear air between a name's dissolve and the guideline after it: the
/// divider gap, less the optical shift the name's text already took. The cell
/// ends on the guideline (the next column owns its pixel), so the tail stays
/// inside the name's own zone wherever the column stands.
const SIDEBAR_NAME_CLEAR_TAIL = SIDEBAR_PREVIEW_DIVIDER_GAP - SIDEBAR_NAME_OPTICAL_SHIFT_PX;
/// The name's dissolve, published as a custom property that global.css
/// applies (`[data-sidebar-name-cell][data-text-clipped]`), the compact
/// item's count with it («Compact rows»).
const SIDEBAR_ROW_TEXT_MASK_STYLE = {
  "--sidebar-name-mask": String(
    createRightFadeMaskStyle(SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH, SIDEBAR_NAME_CLEAR_TAIL).maskImage,
  ),
} as CSSProperties;

/// A name or count cell dissolves only while its text does not fit
/// (`data-text-clipped`, global.css); a text that ends inside it stays whole.
/// A callback ref: React runs the teardown it returns.
function trackTextClip(cell: HTMLElement | null) {
  return cell ? observeTextClip(cell, SIDEBAR_NAME_CLEAR_TAIL) : undefined;
}

/// The previews' dissolve toward their own cell's end, with no tail: the cell
/// itself stops short of the guideline by the divider gap, and nothing of the
/// next cell's width enters the strip. Published as a custom property for the
/// theme to apply: the dark theme dissolves the previews into the panel; the
/// light theme draws them whole and lets the cell's edge cut them (global.css,
/// «Previews' right edge»; user's decision of 07.10.2026).
const SIDEBAR_PREVIEW_MASK = String(
  createRightFadeMaskStyle(SIDEBAR_PREVIEW_MASK_FADE_WIDTH, 0).maskImage,
);
// A custom property by construction; CSSProperties has no key for it.
const SIDEBAR_PREVIEW_MASK_STYLE = { "--sidebar-preview-mask": SIDEBAR_PREVIEW_MASK } as CSSProperties;

/// One tile of the thumbnail strip, real or placeholder. Both draw from this
/// single class, so a placeholder occupies exactly the box its thumbnail will
/// take and nothing moves when the picture arrives. The fill is the feed
/// skeleton's quiet `bg-accent`: it is what a placeholder shows, and what a
/// real tile shows behind its image until that image has decoded.
const SIDEBAR_PREVIEW_TILE_LAYOUT_CLASS = "relative size-8 shrink-0 overflow-hidden";
const SIDEBAR_PREVIEW_TILE_FILL_CLASS = "bg-accent";
const SIDEBAR_PREVIEW_TILE_CLASS = `${SIDEBAR_PREVIEW_TILE_LAYOUT_CLASS} ${SIDEBAR_PREVIEW_TILE_FILL_CLASS}`;

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

interface SidebarProps {
  collapsed: boolean;
  /** The width is moving to a collapse or an opening: the only time it
   *  animates (useSidebarResize.ts). */
  widthAnimating: boolean;
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
  /** Renames a collection; a refused name rejects, and the field stays with
   *  the reason under it (05.10.2026). */
  onRenameTag: (oldTag: string, newTag: string) => Promise<void> | void;
  /** Creates a collection; a refused name rejects, as a rename's does. */
  onCreateChannel: (tag: string) => Promise<void> | void;
  /** Why a collection could not be called `name` (renamed from `oldTag`, or
   *  created when it is null), or null; asked while the name is typed. */
  onCheckCollectionName?: (oldTag: string | null, name: string) => Promise<string | null>;
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
  /** ⌘-click on a row opens its route in a new tab, ⇧⌘-click in a new window
   *  (SPEC_TABS.md, В82). Absent on a page that is not a tab. */
  onOpenElsewhere?: (to: string, newWindow: boolean) => void;
  linkedBlockSlug?: string | null;
  linkedTags?: string[];
  onToggleLinkedTag?: (slug: string, tag: string, hasTag: boolean) => void;
  /** Connects or disconnects every selected feed card (SPEC_CARD_STATES.md, С6). */
  onBatchSetTag?: (slugs: string[], tag: string, connected: boolean) => MembershipAnswer;
  detailChromeClosing?: boolean;
  /** Dissolve rows into transparency as they scroll up under the chrome. */
  scrollEdgeFade?: boolean;
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

/** The row a compact item's stack opens for (PLAN 50.36; user's decision
 *  of 22.10.2026: at once, with no speed gate). For the pointer it is the row
 *  under it, the same answer that lights the name (С7.10). The
 *  keyboard, a drop target and a name being typed answer at once
 *  (`immediate`). The wide rows' names keep answering the raw pointer at once
 *  (С7.10, user's decision of 02.10.2026). A context, not a prop: only the
 *  rows' frames read it. */
type SidebarAnswerRows = { pointer: string | null; immediate: string | null };
const SidebarAnswerRowContext = createContext<SidebarAnswerRows>({ pointer: null, immediate: null });

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
  widthAnimating,
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
  onCheckCollectionName,
  onOpenBlock,
  onOpenCardMenu,
  hoverPreviewFrozen = false,
  onNavClick,
  onScrollToTop,
  keyboardNavigationFocus,
  keyboardNavigationFocusPersistent = false,
  searchQuery = "",
  linkedBlockSlug,
  linkedTags = [],
  onToggleLinkedTag,
  onBatchSetTag,
  detailChromeClosing = false,
  scrollEdgeFade = false,
}: SidebarProps & { dropOverId: string | null }) {
  const widthSource = useSidebarWidthSource();
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const topFade = useTopFadeMask(navRef, scrollEdgeFade);
  const previewTriggerRefs = useRef(new Map<string, HTMLElement>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
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
  // The row a slow pointer is over lights its name; a fast sweep lights none.
  const pointerRowFocusRef = useRef(false);
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
  // The big preview's delay, resting pointer and warm window (С7.10).
  const previewOpener = useHoverPreviewOpener(rowIntent.isSlow);
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

  // The rows move between the wide table and the narrow one as the list
  // crosses the compact threshold (sidebarRowsMorph.ts).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    return observeSidebarRowsMorph(nav);
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
  // A rename that ends late (saved, or refused as its field was left) closes
  // only its own row: another row may be being renamed by then.
  const endRenamingTag = useCallback((tag: string) => {
    setEditingTag((current) => (current === tag ? null : current));
  }, []);

  // The rename is awaited: the row stays a field until it is saved, and a
  // refused name comes back to the field (05.10.2026).
  const handleRename = useCallback(
    async (oldTag: string, newValue: string) => {
      await onRenameTag(oldTag, newValue);
    },
    [onRenameTag],
  );

  const createEdit = useNameEdit({
    check: onCheckCollectionName ? (typed) => onCheckCollectionName(null, typed) : undefined,
    save: async (typed) => {
      await onCreateChannel(typed);
    },
    reasonOf: collectionNameRefusal,
    end: () => onSetCreatingChannel(false),
  });

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
        // A change that was not made is the tab's notice, and the
        // collections read after it put the rows back (SPEC_DEEP_AUDIT.md,
        // Е6.1).
        scheduleAfterOptimisticUiUpdate(() => {
          void onBatchSetTag(slugs, tag, !checked);
        });
      },
    };
  };
  // The manual order this menu draws is the order a card preview lists its
  // collections in, as the feed card's row does (SPEC_CARD_STATES.md, С10).
  useEffect(() => {
    publishCollectionOrder(orderedTags);
  }, [orderedTags]);
  const linkedTagSet = useMemo(() => new Set(linkedTags), [linkedTags]);
  // Every collection is listed, an open card's included (03.10.2026).
  const visibleTags = useMemo(() => (
    filterSidebarTags(orderedTags, searchQuery)
  ), [orderedTags, searchQuery]);
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

  // Set each render once the close path is known (below `requestPreviewClose`).
  const previewTriggerGoneRef = useRef<(key: string) => void>(() => {});
  const setPreviewTriggerRef = useCallback((key: string, node: HTMLElement | null) => {
    if (node) {
      previewTriggerRefs.current.set(key, node);
    } else {
      previewTriggerRefs.current.delete(key);
      previewTriggerGoneRef.current(key);
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
    setRowFocusFromPointer(false);
    activateSidebarRowFocus(rowKey);
  }, [activateSidebarRowFocus, deactivateSidebarRowFocusMode]);

  // The focused row came from the pointer, not the keyboard: a compact item
  // then opens its stack on the engine's answer instead (SidebarAnswerRowContext).
  const [rowFocusFromPointer, setRowFocusFromPointer] = useState(false);
  applyPointerRowFocusRef.current = (rowKey) => {
    if (rowKey !== null) {
      pointerRowFocusRef.current = true;
      setRowFocusFromPointer(true);
      activateSidebarRowFocus(rowKey);
    } else if (pointerRowFocusRef.current) {
      pointerRowFocusRef.current = false;
      setRowFocusFromPointer(false);
      deactivateSidebarRowFocusMode();
    }
  };

  // Connect answers the pointer by this mark, not by :hover: the button lets
  // the pointer through until its row lights, and WebKit names :hover only on
  // the next move. A pointer that lands right on it lights the row and shows
  // the hovered word in one step, with no slide between (global.css).
  const linkActionPointerRef = useRef<HTMLElement | null>(null);
  const markLinkActionUnderPointer = useCallback((row: HTMLElement | null, x: number, y: number, instant: boolean) => {
    const button = row?.querySelector<HTMLElement>("[data-sidebar-link-action]") ?? null;
    const rect = button?.getBoundingClientRect();
    const previous = linkActionPointerRef.current;
    // Once the word has stepped left for its mark, it answers where it
    // stands: its box reaches as far left as the word went (global.css).
    const reach = button && button === previous ? linkWordStep(button) : 0;
    const over = button && rect && x >= rect.left - reach && x < rect.right && y >= rect.top && y < rect.bottom
      ? button
      : null;
    // Whether the word, stepped left for its mark, would stand over the
    // name's last line: only then a fade comes before it (global.css). The
    // state may change under a resting pointer (a click connects), so it is
    // asked on every move.
    if (over && row) {
      if (nameRunsUnderLinkWord(row, over)) over.setAttribute("data-sidebar-link-over-name", "");
      else over.removeAttribute("data-sidebar-link-over-name");
    }
    if (previous === over) return;
    previous?.removeAttribute("data-sidebar-link-pointer");
    previous?.removeAttribute("data-sidebar-link-over-name");
    over?.setAttribute("data-sidebar-link-pointer", instant ? "instant" : "");
    linkActionPointerRef.current = over;
  }, []);

  const handleSidebarPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-sidebar-row]")
      : null;
    const row = target && event.currentTarget.contains(target) ? target : null;
    const rowKey = row?.dataset.sidebarRowKey ?? null;
    rowIntent.move(rowKey, event.clientX, event.clientY);
    const last = lastPointerPointRowRef.current;
    const still = last !== null && last.x === event.clientX && last.y === event.clientY;
    lastPointerPointRowRef.current = { x: event.clientX, y: event.clientY };
    if (listSlidRef.current && still) return;
    listSlidRef.current = false;
    markLinkActionUnderPointer(row, event.clientX, event.clientY, pointerRowKeyRef.current !== rowKey);
    setPointerRow(rowKey);
  }, [markLinkActionUnderPointer, rowIntent, setPointerRow]);

  const handleSidebarPointerLeave = useCallback(() => {
    markLinkActionUnderPointer(null, 0, 0, false);
    setPointerRow(null);
    lastPointerPointRowRef.current = null;
    pointerRowFocusRef.current = false;
    deactivateSidebarRowFocusMode();
    rowIntent.leave();
  }, [deactivateSidebarRowFocusMode, markLinkActionUnderPointer, rowIntent, setPointerRow]);

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
      // The pointer's row stays lit while the collections are read anew: the
      // pointer has not left it, and its next move on the same row would not
      // light it again.
      if (!pointerRowFocusRef.current) deactivateSidebarRowFocusMode();
      return;
    }
    const rowKey = keyboardNavigationFocus.rowKey;
    const rowIsVisible = rowKey === "all"
      ? showEverythingRow
      : visibleTags.some((tc) => `tag:${tc.tag}` === rowKey);
    if (!rowIsVisible) return;

    clearSidebarKeyboardFocusTimer();
    pointerRowFocusRef.current = false;
    setRowFocusFromPointer(false);
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
    previewOpener.hide();
    clearPreviewCloseTimer();
    setHoveredPreview(null);
  }, [clearPreviewCloseTimer, previewOpener]);

  const requestPreviewClose = useCallback(() => {
    if (hoverPreviewFrozen) return;
    closePreview();
  }, [closePreview, hoverPreviewFrozen]);

  // The open preview belongs to its thumbnail. A strip update (a card saved
  // or removed, its thumbnail no longer confirmed, the row gone) can unmount
  // that thumbnail under a still pointer, and a node gone from the page never
  // reports the pointer leaving it: its unmount is that leave
  // (SPEC_FRONTEND.md, «Миниатюра ушла из-под превью»; SPEC_CARD_STATES.md,
  // С7.10). Whatever thumbnail now stands there opens its own preview when
  // the pointer enters it, by the shared rule.
  previewTriggerGoneRef.current = (key) => {
    if (hoveredPreview?.key === key) requestPreviewClose();
  };

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
    clearPreviewCloseTimer();
    setHoveredPreview(null);
    previewOpener.request(() => openPreview(target));
  }, [clearPreviewCloseTimer, hoverPreviewFrozen, openPreview, previewOpener]);

  useEffect(() => {
    if (hoverPreviewFrozen) {
      previewOpener.cancel();
    }
  }, [hoverPreviewFrozen, previewOpener]);

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
    previewOpener.cancel();
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
  }, [clearPreviewCloseTimer, onOpenCardMenu, previewOpener]);

  useEffect(() => () => {
    clearPreviewCloseTimer();
    clearSidebarRowSwitchFrame();
  }, [clearPreviewCloseTimer, clearSidebarRowSwitchFrame]);

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

  const immediateAnswerRowKey = editingRowKey
    ?? dropOverRowKey
    ?? (sidebarRowFocusMode && !rowFocusFromPointer ? sidebarRowFocusKey : null);
  const answerRows = useMemo<SidebarAnswerRows>(
    () => ({ pointer: intentRowKey, immediate: immediateAnswerRowKey }),
    [intentRowKey, immediateAnswerRowKey],
  );

  return (
    <aside
      ref={widthSource.ref}
      className={cn(
        // overflow-hidden is always on: below the minimum width the panel keeps
        // narrowing while the nav holds `--sidebar-nav-min-width`, so the right
        // edge clips the frozen menu like a curtain.
        // bg-sidebar also re-bases --surface for the zone, so every fill and
        // hover inside the panel lifts from the sidebar surface, not the page.
        "relative flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar",
      )}
      style={{ ...sidebarPanelStyle(widthAnimating), ...widthSource.style }}
      data-sidebar-panel=""
    >
      {/* Navigation. The wrapper exists so the fade band can be a sibling of
          the scrollport: inside the nav it would inherit its padding and settle
          below the real top edge. */}
      {/* Matches the nav's frozen min-width: the band is sized by this wrapper,
          and a narrower wrapper would leave the right edge of the rows
          uncovered as the panel is resized down. */}
      <div className="relative flex min-h-0 min-w-[var(--sidebar-nav-min-width)] flex-1 flex-col">
      <nav
        ref={topFade.ref}
        className={cn(
          // min-width freezes the menu (`--sidebar-nav-min-width`): below it the
          // nav keeps this width and the panel's overflow-hidden clips it.
          "relative min-w-[var(--sidebar-nav-min-width)] flex-1 overflow-y-auto",
          "pb-8",
          // The table sits flush to the divider and edges; rows carry the
          // inner padding.
          "px-[var(--sidebar-nav-pad-x)] pt-[var(--sidebar-nav-pad-top)]",
        )}
        data-sidebar-scroll
        data-sidebar-tag-dragging={isTagDragging ? "true" : undefined}
        data-sidebar-top-fade={topFade.scrolled ? "true" : undefined}
        data-sidebar-link-editor-mode={isLinkEditorActive ? "true" : undefined}
        data-sidebar-row-focus-mode={hasSidebarRowFocusMode ? "true" : undefined}
        data-sidebar-row-switching={sidebarRowSwitching ? "true" : undefined}
        onPointerMove={handleSidebarPointerMove}
        onPointerLeave={handleSidebarPointerLeave}
        onScroll={() => {
          // The list slid under the pointer: the next real move names the row.
          listSlidRef.current = true;
          markLinkActionUnderPointer(null, 0, 0, false);
          setPointerRow(null);
          rowIntent.displace();
        }}
        onFocusCapture={handleSidebarFocusCapture}
        onBlurCapture={handleSidebarBlurCapture}
      >
        <HoverIntentDragWatch intent={rowIntent} />

        <SidebarAnswerRowContext.Provider value={answerRows}>
        <div className="relative" data-sidebar-rows>
          <div className="pointer-events-none absolute inset-0" data-sidebar-guidelines>
            <span
              ref={widthSource.ref}
              aria-hidden="true"
              data-sidebar-guideline="left"
              className="absolute inset-y-0 w-px bg-sidebar-border"
              // A trial may reorder or hide the columns (sidebarColumnLayout.ts,
              // PLAN 47.6); without it the guideline stands where it always did.
              style={{
                left: "var(--sidebar-guide-1-left, calc(var(--sidebar-row-pad-x) + var(--sidebar-name-col)))",
                display: "var(--sidebar-guide-1-display, block)",
                ...widthSource.style,
              }}
            />
            <span
              aria-hidden="true"
              data-sidebar-guideline="right"
              className="absolute inset-y-0 w-px bg-sidebar-border"
              style={{
                left: "var(--sidebar-guide-2-left, auto)",
                right: "var(--sidebar-guide-2-right, var(--sidebar-zone))",
                display: "var(--sidebar-guide-2-display, block)",
              }}
            />
          </div>

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
              end
              onClick={onNavClick}
              onSameClick={isLinkEditorActive ? onNavClick : onScrollToTop}
              rowKey="all"
              isSidebarRowFocused={effectiveSidebarRowFocusKey === "all"}
              staticConnected={isLinkEditorActive || isSelectionEditorActive}
            />
          )}

          {/* A new collection is named at the top of the list, under
              Everything, and takes the first place there. The list parts to
              make room for the row, quickly (global.css, data-sidebar-row-part). */}
          {showCreateRow && (
            <div data-sidebar-row-part=""><div>
            <NewChannelRow
              isEditing={isCreatingChannel}
              // A filter typed before the plus becomes the new name's start.
              defaultName={searchQuery.trim()}
              isSidebarRowFocused={effectiveSidebarRowFocusKey === "create-channel"}
              onStartCreate={() => onSetCreatingChannel(true)}
              edit={createEdit}
            />
            </div></div>
          )}
          {/* A refused name left the row: the row is gone, its reason stays
              a moment where it stood. */}
          {!showCreateRow && createEdit.notice !== null && (
            <SidebarNameNotice notice={createEdit.notice}>
              <div aria-hidden="true" className="h-0" data-sidebar-name-notice-anchor="" />
            </SidebarNameNotice>
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
                  isDropDragging={isDropDragging}
                  isEditing={!isLinkEditorActive && editingTag === tc.tag}
                  linkEditor={isLinkEditorActive ? {
                    checked,
                    onToggle: () => onToggleLinkedTag(linkedBlockSlug, tc.tag, checked),
                  } : selectionLinkEditor(tc.tag)}
                  onDoubleClick={startRenamingTag}
                  onRenameSubmit={handleRename}
                  onRenameEnd={endRenamingTag}
                  onRenameCheck={onCheckCollectionName}
                  onDelete={onDeleteTag}
                  onClick={onNavClick}
                  onSameClick={isLinkEditorActive ? undefined : onScrollToTop}
                  rowKey={`tag:${tc.tag}`}
                  isIntentRow={intentRowKey === `tag:${tc.tag}`}
                  isSidebarRowFocused={effectiveSidebarRowFocusKey === `tag:${tc.tag}`}
                />
              );
            })}
          </SortableContext>

        </div>
        </SidebarAnswerRowContext.Provider>


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
  const canOpenUp =
    triggerRect.top - SIDEBAR_PREVIEW_GAP - previewHeight >= SIDEBAR_PREVIEW_VIEWPORT_MARGIN;
  // Too tall for either side: the preview stands beside the thumbnail
  // instead, so it never covers the thumbnail it answers (user's remark of
  // 22.10.2026).
  if (!canOpenDown && !canOpenUp) {
    const besideRight = triggerRect.right + SIDEBAR_PREVIEW_GAP;
    const sideLeft = besideRight + SIDEBAR_PREVIEW_WIDTH <= viewportWidth - SIDEBAR_PREVIEW_VIEWPORT_MARGIN
      ? besideRight
      : Math.max(SIDEBAR_PREVIEW_VIEWPORT_MARGIN, triggerRect.left - SIDEBAR_PREVIEW_GAP - SIDEBAR_PREVIEW_WIDTH);
    const centred = triggerRect.top + triggerRect.height / 2 - previewHeight / 2;
    const sideTop = Math.max(
      SIDEBAR_PREVIEW_VIEWPORT_MARGIN,
      Math.min(centred, viewportHeight - SIDEBAR_PREVIEW_VIEWPORT_MARGIN - previewHeight),
    );
    return { top: sideTop, left: sideLeft };
  }
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
  rowKey: string;
  isCurrentRoute: boolean;
  isLinked?: boolean;
  isSidebarRowFocused: boolean;
  isEditing?: boolean;
  /** The row is one cell across the whole row, as an edited name is: it lies
   *  over the list's column lines (`data-sidebar-guidelines`). */
  spansRow?: boolean;
  className?: string;
  style?: CSSProperties;
  nodeRef?: (node: HTMLDivElement | null) => void;
  textDropTag?: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "style" | "className">;

const SidebarRowFrame = forwardRef<HTMLDivElement, SidebarRowFrameProps>(function SidebarRowFrame({
  isIntentRow = false,
  rowKey,
  isCurrentRoute,
  isLinked = false,
  isSidebarRowFocused,
  isEditing = false,
  spansRow = isEditing,
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
  const answerRows = useContext(SidebarAnswerRowContext);
  const isAnswerRow = rowKey === answerRows.pointer || rowKey === answerRows.immediate;

  return (
    <div
      id={sidebarRowDomId(rowKey)}
      ref={setRefs}
      style={style}
      {...domProps}
      // A slow pointer is on this row (С7.10): its button shows.
      data-sidebar-row-intent={isIntentRow ? "true" : undefined}
      // A compact item's stack opens for this (SidebarAnswerRowContext).
      data-sidebar-row-answer={isAnswerRow ? "true" : undefined}
      data-sidebar-row=""
      data-sidebar-row-surface=""
      data-sidebar-row-key={rowKey}
      data-sidebar-row-active={isCurrentRoute ? "true" : undefined}
      data-sidebar-row-linked={isLinked ? "true" : undefined}
      data-sidebar-row-focused={isSidebarRowFocused ? "true" : undefined}
      data-sidebar-row-editing={isEditing ? "true" : undefined}
      data-sidebar-text-drop-tag={textDropTag}
      className={cn(
        "group relative rounded-1",
        // Lifted over the column lines on the table's own surface; its seam
        // (`::after`) paints over that surface and stays.
        spansRow && "z-10 bg-sidebar",
        className,
      )}
    >
      {children}
    </div>
  );
});

/// The name's cell: the name's whole zone, the row's inset included, and,
/// after another column, the guideline's pixel before it (`--sidebar-name-lead`,
/// sidebarColumnLayout.ts, PLAN 47.6; none by default, where the name comes
/// first). The inset belongs to the name's zone, not to the row
/// (DESIGN_SYSTEM.md, «Строка боковой панели: три зоны»), so a trial order
/// keeps it, and the dissolve ends inside the zone wherever it stands.
function SidebarRowTitleCell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  // The name's column follows the sidebar's width, which the cell holds
  // itself (global.css, `--sidebar-name-col`).
  const widthSource = useSidebarWidthSource();
  const widthRef = widthSource.ref;
  const cellRef = useCallback((cell: HTMLSpanElement | null) => {
    if (!cell) return undefined;
    const stopClip = trackTextClip(cell);
    const stopWidth = widthRef?.(cell);
    return () => {
      stopClip?.();
      stopWidth?.();
    };
  }, [widthRef]);
  return (
    <span
      ref={cellRef}
      data-sidebar-row-text=""
      data-sidebar-name-cell=""
      data-sidebar-title-fade-width={String(SIDEBAR_ROW_TEXT_MASK_FADE_WIDTH)}
      data-sidebar-title-protected-width={String(SIDEBAR_NAME_CLEAR_TAIL)}
      className={cn(
        "w-[calc(var(--sidebar-name-lead,0px)+var(--sidebar-row-pad-x)+var(--sidebar-name-col))] shrink-0 overflow-hidden whitespace-nowrap",
        className,
      )}
      style={{
        ...SIDEBAR_ROW_TEXT_MASK_STYLE,
        paddingLeft: `calc(var(--sidebar-name-lead, 0px) + var(--sidebar-row-pad-x) + ${SIDEBAR_NAME_OPTICAL_SHIFT_PX}px)`,
        ...widthSource.style,
      }}
    >
      {/* The name's own text: the Contents list covers its leader with it (global.css). */}
      <span data-sidebar-name-text="">{children}</span>
    </span>
  );
}

/// The previews' cell: from the guideline before it to the one after it (or
/// the row's edge), its own edges and nothing past them. The next cell stands
/// in the row's flow (`SidebarMetaCell`), so this one ends where the next
/// guideline begins instead of running under the count and Connect and being
/// masked off there (user's decision of 07.10.2026).
function SidebarPreviewRail({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <>
      <div
        // The floor matches the other columns' keystone: the previews may not
        // drop below it whatever width the panel is dragged to.
        className="relative min-w-[var(--sidebar-col-floor)] flex-1"
        data-sidebar-preview-rail
        // Measured from the far edge of the guideline before the previews,
        // whose pixel the cell owns (`--sidebar-previews-lead`, none when a
        // trial order puts them first). Before the next guideline the theme
        // decides: the light theme's previews run to it and are cut by the
        // cell's edge, the dark theme's keep the gap of air they dissolve in
        // (global.css, --preview-edge-gap).
        style={{
          paddingLeft: SIDEBAR_PREVIEW_LEAD_GAP,
          paddingRight: SIDEBAR_PREVIEW_EDGE_GAP,
        }}
      >
        {children}
      </div>
      <SidebarMetaCell>{meta}</SidebarMetaCell>
    </>
  );
}

/// The meta zone's cell, the count and Connect, with the guideline's pixel
/// before it (`--sidebar-meta-lead`, none when a trial order puts it first).
/// It holds nothing in the flow (the count and the buttons are placed over
/// it); it is here so the previews' cell ends on the guideline. A compact
/// item shows its stack of mini-cards here, at its right end (`children`).
function SidebarMetaCell({ children }: { children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      data-sidebar-meta-cell=""
      className="w-[calc(var(--sidebar-meta-lead,1px)+var(--sidebar-zone))] shrink-0 self-stretch"
    >
      {children}
    </span>
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
  sourceTag,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  activePreviewKey,
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
  /** The row's collection; absent on Everything. */
  sourceTag?: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
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
  const showConnectedPill = staticConnected || (!isLinkEditor && connectedToHoveredCard);
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
  // What stands in the meta zone under Connect and Connected: the count, or a
  // compact row's stack. Either gives way to them the same way.
  const metaAnswerClass = isLinkEditor
    ? cn(
        ROW_INTENT_FADE,
        linkButtonPinned
          ? "opacity-0"
          : ROW_INTENT_HIDES,
      )
    : cn(ROW_INTENT_FADE, showConnectedPill ? cn("opacity-0", ANSWER_ON) : cn("opacity-100", ANSWER_OFF));
  const previewHandlers = {
    count,
    previewsPending,
    previewKeyPrefix,
    rowKey,
    sourceTag,
    onPreviewEnter,
    onPreviewLeave,
    onPreviewClick,
    onPreviewContextMenu,
    onPreviewTriggerRef,
    activePreviewKey,
  };

  return (
    <>
      <NavLink
        to={to}
        end={end}
        draggable="false"
        onClick={handleNavLinkClick}
        onDoubleClick={handleNavLinkDoubleClick}
        // The row's 16px of inner padding belongs to its columns, not to the
        // row: the name's cell starts with it, the count stands it in from
        // the meta zone's edge, so a trial order of the columns keeps both.
        className={cn(
          SIDEBAR_ROW_BOX_CLASS,
          // Its focus look is the focused row's, its words brightened
          // (global.css), never the browser's ring.
          "font-sans text-base text-muted-foreground outline-none",
        )}
        data-sidebar-row-body=""
      >
        <SidebarRowTitleCell>
          {label}
        </SidebarRowTitleCell>
        <SidebarPreviewRail
          meta={(
            <SidebarCompactStack
              cards={cards}
              {...previewHandlers}
              allowHoverPreview
              // Connect, Connected and Disconnect cover the stack as they
              // cover the count; under the reference `Connected`, which lets
              // the pointer through, the faded cards must not answer it.
              className={cn(metaAnswerClass, (showConnectedPill || linkButtonPinned) && "pointer-events-none")}
            />
          )}
        >
          <SidebarPreviewStrip
            cards={cards}
            {...previewHandlers}
            allowHoverPreview
          />
        </SidebarPreviewRail>
        <span
          className={cn(
            "absolute inset-y-0 right-[calc(var(--sidebar-meta-right,0px)+var(--sidebar-row-pad-x))] flex w-8 items-center justify-end text-right text-sm font-mono text-muted-foreground",
            "-translate-x-px",
            metaAnswerClass,
          )}
          data-sidebar-row-text=""
          data-sidebar-meta-count=""
          ref={trackTextClip}
          // A compact item's second line dissolves as the name does (global.css).
          style={SIDEBAR_ROW_TEXT_MASK_STYLE}
        >
          {count || ""}
          {count ? <SidebarCountNoun count={count} /> : null}
        </span>
      </NavLink>
      {/* Always mounted: pill and count cross-fade in place instead of
          popping in and out (С7.6). */}
      <span
        className={cn(
          SIDEBAR_ROW_CONNECTED_PILL_CLASS,
          ROW_INTENT_FADE,
          "absolute top-1/2 z-10 -translate-y-1/2",
          showConnectedPill ? cn("opacity-100", ANSWER_ON) : cn("opacity-0", ANSWER_OFF),
        )}
        style={{
          right: SIDEBAR_ROW_META_ACTION_RIGHT,
          width: SIDEBAR_ROW_ACTION_BUTTON_WIDTH,
        }}
        aria-hidden={showConnectedPill ? undefined : true}
        data-sidebar-row-connected-pill=""
        data-state={showConnectedPill ? "on" : "off"}
      >
        Connected
      </span>
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
            right: SIDEBAR_ROW_META_ACTION_RIGHT,
            width: SIDEBAR_ROW_ACTION_BUTTON_WIDTH,
          }}
          aria-label={`${linkEditor.checked ? "Disconnect" : "Connect"} ${label}`}
          data-link-checked={linkEditor.checked ? "" : undefined}
        >
          <span data-sidebar-link-label="">
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
          </span>
          {/* The Contents list's hover mark (global.css): a plus that turns
              into a cross once the collection can be disconnected. */}
          <Plus aria-hidden="true" data-sidebar-link-icon="" style={LINK_ICON_SPRING_STYLE} />
        </button>
      )}
    </>
  );
}

/// What a refused collection name shows under the name: the reason the
/// command gave, or, for a failure that is no refusal of the name, its own
/// words; never the console only (SPEC_DEEP_AUDIT.md, Н11).
function collectionNameRefusal(error: unknown): string {
  return nameRefusal(error) ?? errorMessage(error);
}

/// Whether a row's name, on its last line, reaches under its Connect word
/// once the word steps left for its mark (the Contents list, global.css):
/// the name's last line against the word's place at rest less the mark's
/// room, the mark's width and the label's own inset.
function nameRunsUnderLinkWord(row: HTMLElement, button: HTMLElement): boolean {
  const name = row.querySelector<HTMLElement>("[data-sidebar-name-text]");
  const label = button.querySelector<HTMLElement>("[data-sidebar-link-label]");
  if (!name || !label) return false;
  const range = document.createRange();
  range.selectNodeContents(name);
  const lines = [...range.getClientRects()];
  const last = lines[lines.length - 1];
  if (!last) return false;
  const nameEnd = Math.max(...lines.filter((line) => Math.abs(line.bottom - last.bottom) < 1).map((line) => line.right));
  const labelAtRest = button.getBoundingClientRect().left + label.offsetLeft;
  return nameEnd > labelAtRest - linkWordStep(button);
}

/// How far a Connect word steps left for its mark under the pointer: the
/// mark's own width and the label's inset (the cross is the plus turned, and
/// a turned box measures wider than the room the word steps aside for).
function linkWordStep(button: HTMLElement): number {
  const label = button.querySelector<HTMLElement>("[data-sidebar-link-label]");
  const mark = button.querySelector<SVGElement>("[data-sidebar-link-icon]");
  if (!label || !mark) return 0;
  return Number.parseFloat(getComputedStyle(mark).width) + Number.parseFloat(getComputedStyle(label).paddingLeft);
}

/// The reason a typed name is refused, right under the row being named: the
/// notice the card's name in the path shows (05.10.2026).
function SidebarNameNotice({
  notice,
  children,
}: {
  notice: string | null;
  children: ReactNode;
}) {
  return (
    <Tooltip open={notice !== null}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        align="start"
        className="max-w-80 text-destructive"
        data-sidebar-name-notice=""
      >
        {notice}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarEditableRowBody({
  defaultValue,
  placeholder,
  ariaLabel,
  submitAction,
  edit,
}: {
  defaultValue: string;
  placeholder: string;
  ariaLabel: string;
  submitAction?: {
    label: string;
    shortcut: string;
    shortcutKey: string;
  };
  edit: NameEdit;
}) {
  return (
    <SidebarNameNotice notice={edit.notice}>
      <div
        className={cn(SIDEBAR_ROW_BOX_CLASS, "pl-[var(--sidebar-row-pad-x)] font-sans text-base text-muted-foreground")}
        data-sidebar-editable-row-body
        data-sidebar-editable-row-full-width
      >
        {submitAction && (
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
          edit={edit}
        />
      </div>
    </SidebarNameNotice>
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
  end,
  onClick,
  onSameClick,
  rowKey,
  isSidebarRowFocused,
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
  end?: boolean;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isSidebarRowFocused: boolean;
  /** Everything while a card is expanded: connected, and nothing can change that. */
  staticConnected?: boolean;
}) {
  const loc = useLocation();
  const isCurrentRoute = end ? loc.pathname === to : loc.pathname.startsWith(to);

  return (
    <SidebarRowFrame
      rowKey={rowKey}
      isCurrentRoute={isCurrentRoute}
      isSidebarRowFocused={isSidebarRowFocused}
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
  isDropDragging,
  isEditing,
  linkEditor,
  onDoubleClick,
  onRenameSubmit,
  onRenameEnd,
  onRenameCheck,
  onDelete,
  onClick,
  onSameClick,
  rowKey,
  isIntentRow = false,
  isSidebarRowFocused,
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
  isDropDragging: boolean;
  isEditing: boolean;
  linkEditor?: SidebarRowLinkEditor;
  onDoubleClick: (tag: string) => void;
  /** Saves the new name; a refused name rejects. */
  onRenameSubmit: (tag: string, value: string) => Promise<void>;
  /** The rename of `tag` is over: saved, kept, or refused as its field was left. */
  onRenameEnd: (tag: string) => void;
  onRenameCheck?: (tag: string, value: string) => Promise<string | null>;
  onDelete: (tag: string) => void;
  onClick?: () => void;
  onSameClick?: () => void;
  rowKey: string;
  isIntentRow?: boolean;
  isSidebarRowFocused: boolean;
}) {
  const location = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The collection's page, looked up as its menu opens: `undefined` until the
  // answer. Every row is a page (a collection exists only as one), so null
  // comes only from a race with the page deleted outside Mine, or from a name
  // several pages share; the watcher then updates the list
  // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К10).
  const [pagePath, setPagePath] = useState<string | null | undefined>(undefined);
  const findPage = useCallback((open: boolean) => {
    if (!open) return;
    setPagePath(undefined);
    collectionPagePath(tag).then(setPagePath, () => setPagePath(null));
  }, [tag]);
  const isLinkEditor = !!linkEditor;
  // The parent hands out one callback for every row; each row binds its own tag.
  const startRename = useCallback(() => onDoubleClick(tag), [onDoubleClick, tag]);
  // The edit lives with the row, not with its field: a name refused as the
  // field was left returns, and its reason stays under the row a moment.
  const renameEdit = useNameEdit({
    current: label,
    check: onRenameCheck ? (typed) => onRenameCheck(tag, typed) : undefined,
    save: (typed) => onRenameSubmit(tag, typed),
    reasonOf: collectionNameRefusal,
    end: () => onRenameEnd(tag),
  });
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
        rowKey={rowKey}
        isIntentRow={isIntentRow}
        isCurrentRoute={isCurrentRoute}
        isLinked={linkEditor?.checked}
        isSidebarRowFocused={isSidebarRowFocused}
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
          // Saving names its key like creating does (05.10.2026).
          submitAction={{ label: "Save", shortcut: bindingLabel({ key: "Enter" }), shortcutKey: "Enter" }}
          edit={renameEdit}
        />
      </SidebarRowFrame>
    );
  }

  return (
    <>
      <ContextMenu onOpenChange={findPage}>
        <ContextMenuTrigger asChild>
          <SidebarRowFrame
            rowKey={rowKey}
            isIntentRow={isIntentRow}
            isCurrentRoute={isCurrentRoute}
            isLinked={linkEditor?.checked}
            isSidebarRowFocused={isSidebarRowFocused}
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
              sourceTag={tag}
              onPreviewEnter={onPreviewEnter}
              onPreviewLeave={onPreviewLeave}
              onPreviewClick={onPreviewClick}
              onPreviewContextMenu={onPreviewContextMenu}
              onPreviewTriggerRef={onPreviewTriggerRef}
              activePreviewKey={activePreviewKey}
              isCurrentRoute={isCurrentRoute}
              isDragging={isDragging}
              isDropDragging={isDropDragging}
              onClick={onClick}
              onSameClick={onSameClick}
              onDoubleClick={startRename}
              linkEditor={linkEditor}
            />
            {renameEdit.notice !== null && (
              // The old name returned after a refusal; its reason stays a moment.
              <SidebarNameNotice notice={renameEdit.notice}>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  data-sidebar-name-notice-anchor=""
                />
              </SidebarNameNotice>
            )}
          </SidebarRowFrame>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={startRename}>
            <Pencil className="size-[13px]" />
            Rename
          </ContextMenuItem>
          {/* The collection is a page in the folder: it opens where the
              cards' Reveal in Finder opens theirs, with the space's icon. */}
          <ContextMenuItem
            disabled={!pagePath}
            onSelect={() => {
              if (pagePath) revealInFinder(pagePath);
            }}
            data-sidebar-collection-reveal=""
          >
            <FolderOpen className="size-[13px]" />
            Reveal in Finder
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="size-[13px]" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <DeleteCollectionDialog
        open={deleteOpen}
        label={label}
        onOpenChange={setDeleteOpen}
        onConfirm={deleteTag}
      />
    </>
  );
});

/** The question before a collection is deleted from the sidebar's right
 *  click. */
export function DeleteCollectionDialog({
  open,
  label,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  label: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete collection?</AlertDialogTitle>
          {/* The fate of each thing the deletion touches (DESIGN_SYSTEM.md,
              «Что вернуть нельзя»): the page goes to the Trash, the
              connections are cleared from the elements for good. */}
          <AlertDialogDescription>
            The collection page goes to the Trash. Its elements stay, but their connection to &ldquo;{label}&rdquo; is removed and does not come back if you restore the page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NewChannelRow({
  isEditing,
  defaultName,
  isSidebarRowFocused,
  onStartCreate,
  edit,
}: {
  isEditing: boolean;
  defaultName: string;
  isSidebarRowFocused: boolean;
  onStartCreate: () => void;
  /** The naming of the new collection; it outlives the row, whose reason
   *  stays a moment after a refused name closed it. */
  edit: NameEdit;
}) {
  const { setNodeRef } = useDroppable({
    id: "create-channel",
    disabled: isEditing,
  });

  return (
    <SidebarRowFrame
      rowKey="create-channel"
      isCurrentRoute={false}
      isSidebarRowFocused={isSidebarRowFocused}
      isEditing={isEditing}
      // The name being typed and the drop target alike are one cell across
      // the row: no column line crosses them (08.10.2026).
      spansRow
      nodeRef={setNodeRef}
      data-sidebar-new-channel-row=""
    >
      {isEditing ? (
        <SidebarEditableRowBody
          defaultValue={defaultName}
          placeholder=""
          ariaLabel="Имя нового канала"
          // The key's label comes from the one key table the bottom bar uses.
          submitAction={{ label: "Create", shortcut: bindingLabel({ key: "Enter" }), shortcutKey: "Enter" }}
          edit={edit}
        />
      ) : (
        <button
          type="button"
          className="block w-full text-left"
          onClick={onStartCreate}
        >
          <SidebarCreateChannelRowBody isEditing={false} />
        </button>
      )}
    </SidebarRowFrame>
  );
}

/// The drop target that founds a collection with the dragged card: a row of
/// the table with its own seam, made of one cell across the whole row (user's
/// decision of 08.10.2026: the name column cut the label). The row lies over
/// the column lines (`spansRow`), so the label never crosses one; the plus
/// stands where a count stands.
function SidebarCreateChannelRowBody({
  isEditing,
}: {
  isEditing: boolean;
}) {
  return (
    <div
      className={cn(
        SIDEBAR_ROW_BOX_CLASS,
        // The label runs to the plus: the row's inset, then the plus's 32px.
        "pl-[var(--sidebar-row-pad-x)] pr-[calc(var(--sidebar-row-pad-x)+2rem)] font-sans text-base text-muted-foreground",
        // A slow pointer lights it like any row (С7.10); the keyboard at once.
        !isEditing && "group-focus-within:text-foreground",
      )}
      data-sidebar-create-channel-row-body
    >
      {/* Set 1px in like every row's name. */}
      <span data-sidebar-row-text="" className="min-w-0 flex-1 translate-x-px truncate text-left">
        {CREATE_COLLECTION_ROW_LABEL}
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 right-[var(--sidebar-row-pad-x)] flex w-8 -translate-x-px items-center justify-end"
      >
        <Plus
          data-sidebar-create-channel-plus=""
          className={cn("size-4 shrink-0 text-muted-foreground", isEditing && "opacity-0")}
        />
      </span>
    </div>
  );
}

/// The command's own name, as on the plus over the list and in the bottom bar.
const CREATE_COLLECTION_ROW_LABEL = "New Collection";

/// How many placeholder tiles a strip draws while its thumbnails are on the
/// way: one per card not shown yet, up to the `tiles` its width holds
/// (SPEC_SIDEBAR_STRIP.md, ЛМ3). `shown` is the number of real thumbnails
/// already in the strip; they keep the first slots and the placeholders fill
/// the rest. A row with no cards draws none.
function sidebarPreviewPlaceholderCount(count: number, shown: number, tiles: number): number {
  return Math.max(0, Math.min(count, tiles) - shown);
}

/// The first `limit` cards of a row's list that have a thumbnail, in the
/// list's order. The list holds every card of the collection; only what the
/// strip shows is walked.
function firstThumbnails(cards: PreviewCard[], limit: number): PreviewCard[] {
  const shown: PreviewCard[] = [];
  for (const card of cards) {
    if (shown.length >= limit) break;
    if (card.hasThumb) shown.push(card);
  }
  return shown;
}

/// How many tiles a strip holds, from its own width (SPEC_SIDEBAR_STRIP.md,
/// ЛМ2), and the callback ref that measures it. The width is read once the
/// strip is laid out, before its first frame paints, and again whenever its
/// layout changes it (sidebarStripWidth.ts): only a strip whose count
/// changed renders, and in the frame that draws its new width.
function useStripTileCount(): [number, (strip: HTMLDivElement | null) => (() => void) | undefined] {
  const [tiles, setTiles] = useState(0);
  const measure = useCallback((strip: HTMLDivElement | null) => {
    if (!strip) return undefined;
    setTiles(sidebarStripTileCount(strip.getBoundingClientRect().width));
    return observeStripWidth(strip, (width) => setTiles(sidebarStripTileCount(width)));
  }, []);
  return [tiles, measure];
}

/// A strip's tile holds its picture itself, with no box of its own around
/// the image: a strip that widens adds dozens of tiles in a frame, and every
/// element counts (SPEC_SIDEBAR_STRIP.md, ЛМ5). The tile is the slot
/// MicroPreviewThumbnail would draw: its fill until the picture is in, then
/// a text thumb's card fill with its ink (MicroPreviewThumbnail.tsx).
function sidebarStripTileClass(preview: MicroPreviewModel, picture: MicroPreviewPicture): string {
  return cn(
    SIDEBAR_PREVIEW_TILE_LAYOUT_CLASS,
    preview.text && picture.loaded ? "bg-card" : SIDEBAR_PREVIEW_TILE_FILL_CLASS,
  );
}

/// A strip tile's image. A picture that loaded stays in the page's cache, so
/// the tile a narrowing took off draws it again without reading the file
/// (stripPictures.ts): the address as the tile set it, not as resolved.
function SidebarStripTileImage({ preview, picture }: { preview: MicroPreviewModel; picture: MicroPreviewPicture }) {
  if (picture.missing) return null;
  return (
    <img
      ref={picture.imageRef}
      src={picture.src}
      className={microPreviewImageClass(preview, false)}
      loading="lazy"
      // Decoded off the main thread: until it is in, the tile shows its fill.
      decoding="async"
      draggable={false}
      onLoad={() => {
        picture.onLoaded();
        holdStripPicture(picture.src);
      }}
      onError={picture.onFailed}
    />
  );
}

/// A strip tile without behaviour: the lifted copy of a row draws its media
/// so.
function SidebarStripStillTile({ card }: { card: PreviewCard }) {
  const preview = microPreviewFromPreviewCard(card);
  const picture = useMicroPreviewPicture(preview);
  return (
    <div
      className={sidebarStripTileClass(preview, picture)}
      data-sidebar-preview-thumbnail="placeholder"
      data-thumb-edge=""
      data-micro-preview-state={picture.state}
    >
      <SidebarStripTileImage preview={preview} picture={picture} />
    </div>
  );
}

/// A card a thumbnail can open, drag and preview: one the read named.
function hasPreviewSlug(card: PreviewCard): card is PreviewCard & { slug: string } {
  return !!card.slug;
}

/// The id a thumbnail drags under: the strip's own key for it, so the card
/// standing in several rows and in the feed has a distinct id at each place.
function sidebarThumbnailDragId(previewKey: string): string {
  return `${SIDEBAR_THUMBNAIL_DRAG_ID_PREFIX}${previewKey}`;
}

/// A strip's live thumbnail: a hover opens the card's preview, a click the
/// card, a right click its menu, and a drag past the feed's threshold carries
/// the card to a collection like a feed card (SPEC_FRONTEND.md,
/// «Перетаскивание миниатюры», 09.10.2026). Memoised on plain props: a strip
/// whose width took a tile more renders that tile alone, not every tile it
/// already shows (SPEC_SIDEBAR_STRIP.md, ЛМ5).
const SidebarPreviewThumbnail = memo(function SidebarPreviewThumbnail({
  card,
  previewKey,
  rowKey,
  sourceTag,
  isPreviewActive,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  stackStyle,
}: {
  /** Set, the thumbnail is a card of a compact row's stack, placed by it. */
  stackStyle?: CSSProperties;
  /** A card with a thumbnail and a slug. */
  card: PreviewCard & { slug: string };
  /** The strip's own key for the thumbnail (`SidebarPreviewTarget.key`). */
  previewKey: string;
  rowKey: string;
  /** The row's collection; absent on Everything. */
  sourceTag?: string;
  isPreviewActive: boolean;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
}) {
  const target = useMemo<SidebarPreviewTarget>(
    () => ({ key: previewKey, rowKey, slug: card.slug }),
    [card.slug, previewKey, rowKey],
  );
  // The drag is bound on the first press, not when the tile mounts: a strip
  // that widens adds dozens of tiles in one frame, and a draggable each would
  // cost that frame (SPEC_SIDEBAR_STRIP.md, ЛМ5). The press itself starts it.
  const preview = microPreviewFromPreviewCard(card);
  const picture = useMicroPreviewPicture(preview);
  const tileRef = useRef<HTMLDivElement | null>(null);
  const [dragBound, setDragBound] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragPointerListenerRef = useRef<SidebarThumbnailPointerListener | undefined>(undefined);
  const setTileRef = useCallback((node: HTMLDivElement | null) => {
    tileRef.current = node;
    onPreviewTriggerRef(target.key, node);
  }, [onPreviewTriggerRef, target.key]);
  return (
    // No `attributes` from dnd-kit: they would make every thumbnail a tab stop
    // and a button, and the keyboard reaches the list by its rows.
    <div
      ref={setTileRef}
      style={stackStyle}
      className={cn(
        stackStyle ? CHANNEL_ICON_CARD_CLASS : sidebarStripTileClass(preview, picture),
        // A stack's card and a strip's tile answer with their own edge, as a
        // button's does (global.css, «Thumbnail edge»).
        // The source dims as a dragged feed card does.
        isDragging && "opacity-30",
      )}
      onPointerEnter={() => onPreviewEnter(target)}
      onPointerLeave={onPreviewLeave}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPreviewClick(target);
      }}
      onContextMenu={(event) => {
        if (!onPreviewContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onPreviewContextMenu(target, { x: event.clientX, y: event.clientY });
      }}
      onPointerDown={(event) => {
        if (!dragBound) flushSync(() => setDragBound(true));
        dragPointerListenerRef.current?.(event);
        // The row behind is a sortable collection: a press on a thumbnail
        // belongs to the card, and the row it stands in does not move.
        event.stopPropagation();
      }}
      // A stack's card answers as the strip's thumbnail does, under a name
      // of its own: the strip's tiles are what the strip counts.
      data-sidebar-preview-thumbnail={stackStyle ? undefined : "trigger"}
      data-sidebar-stack-card={stackStyle ? "trigger" : undefined}
      data-channel-icon-card={stackStyle ? "" : undefined}
      data-thumb-edge=""
      data-sidebar-preview-active={isPreviewActive ? "true" : undefined}
      data-sidebar-preview-dragging={isDragging ? "true" : undefined}
      data-micro-preview-state={stackStyle ? undefined : picture.state}
    >
      {stackStyle
        ? <MicroPreviewThumbnail preview={preview} fill loading="lazy" decoding="async" draggable={false} />
        : <SidebarStripTileImage preview={preview} picture={picture} />}
      {dragBound && (
        <SidebarThumbnailDrag
          dragId={sidebarThumbnailDragId(target.key)}
          slug={target.slug}
          sourceTag={sourceTag}
          tileRef={tileRef}
          pointerListenerRef={dragPointerListenerRef}
          onDraggingChange={setIsDragging}
        />
      )}
    </div>
  );
});

/// dnd-kit types its listeners as a plain map of functions; with the pointer
/// sensor alone the map holds `onPointerDown`, a React pointer handler.
type SidebarThumbnailPointerListener = (event: ReactPointerEvent<HTMLDivElement>) => void;

/// A thumbnail's drag, bound once the thumbnail is pressed: a drag past the
/// feed's threshold carries the card to a collection like a feed card
/// (SPEC_FRONTEND.md, «Перетаскивание миниатюры»). It draws nothing; the
/// thumbnail's own element is the draggable node.
function SidebarThumbnailDrag({
  dragId,
  slug,
  sourceTag,
  tileRef,
  pointerListenerRef,
  onDraggingChange,
}: {
  dragId: string;
  slug: string;
  sourceTag?: string;
  /** The thumbnail's element, the draggable node. */
  tileRef: { current: HTMLDivElement | null };
  pointerListenerRef: { current: SidebarThumbnailPointerListener | undefined };
  onDraggingChange: (dragging: boolean) => void;
}) {
  // Only the slug: the card itself is the feed's, or is read when the drag
  // begins (App, handleDndStart).
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: {
      type: "block",
      slug,
      sourceTag,
    } satisfies BlockDragData,
  });
  useLayoutEffect(() => {
    setNodeRef(tileRef.current);
    return () => setNodeRef(null);
  }, [setNodeRef, tileRef]);
  useLayoutEffect(() => {
    pointerListenerRef.current = (listeners as { onPointerDown?: SidebarThumbnailPointerListener } | undefined)?.onPointerDown;
  }, [listeners, pointerListenerRef]);
  useLayoutEffect(() => {
    onDraggingChange(isDragging);
  }, [isDragging, onDraggingChange]);
  return null;
}

function SidebarPreviewStrip({
  cards,
  count,
  previewsPending = false,
  previewKeyPrefix,
  rowKey,
  sourceTag,
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
  /** The row's collection, which a thumbnail dragged back onto keeps as is. */
  sourceTag?: string;
  onPreviewEnter: (target: SidebarPreviewTarget) => void;
  onPreviewLeave: () => void;
  onPreviewClick: (target: SidebarPreviewTarget) => void;
  onPreviewContextMenu?: (target: SidebarPreviewTarget, point: CardMenuPoint) => void;
  onPreviewTriggerRef: (key: string, node: HTMLElement | null) => void;
  activePreviewKey: string | null;
  allowHoverPreview?: boolean;
}) {
  // The strip shows as many of the row's cards as its width holds, the whole
  // tiles and the one its edge cuts: widening draws the next cards of the
  // list it already has, narrowing takes the tiles past the edge off the page
  // (SPEC_SIDEBAR_STRIP.md, ЛМ2).
  const [tiles, measureStrip] = useStripTileCount();
  // The count reaches the row before the thumbnails do (startup, a space
  // opening). Until they arrive the strip holds placeholder tiles in the
  // thumbnails' own boxes rather than standing empty; the strip element itself
  // stays the same, so its width, gap and fade never move. While the space's
  // previews are still being built, the read answers with only the thumbnails
  // that exist, so the strip keeps placeholders after them for the cards still
  // waiting: each new thumbnail takes the next slot in place of one.
  const pending = cards === undefined;
  const thumbnails = pending ? [] : firstThumbnails(cards, tiles);
  const placeholderCount = pending || previewsPending
    ? sidebarPreviewPlaceholderCount(count, thumbnails.length, tiles)
    : 0;
  return (
    <div
      ref={measureStrip}
      data-sidebar-thumbnail-strip=""
      data-sidebar-previews={pending ? "pending" : "ready"}
      data-sidebar-preview-fade-width={String(SIDEBAR_PREVIEW_MASK_FADE_WIDTH)}
      className="h-8 min-w-0 flex-1 overflow-hidden"
      style={SIDEBAR_PREVIEW_MASK_STYLE}
    >
      {/* The tiles stand in a track exactly as wide as they are: a width
          that takes no tile on or off moves the strip's edge alone, and the
          tiles are neither laid out nor painted again (ЛМ5). */}
      <div
        className="flex h-8 items-end gap-1"
        style={{ width: sidebarStripTrackWidth(thumbnails.length + placeholderCount) }}
        data-sidebar-strip-track=""
      >
      {thumbnails.map((card, index) => {
        const previewKey = `${previewKeyPrefix}:${card.slug ?? index}:${index}`;
        if (!allowHoverPreview || !card.hasThumb || !hasPreviewSlug(card)) {
          // The lifted copy of a row draws its media without behaviour.
          return <SidebarStripStillTile key={previewKey} card={card} />;
        }
        return (
          <SidebarPreviewThumbnail
            key={previewKey}
            card={card}
            previewKey={previewKey}
            rowKey={rowKey}
            sourceTag={sourceTag}
            isPreviewActive={activePreviewKey === previewKey}
            onPreviewEnter={onPreviewEnter}
            onPreviewLeave={onPreviewLeave}
            onPreviewClick={onPreviewClick}
            onPreviewContextMenu={onPreviewContextMenu}
            onPreviewTriggerRef={onPreviewTriggerRef}
          />
        );
      })}
      {Array.from({ length: placeholderCount }, (_, index) => (
        <div
          key={`placeholder:${index}`}
          aria-hidden="true"
          className={SIDEBAR_PREVIEW_TILE_CLASS}
          data-sidebar-preview-placeholder=""
          data-thumb-edge=""
        />
      ))}
      </div>
    </div>
  );
}

/// The word after a compact item's count: «Element» is the product's name
/// for a card (Open element, Find elements). Wider rows show the bare number,
/// so the style lays the word out in compact rows only (global.css,
/// «Compact rows»).
function SidebarCountNoun({ count }: { count: number }) {
  return <span data-sidebar-count-noun="">{count === 1 ? " element" : " elements"}</span>;
}

/// A compact item's previews: the 7.23 stack of up to three mini-cards at the
/// item's right end (DESIGN_SYSTEM.md, «Компактная строка боковой панели»).
/// Its cards are the strip's first thumbnails and behave as they do: a hover opens the card's preview, a click the card, a right click
/// its menu, a drag carries it. While the thumbnails are on the way the stack
/// holds placeholder cards as the strip holds placeholder tiles. Shown only by
/// the compact rows' style; above the threshold it is not laid out and its
/// images are not asked for.
function SidebarCompactStack({
  cards,
  count,
  previewsPending = false,
  previewKeyPrefix,
  rowKey,
  sourceTag,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewClick,
  onPreviewContextMenu,
  onPreviewTriggerRef,
  activePreviewKey,
  allowHoverPreview = false,
  className,
}: Parameters<typeof SidebarPreviewStrip>[0] & { className?: string }) {
  const pending = cards === undefined;
  const thumbnails = pending ? [] : firstThumbnails(cards, CHANNEL_ICON_MAX_CARDS);
  // The stack holds its own three, whatever the strip's width.
  const placeholderCount = pending || previewsPending
    ? sidebarPreviewPlaceholderCount(count, thumbnails.length, CHANNEL_ICON_MAX_CARDS)
    : 0;
  const total = thumbnails.length + placeholderCount;
  if (total === 0) return null;
  // The collection's first card is the deck's top one: depth follows order.
  const deckStyle = (slot: number) => channelIconCardStyle(total - 1 - slot, total);
  return (
    <ChannelIcon className={className} data-sidebar-compact-stack="">
      {thumbnails.map((card, index) => {
        const previewKey = `${previewKeyPrefix}:stack:${card.slug ?? index}:${index}`;
        const style = deckStyle(index);
        if (!allowHoverPreview || !hasPreviewSlug(card)) {
          // The lifted copy of a row draws its media without behaviour.
          return (
            <div key={previewKey} className={CHANNEL_ICON_CARD_CLASS} style={style} data-channel-icon-card="" data-thumb-edge="">
              <MicroPreviewThumbnail preview={microPreviewFromPreviewCard(card)} fill loading="lazy" draggable={false} />
            </div>
          );
        }
        return (
          <SidebarPreviewThumbnail
            key={previewKey}
            card={card}
            previewKey={previewKey}
            rowKey={rowKey}
            sourceTag={sourceTag}
            isPreviewActive={activePreviewKey === previewKey}
            onPreviewEnter={onPreviewEnter}
            onPreviewLeave={onPreviewLeave}
            onPreviewClick={onPreviewClick}
            onPreviewContextMenu={onPreviewContextMenu}
            onPreviewTriggerRef={onPreviewTriggerRef}
            stackStyle={style}
          />
        );
      })}
      {Array.from({ length: placeholderCount }, (_, offset) => (
        <div
          key={`placeholder:${offset}`}
          aria-hidden="true"
          className={CHANNEL_ICON_CARD_CLASS}
          style={deckStyle(thumbnails.length + offset)}
          data-channel-icon-card=""
          data-thumb-edge=""
          data-sidebar-stack-placeholder=""
        />
      ))}
    </ChannelIcon>
  );
}

function InlineChannelNameEditor({
  placeholder,
  defaultValue = "",
  ariaLabel,
  submitAction,
  edit,
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
  /** The name's edit (`useNameEdit`): the field opening begins it. */
  edit: NameEdit;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // The field stays uncontrolled; only whether it holds a name is kept, so
  // the submit button is unavailable until one is typed (08.10.2026).
  const [isEmpty, setIsEmpty] = useState(() => defaultValue.trim() === "");

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    // Once per field: it opens, the edit begins.
    edit.begin(input.value);
  }, []);

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
        aria-invalid={edit.notice !== null}
        // A refused name shakes once and takes no typing meanwhile.
        readOnly={edit.refused}
        data-name-refused={edit.refused ? "" : undefined}
        style={{ animationDuration: `${NAME_REFUSED_SHAKE_MS}ms` }}
        spellCheck={false}
        autoComplete="off"
        onClick={(e) => {
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
        onChange={(e) => {
          setIsEmpty(e.currentTarget.value.trim() === "");
          edit.change(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            edit.submit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            edit.cancel();
          }
        }}
        onBlur={(e) => edit.leave(e.currentTarget.value)}
      />
      {submitAction && (
        <button
          type="button"
          aria-label={submitAction.label}
          aria-keyshortcuts={submitAction.shortcutKey}
          // An empty name has nothing to submit: the button is unavailable
          // (DESIGN_SYSTEM.md, «Недоступно»), Enter still closes the field.
          disabled={isEmpty}
          // Placed like a row's Connect button: 8px from the zone's edges,
          // the zone's width less those 8px on both sides.
          className={cn(
            SIDEBAR_ROW_ACTION_BUTTON_CLASS,
            "absolute top-1/2 z-10 -translate-y-1/2 gap-[1ch] px-[1ch]",
            "disabled:pointer-events-none disabled:text-tertiary-foreground",
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
            edit.submit(ref.current?.value ?? "");
          }}
        >
          <span>{submitAction.label}</span>
          <span
            // Set like the bottom bar's hotkeys; dims with the button.
            className={cn(
              "font-mono text-sm font-normal",
              isEmpty ? "text-tertiary-foreground" : "text-muted-foreground",
            )}
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
  const strip = {
    cards,
    count,
    previewsPending,
    previewKeyPrefix: "drag-preview",
    rowKey: "drag-preview",
    onPreviewEnter: DRAG_PREVIEW_NOOP,
    onPreviewLeave: DRAG_PREVIEW_NOOP,
    onPreviewClick: DRAG_PREVIEW_NOOP,
    onPreviewTriggerRef: DRAG_PREVIEW_NOOP,
    activePreviewKey: null,
  };
  return (
    // As wide as the row it lifts (the overlay takes the row's box), so the
    // compact rows' threshold reads the same width here as in the list
    // (global.css, «Compact rows»); the border is inside it.
    <div className="h-full w-full" data-sidebar-drag-row="">
    <div
      className="flex h-full w-full items-center rounded-1 border border-border bg-sidebar shadow-md"
      data-sidebar-tag-drag-preview=""
    >
      {/* The row's inset is the name cell's own, as in the resting row. */}
      <div className="relative flex w-full min-w-0 items-center py-1 font-sans text-base text-muted-foreground" data-sidebar-row-body="">
        <SidebarRowTitleCell>{label}</SidebarRowTitleCell>
        <SidebarPreviewRail meta={<SidebarCompactStack {...strip} />}>
          <SidebarPreviewStrip {...strip} />
        </SidebarPreviewRail>
        <span
          className="absolute inset-y-0 right-[calc(var(--sidebar-meta-right,0px)+var(--sidebar-row-pad-x))] flex w-8 -translate-x-px items-center justify-end text-right font-mono text-sm"
          data-sidebar-row-text=""
          data-sidebar-meta-count=""
          ref={trackTextClip}
          // A compact item's second line dissolves as the name does (global.css).
          style={SIDEBAR_ROW_TEXT_MASK_STYLE}
        >
          {count || ""}
          {count ? <SidebarCountNoun count={count} /> : null}
        </span>
      </div>
    </div>
    </div>
  );
}
