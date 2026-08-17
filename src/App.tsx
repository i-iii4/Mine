import {
  Suspense,
  lazy,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  useOutletContext,
  useNavigate,
  useLocation,
} from "react-router";
import { X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  TAG_ROW_DROP_ANIMATION,
  TAG_ROW_OVERLAY_MODIFIERS,
} from "@/lib/tagRowDragOverlay";
import { arrayMove } from "@dnd-kit/sortable";
import { applyPendingTagOrder } from "@/lib/collectionOrder";
import { collectionRefLabel } from "@/lib/collections";
import { reconcileBlocks } from "@/lib/blockIdentity";
import { refreshPageLimit } from "@/lib/gridPaging";
import { imageCardNeedsGeometryRefresh } from "@/lib/cardHeight";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";
import { cn } from "@/lib/utils";
import {
  isDetailShortcutBlockedTarget,
  isEditableKeyboardTarget,
  isOverlayKeyboardTarget,
} from "@/lib/keyboardTargets";
import {
  SIDEBAR_CREATE_CHANNEL_ROW_KEY,
  buildSidebarSearchNavigationRows,
  sidebarRowDomId,
  sidebarRowKeyToRoute,
} from "@/lib/sidebarSearch";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import {
  BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY,
  getStoredBottomActionBarHidden,
} from "@/lib/bottomActionBarVisibility";
import {
  SCROLL_EDGE_FADE_STORAGE_KEY,
  getStoredScrollEdgeFade,
} from "@/lib/scrollEdgeFade";
import { DENSITY_STORAGE_KEY, applyDensity, getStoredDensity } from "@/lib/density";
import {
  ACTION_BUTTON_STYLE_STORAGE_KEY,
  applyActionButtonStyle,
  getStoredActionButtonStyle,
} from "@/lib/actionButtonStyle";
import {
  CARD_RADIUS_STORAGE_KEY,
  applyCardRadius,
  getStoredCardRadius,
} from "@/lib/cardRadius";
import {
  useNativeWindowChromeSurface,
  type NativeWindowChromeSurfaceToken,
} from "@/lib/nativeWindowChromeSurface";
import { Input } from "@/components/ui/input";
import { CardPointMenu } from "@/components/CardHoverMenu";
import {
  CompactDetailLinkModeSwitch,
  CompactDetailTopMenu,
  MainSecondaryTopBar,
  getStoredMainViewMode,
  persistMainViewMode,
  type DetailLinkMode,
  type MainViewMode,
} from "@/components/MainSecondaryChrome";

type CardActionsMenuTarget = {
  block: LightBlock | IndexedBlock;
  x: number;
  y: number;
  sequence: number;
};

function baseRelatedNoteSlug(target: string): string {
  return target.split("#", 1)[0] ?? target;
}

function relatedNoteBlockAnchor(target: string): string | null {
  const fragment = target.split("#", 2)[1];
  if (!fragment?.startsWith("^")) return null;
  const blockId = fragment.slice(1).trim();
  return blockId || null;
}

function blockMarkdownPath(vaultPath: string, slug: string): string {
  return `${vaultPath.replace(/\/+$/, "")}/${slug.replace(/^\/+/, "")}.md`;
}

function historyDirectionForShortcut(e: KeyboardEvent): -1 | 1 | null {
  if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return null;
  if (e.key === "[" || e.code === "BracketLeft") return -1;
  if (e.key === "]" || e.code === "BracketRight") return 1;
  return null;
}

function isSearchShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.altKey || e.ctrlKey) return false;
  return e.code === "KeyF" || e.key.toLowerCase() === "f";
}

function isToggleSidebarShortcut(e: KeyboardEvent): boolean {
  return (
    e.metaKey
    && e.ctrlKey
    && !e.shiftKey
    && !e.altKey
    && (e.code === "KeyS" || e.key.toLowerCase() === "s")
  );
}

/** Pin the DragOverlay so the cursor tip sits just outside the top-left corner. */
const snapToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const e = activatorEvent as PointerEvent;
  const INSET = 4; // cursor tip peeks past the border-radius
  return {
    ...transform,
    x: transform.x + (e.clientX - draggingNodeRect.left) - INSET,
    y: transform.y + (e.clientY - draggingNodeRect.top) - INSET,
  };
};

/// A card/media/text drag snaps the overlay to the cursor tip and drops with
/// no return flight — the payload lands in a collection, not back in the feed.
/// The collection-row dressing is the opposite and lives in
/// `lib/tagRowDragOverlay` so the audit route measures the same gesture.
const POINT_OVERLAY_MODIFIERS: Modifier[] = [snapToCursor];

const BATCH_TAG_REFRESH_DELAY_MS = 750;
function fetchGridBlocks(
  tag: string | undefined,
  offset: number,
  limit: number,
) {
  return listGridBlocks(tag, offset, limit);
}

import type {
  DeleteBlockPlan,
  IndexedBlock,
  LightBlock,
  TagCount,
  ChannelDto,
  GridSnapshot,
  MediaAssetRef,
  ProjectionRevision,
  VaultStats,
} from "@/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  getVaultPath,
  getUnavailableVault,
  openVault,
  selectVault,
  startVaultSync,
  getVaultStats,
  listGridBlocks,
  listTaxonomySnapshot,
  createChannel,
  deleteChannel,
  reorderChannels,
  renameChannel,
  renameBlockFile,
  prepareDeleteBlock,
  deleteTagFromAll,
  addTag,
  removeTag,
  deleteBlock,
  mergeBlocks,
  getBlock,
  createMediaAssetCard,
  renameMediaAsset,
  deleteMediaAsset,
  removeMediaAssetFromCard,
  extractTextSelection,
  deleteTextSelection,
  sweepVaultThumbnails,
  openSettingsWindow,
  setSidebarMenuCollapsed,
} from "@/lib/commands";
import { ArticleAudioGatewayProvider } from "@/lib/articleAudioGateway";
import { desktopArticleAudioGateway } from "@/lib/articleAudioDesktopGateway";
import { ARTICLE_AUDIO_ENABLED } from "@/lib/featureFlags";
import { pushRecentTag } from "@/lib/recentTags";
import {
  resolveBlockDragBlocks,
  resolveBlockDragSlugs,
  uniqueDragSlugs,
  type BlockDragData,
} from "@/lib/blockDrag";
import { sidebarPointerWithin } from "@/lib/sidebarDndCollision";
import {
  clearActiveMineTextSelectionDragPayload,
  getActiveMineTextSelectionDragPayload,
  type MineTextSelectionDragPayload,
} from "@/lib/textSelectionDrag";
import { useSidebarResize } from "@/hooks/useSidebarResize";
import { useThumbnailUpgrade } from "@/hooks/useThumbnailUpgrade";
import { useChannelPreviewsEvents } from "@/hooks/useChannelPreviewsEvents";
import { useChromeDragGesture } from "@/hooks/useChromeDragGesture";
import { useProjectionRevisionOwner } from "@/hooks/useProjectionRevisionOwner";
import { VaultPicker } from "@/components/VaultPicker";
import { SpaceUnavailable } from "@/components/SpaceUnavailable";
import { VaultSwitcher } from "@/components/VaultSwitcher";
import { TopCollectionSwitcher } from "@/components/TopCollectionSwitcher";
import { Sidebar, SidebarTagRowDragPreview } from "@/components/Sidebar";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { ClipperRecoveryBanner } from "@/components/ClipperRecoveryBanner";
import { VaultConflictsBanner } from "@/components/VaultConflictsBanner";
import { Grid } from "@/components/Grid";
import { GraphView } from "@/components/GraphView";
import { DragCardStackPreview } from "@/components/Card";
import { ActionButton } from "@/components/ActionButton";
import { applyTheme, getStoredTheme, THEME_STORAGE_KEY } from "@/lib/themeMode";
import {
  applyDesign,
  getStoredDesignMode,
  DESIGN_STORAGE_KEY,
} from "@/lib/designMode";
import {
  COMPACT_DETAIL_TOP_MENU_STORAGE_KEY,
  getStoredCompactDetailTopMenu,
} from "@/lib/compactDetailTopMenuVisibility";
import {
  getStoredGraphPreferences,
  GRAPH_PREFERENCES_STORAGE_KEY,
  type GraphPreferences,
} from "@/lib/graphPreferences";
import {
  SETTINGS_CHANGED_EVENT,
  type SettingsChangedPayload,
} from "@/lib/settingsChanged";
import { RenameBlockDialog } from "@/components/RenameBlockDialog";
import { SearchOverlay } from "@/components/SearchOverlay";
import { DeleteBlockDialog } from "@/components/DeleteBlockDialog";
import {
  ImagePreviewOverlay,
  type ImagePreviewRequest,
} from "@/components/ImagePreviewOverlay";
import { copyTextToClipboard } from "@/lib/clipboard";

const Detail = lazy(async () => {
  const mod = await import("@/components/Detail");
  return { default: mod.Detail };
});


const DropZone = lazy(async () => {
  const mod = await import("@/components/DropZone");
  return { default: mod.DropZone };
});

const ComponentTestBench = lazy(async () => {
  const mod = await import("@/components/ComponentTestBench");
  return { default: mod.ComponentTestBench };
});

const GRID_PAGE_SIZE = 200;
const DETAIL_SECONDARY_CHROME_EXIT_MS = 190;
const DETAIL_COMPACT_CHROME_EXIT_MS = 260;

interface VaultChangedEvent {
  path: string;
}

interface VaultSyncStartedEvent {
  path: string;
}

interface VaultSyncFinishedEvent {
  path: string;
  indexed: number;
  errors: number;
  error: string | null;
}

interface BlockAddedEvent {
  slug: string;
  tags: string[];
  is_text: boolean;
}

type SurfaceSearchShortcutTarget = "main" | "sidebar";

type MediaAssetDragPayload = {
  type: "media_asset";
  asset: MediaAssetRef & { media_kind: "image" };
  imageSrc?: string;
};

type MediaAssetDragPreview = {
  src: string;
};

type TextSelectionDragPreview = {
  selectedText: string;
};

type PendingCreateChannelDrop =
  | { type: "block"; slug: string }
  | { type: "blocks"; slugs: string[] }
  | { type: "media_asset"; payload: MediaAssetDragPayload }
  | { type: "text_selection"; payload: MineTextSelectionDragPayload };

interface BlockRemovedEvent {
  slug: string;
  tags: string[];
}

interface BlockRenamedEvent {
  old_slug: string;
  new_slug: string;
}

interface ThumbUpdatedEvent {
  slug: string;
  is_text: boolean;
}

// ─── Root ──────────────────────────────────────────────────────────────────

export function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [unavailablePath, setUnavailablePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const started = performance.now();
    console.info("[startup] getVaultPath:start");
    getVaultPath()
      .then(async (path) => {
        console.info("[startup] getVaultPath:done", {
          path,
          elapsedMs: Math.round(performance.now() - started),
        });
        setVaultPath(path);
        // No path may mean two very different things: nothing was ever chosen,
        // or the chosen folder is unreachable at the moment. Only the second
        // deserves an explanation instead of a first-run screen.
        if (!path) {
          const unavailable = await getUnavailableVault().catch(() => null);
          setUnavailablePath(unavailable?.path ?? null);
        }
      })
      .catch((err) => {
        console.error("[startup] getVaultPath:failed", err);
        setVaultPath(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // A space switch may originate in another window (settings). The backend
  // broadcasts every select_vault; key={vaultPath} below re-mounts the app.
  // Switches initiated here resolve to the same path — an idempotent set.
  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<{ path: string }>("vault-selected", (event) => {
      if (cancelled) return;
      setVaultPath(event.payload.path);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <p className="text-base text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!vaultPath && unavailablePath) {
    return (
      <div className="h-screen w-screen">
        <SpaceUnavailable
          path={unavailablePath}
          onReopened={(path) => {
            setUnavailablePath(null);
            setVaultPath(path);
          }}
          onForgotten={() => setUnavailablePath(null)}
        />
      </div>
    );
  }

  if (!vaultPath) {
    return <VaultPicker onVaultSelected={setVaultPath} />;
  }

  const routedApp = (
    <BrowserRouter>
      <AppWithVault
        key={vaultPath}
        vaultPath={vaultPath}
        onVaultSelected={setVaultPath}
      />
    </BrowserRouter>
  );

  // With article audio switched off nothing consumes the gateway, so the
  // provider is not mounted either — see ARTICLE_AUDIO_ENABLED.
  return ARTICLE_AUDIO_ENABLED ? (
    <ArticleAudioGatewayProvider gateway={desktopArticleAudioGateway}>
      {routedApp}
    </ArticleAudioGatewayProvider>
  ) : (
    routedApp
  );
}

// ─── Main app (vault selected) ─────────────────────────────────────────────

export function AppWithVault({
  vaultPath,
  onVaultSelected,
}: {
  vaultPath: string;
  onVaultSelected: (path: string) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const projectionRevisionOwner = useProjectionRevisionOwner();

  const currentTag = location.pathname.startsWith("/channel/")
    ? decodeURIComponent(location.pathname.slice("/channel/".length))
    : undefined;

  const [blocks, setBlocks] = useState<LightBlock[]>([]);
  // Cards whose action menu is open. While a menu is open its card stays in the
  // feed even if an edit made it fail the current collection filter — the write
  // already happened, only the reflow waits, so the menu does not slide out from
  // under the pointer halfway through a gesture.
  const [heldSlugs, setHeldSlugs] = useState<ReadonlySet<string>>(() => new Set());
  const heldSlugsRef = useRef(heldSlugs);
  heldSlugsRef.current = heldSlugs;
  // Per-slug feed thumbnail cache-buster. A `thumb:updated` event bumps the
  // affected slug so its mounted card re-renders and refetches the regenerated
  // poster/thumbnail (see Grid `thumbVersions`), without invalidating the route
  // cache or refetching the whole scrolled range through IPC.
  const [feedThumbVersions, setFeedThumbVersions] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [totalBlocks, setTotalBlocks] = useState(0);
  const [gridSnapshotIdentity, setGridSnapshotIdentity] = useState<{
    routeKey: string;
    generation: number;
  } | null>(null);
  const [vaultStats, setVaultStats] = useState<VaultStats | null>(null);
  const [hasMoreBlocks, setHasMoreBlocks] = useState(false);
  const [loadingMoreBlocks, setLoadingMoreBlocks] = useState(false);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [designSystemOpen, setDesignSystemOpen] = useState(false);
  const [compactDetailTopMenuEnabled, setCompactDetailTopMenuEnabled] = useState(
    getStoredCompactDetailTopMenu,
  );
  const [bottomActionBarHidden, setBottomActionBarHidden] = useState(
    getStoredBottomActionBarHidden,
  );
  const [graphPreferences, setGraphPreferences] = useState(
    getStoredGraphPreferences,
  );
  const [scrollEdgeFade, setScrollEdgeFade] = useState(getStoredScrollEdgeFade);
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>(getStoredMainViewMode);
  const [imagePreview, setImagePreview] = useState<ImagePreviewRequest | null>(null);
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [pendingCreateChannelDrop, setPendingCreateChannelDrop] =
    useState<PendingCreateChannelDrop | null>(null);
  const [renamingBlock, setRenamingBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [cardActionsMenuTarget, setCardActionsMenuTarget] =
    useState<CardActionsMenuTarget | null>(null);
  const [selectedBlockAnchor, setSelectedBlockAnchor] = useState<string | null>(null);
  const [selectedBlockTags, setSelectedBlockTags] = useState<string[]>([]);
  const [detailLinkMode, setDetailLinkMode] = useState<DetailLinkMode>("all");
  const [deleteTargetSlug, setDeleteTargetSlug] = useState<string | null>(null);
  const [deletePlan, setDeletePlan] = useState<DeleteBlockPlan | null>(null);
  const [deletePlanError, setDeletePlanError] = useState<string | null>(null);
  const [detailChromeClosing, setDetailChromeClosing] = useState(false);
  const [closingDetailBlock, setClosingDetailBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [closingDetailTags, setClosingDetailTags] = useState<string[]>([]);
  const [gridFocusRestore, setGridFocusRestore] = useState<{
    slug: string;
    sequence: number;
  } | null>(null);
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  // Query survives the session: reopening shows it selected (SPEC_SEARCH_OVERLAY).
  const [searchOverlayQuery, setSearchOverlayQuery] = useState("");
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const sidebarSearchHasValue = sidebarSearchQuery.length > 0;
  const sidebarSearchHasActiveQuery = sidebarSearchQuery.trim().length > 0;
  const [sidebarSearchFocusSequence, setSidebarSearchFocusSequence] = useState(0);
  const [scrollToTopSignal, setScrollToTopSignal] = useState(0);
  const [sidebarKeyboardNavigationFocus, setSidebarKeyboardNavigationFocus] = useState<{
    rowKey: string;
    sequence: number;
  } | null>(null);
  const [sidebarSearchKeyboardNavigationFocus, setSidebarSearchKeyboardNavigationFocus] = useState<{
    rowKey: string;
    sequence: number;
  } | null>(null);
  const [activeDragBlocks, setActiveDragBlocks] = useState<LightBlock[]>([]);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);
  /// Which dressing the DragOverlay wears. Set on drag start and deliberately
  /// NOT reset on drag end: the drop animation outlives the drag state, and
  /// swapping modifiers or dropAnimation mid-flight would cancel it.
  const [overlayDressing, setOverlayDressing] = useState<"row" | "point">("point");
  /// Collection order produced by a drop, shown until the reload confirms it.
  const [pendingTagOrder, setPendingTagOrder] = useState<string[] | null>(null);
  const [activeDragMediaAsset, setActiveDragMediaAsset] = useState<MediaAssetDragPreview | null>(null);
  const [activeDragTextSelection, setActiveDragTextSelection] = useState<TextSelectionDragPreview | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const sidebarSearchInputRef = useRef<HTMLInputElement>(null);
  const lastSidebarSearchFocusSequenceRef = useRef(0);
  const sidebarSearchChromeDragGesture = useChromeDragGesture();
  const [compactDetailTopMenuRequestSequence, setCompactDetailTopMenuRequestSequence] = useState(0);
  const [compactDetailChromeEntered, setCompactDetailChromeEntered] = useState(false);
  const gridColumnCountRef = useRef(1);
  const suppressRedirectRef = useRef(false);
  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;
  const currentTagRef = useRef(currentTag);
  currentTagRef.current = currentTag;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const loadRequestIdRef = useRef(0);
  const taxonomyRequestIdRef = useRef(0);
  const vaultStatsRequestIdRef = useRef(0);
  const vaultStatsFrameRef = useRef<number | null>(null);
  const routeSnapshotCacheRef = useRef<Map<string, GridSnapshot>>(new Map());
  const gridGenerationRef = useRef<number | null>(null);
  const warmRoutePageBufferRef = useRef<Set<string>>(new Set());
  const paginationRequestRef = useRef<object | null>(null);
  const cardActionsMenuSequenceRef = useRef(0);
  const lastRevalidatedRouteKeyRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const detailCloseTimerRef = useRef<number | null>(null);
  const pendingRefreshRef = useRef({
    grid: false,
    taxonomy: false,
    previews: false,
  });
  const [isSyncing, setIsSyncing] = useState(true);
  const [vaultReady, setVaultReady] = useState(false);
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [thumbsRootPath, setThumbsRootPath] = useState<string | null>(null);
  const activeDragBlock = activeDragBlocks[0] ?? null;

  const routeKeyFor = useCallback((tag?: string) => tag ?? "__all__", []);

  const cancelPendingDetailClose = useCallback(() => {
    if (detailCloseTimerRef.current !== null) {
      window.clearTimeout(detailCloseTimerRef.current);
      detailCloseTimerRef.current = null;
    }
    setDetailChromeClosing(false);
    setClosingDetailBlock(null);
    setClosingDetailTags([]);
  }, []);

  useEffect(() => {
    return () => {
      if (detailCloseTimerRef.current !== null) {
        window.clearTimeout(detailCloseTimerRef.current);
      }
    };
  }, []);

  const requestGridFocusRestore = useCallback((slug: string) => {
    setGridFocusRestore((current) => ({
      slug,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }, []);

  const openDetailBlock = useCallback((
    block: LightBlock | IndexedBlock,
    anchor: string | null = null,
  ) => {
    cancelPendingDetailClose();
    setCardActionsMenuTarget(null);
    setSelectedBlockAnchor(anchor);
    setSelectedBlock(block);
  }, [cancelPendingDetailClose]);

  const openCardActionsMenu = useCallback((
    block: LightBlock | IndexedBlock,
    point: { x: number; y: number },
  ) => {
    cardActionsMenuSequenceRef.current += 1;
    setCardActionsMenuTarget({
      block,
      x: point.x,
      y: point.y,
      sequence: cardActionsMenuSequenceRef.current,
    });
  }, []);

  const applyGridSnapshot = useCallback((tag: string | undefined, grid: GridSnapshot): boolean => {
    if (!projectionRevisionOwner.accept("grid", grid.generation)) {
      return false;
    }
    gridGenerationRef.current = grid.generation;
    const routeKey = routeKeyFor(tag);
    routeSnapshotCacheRef.current.set(routeKey, grid);
    // Preserve object identity for blocks whose content did not change so a
    // no-op refresh does not invalidate the grid's downstream memos or remount
    // any cards.
    setBlocks((prev) => reconcileBlocks(prev, grid.blocks, heldSlugsRef.current));
    setGridSnapshotIdentity({ routeKey, generation: grid.generation });
    setTotalBlocks(grid.total_blocks);
    setHasMoreBlocks(grid.has_more);
    setLoadingMoreBlocks(false);
    return true;
  }, [projectionRevisionOwner, routeKeyFor]);

  const invalidateRouteSnapshots = useCallback(() => {
    routeSnapshotCacheRef.current.clear();
    warmRoutePageBufferRef.current.clear();
    lastRevalidatedRouteKeyRef.current = null;
  }, []);

  // Bump the feed cache-buster for a slug that is currently in the loaded feed.
  // Slugs outside the feed are ignored — their card is not mounted, so there is
  // nothing to refetch. This re-renders only the affected card (Grid keys the
  // version per GridItem), not the whole feed.
  const bumpFeedThumbVersion = useCallback((slug: string) => {
    if (!blocksRef.current.some((block) => block.slug === slug)) return;
    setFeedThumbVersions((prev) => {
      const next = new Map(prev);
      next.set(slug, (prev.get(slug) ?? 0) + 1);
      return next;
    });
  }, []);

  // Redirect if navigated to a channel that doesn't exist (check both tags and channels)
  useEffect(() => {
    if (suppressRedirectRef.current) return;
    if (currentTag && (tags.length > 0 || channels.length > 0)
      && !tags.some((t) => t.tag === currentTag)
      && !channels.some((c) => c.tag === currentTag)) {
      navigate("/");
    }
  }, [currentTag, tags, channels, navigate]);

  const activeBlocks = blocks;
  const gridRouteSnapshotReady =
    gridSnapshotIdentity?.routeKey === routeKeyFor(currentTag);
  const renderedDetailBlock = selectedBlock ?? closingDetailBlock;
  const renderedLinkedBlockSlug = selectedBlock?.slug
    ?? (detailChromeClosing ? closingDetailBlock?.slug ?? null : null);
  const renderedLinkedTags = selectedBlock
    ? selectedBlockTags
    : (detailChromeClosing ? closingDetailTags : []);
  const compactDetailTopMenuActive = compactDetailTopMenuEnabled && renderedDetailBlock !== null;
  const mainSecondaryTopBarVisible = !compactDetailTopMenuActive;
  const detailChromeCloseDuration = compactDetailTopMenuActive
    ? DETAIL_COMPACT_CHROME_EXIT_MS
    : DETAIL_SECONDARY_CHROME_EXIT_MS;
  const topChromeSurfaceClass = "bg-chrome";
  const topChromeSurfaceToken: NativeWindowChromeSurfaceToken = "--chrome";
  const sidebarSearchActiveSurfaceClass = sidebarSearchHasActiveQuery
    ? "bg-accent"
    : "";
  const compactDetailCardTitle = renderedDetailBlock
    ? renderedDetailBlock.title ?? renderedDetailBlock.media_file ?? `${renderedDetailBlock.slug}.md`
    : "";
  const gridKeyboardNavigationDisabled = Boolean(renderedDetailBlock)
    || designSystemOpen
    || renamingBlock !== null
    || deleteTargetSlug !== null
    || isCreatingChannel;
  useEffect(() => {
    window.localStorage.setItem(
      COMPACT_DETAIL_TOP_MENU_STORAGE_KEY,
      compactDetailTopMenuEnabled ? "true" : "false",
    );
  }, [compactDetailTopMenuEnabled]);

  useNativeWindowChromeSurface(topChromeSurfaceToken);

  useEffect(() => {
    window.localStorage.setItem(
      BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY,
      bottomActionBarHidden ? "true" : "false",
    );
  }, [bottomActionBarHidden]);

  useEffect(() => {
    if (!renderedDetailBlock || detailChromeClosing) {
      setCompactDetailChromeEntered(false);
      return;
    }
    setCompactDetailChromeEntered(false);
    const frame = window.requestAnimationFrame(() => {
      setCompactDetailChromeEntered(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailChromeClosing, renderedDetailBlock]);

  useEffect(() => {
    setImagePreview(null);
  }, [selectedBlock?.slug]);

  const handleColumnCountChange = useCallback((n: number) => {
    gridColumnCountRef.current = n;
  }, []);

  // Close Detail when navigating to a different route. Feed keyboard focus is
  // owned by Grid and resets with the route-scoped Grid instance.
  useEffect(() => {
    cancelPendingDetailClose();
    setSelectedBlock(null);
    setSelectedBlockAnchor(null);
    setGridFocusRestore(null);
  }, [location.pathname, cancelPendingDetailClose]);

  // ── Sidebar resize ──────────────────────────────────────────────────────
  const {
    width: sidebarWidth,
    collapsed: sidebarCollapsed,
    isResizing: sidebarResizing,
    startResize,
    updateResize,
    endResize,
    toggleCollapsed,
  } = useSidebarResize();

  useEffect(() => {
    if (!isTauri()) return;
    void setSidebarMenuCollapsed(sidebarCollapsed).catch((error) => {
      console.error("Failed to synchronize the native sidebar menu:", error);
    });
  }, [sidebarCollapsed]);

  const topCollectionSwitcherCompact = sidebarCollapsed || compactDetailTopMenuEnabled;


  // ── dnd-kit sensors ────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // ── Channel preview cards (sidebar thumbnails) ─────────────────────────
  //
  // Derived state: the hook owns only the current snapshot + cache-buster
  // versions. All invalidation scheduling now lives in App.tsx so grid,
  // taxonomy and previews share one coalesced refresh loop.

  const { channelPreviews, refresh: loadPreviews, bumpThumbVersion } = useChannelPreviewsEvents({
    thumbsRootPath: vaultReady ? thumbsRootPath : null,
    limit: 20,
    revisionOwner: projectionRevisionOwner,
  });

  // Phase 2 thumbnail upgrade pipeline: Web Worker decodes webp/heic/
  // video media via the browser's native decoder and writes real JPEG
  // bytes back through save_thumb. Mounts once vault is open.
  useThumbnailUpgrade(vaultReady);

  const [loadError, setLoadError] = useState<string | null>(null);

  const invalidateRoutesForTags = useCallback((affectedTags: readonly string[]) => {
    const allRouteKey = routeKeyFor(undefined);
    routeSnapshotCacheRef.current.delete(allRouteKey);
    warmRoutePageBufferRef.current.delete(allRouteKey);
    for (const tag of affectedTags) {
      const routeKey = routeKeyFor(tag);
      routeSnapshotCacheRef.current.delete(routeKey);
      warmRoutePageBufferRef.current.delete(routeKey);
    }
    lastRevalidatedRouteKeyRef.current = null;
  }, [routeKeyFor]);

  const loadGridSnapshot = useCallback(async ({
    tag = currentTagRef.current,
    preferCachedRoute = false,
    invalidateCachedRoutes = false,
    preserveLoadedRange = false,
  }: {
    tag?: string;
    preferCachedRoute?: boolean;
    invalidateCachedRoutes?: boolean;
    /**
     * When refreshing the currently displayed route, re-fetch the whole loaded
     * range (all pages the user has scrolled through) instead of just the
     * first page. Without this a refresh after a vault change would truncate a
     * deep feed back to one page, collapsing the viewport and jumping the
     * scroll position.
     */
    preserveLoadedRange?: boolean;
  } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    paginationRequestRef.current = null;
    setLoadingMoreBlocks(false);
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = tag;
    const routeKey = routeKeyFor(tagAtStart);
    const started = performance.now();
    if (invalidateCachedRoutes) {
      invalidateRouteSnapshots();
    }
    if (preferCachedRoute) {
      const cached = routeSnapshotCacheRef.current.get(routeKey);
      if (cached) {
        applyGridSnapshot(tagAtStart, cached);
        setLoadError(null);
      }
    }
    console.info("[startup] loadGrid:start", {
      requestId,
      tag: tagAtStart ?? "__all__",
      preferCachedRoute,
    });
    // The refresh path always targets the current route, so the loaded block
    // count is that route's loaded range. Round up to a whole number of pages
    // (minimum one) so the backend returns the full contiguous span.
    const loadedCount = preserveLoadedRange ? blocksRef.current.length : 0;
    const pageLimit = refreshPageLimit(loadedCount, GRID_PAGE_SIZE);
    try {
      const grid = await fetchGridBlocks(tagAtStart, 0, pageLimit);
      if (
        loadRequestIdRef.current !== requestId
        || vaultPathRef.current !== pathAtStart
        || currentTagRef.current !== tagAtStart
      ) {
        return;
      }
      if (!applyGridSnapshot(tagAtStart, grid)) {
        return;
      }
      setLoadError(null);
      window.dispatchEvent(new Event("vault-refreshed"));
      console.info("[startup] loadGrid:done", {
        requestId,
        blocks: grid.blocks.length,
        elapsedMs: Math.round(performance.now() - started),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        loadRequestIdRef.current === requestId
        && vaultPathRef.current === pathAtStart
        && currentTagRef.current === tagAtStart
      ) {
        console.error("[LOAD_GRID] FAILED:", msg, err);
        setLoadError(msg);
      }
      console.error("[startup] loadGrid:failed", {
        requestId,
        tag: tagAtStart ?? "__all__",
        elapsedMs: Math.round(performance.now() - started),
        error: msg,
      });
    }
  }, [applyGridSnapshot, invalidateRouteSnapshots, routeKeyFor]);

  const loadTaxonomySnapshotState = useCallback(async () => {
    const requestId = ++taxonomyRequestIdRef.current;
    const pathAtStart = vaultPathRef.current;
    const started = performance.now();
    console.info("[startup] loadTaxonomy:start", { requestId });
    try {
      const snapshot = await listTaxonomySnapshot();
      if (
        taxonomyRequestIdRef.current !== requestId
        || vaultPathRef.current !== pathAtStart
      ) {
        return;
      }
      if (!projectionRevisionOwner.accept("taxonomy", snapshot.generation)) {
        return;
      }
      setTags(snapshot.tags);
      setChannels(snapshot.channels);
      setTotalBlocks(snapshot.total_blocks);
      setLoadError(null);
      console.info("[startup] loadTaxonomy:done", {
        requestId,
        tags: snapshot.tags.length,
        channels: snapshot.channels.length,
        elapsedMs: Math.round(performance.now() - started),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        taxonomyRequestIdRef.current === requestId
        && vaultPathRef.current === pathAtStart
      ) {
        console.error("[LOAD_TAXONOMY] FAILED:", msg, err);
        setLoadError(msg);
      }
      console.error("[startup] loadTaxonomy:failed", {
        requestId,
        elapsedMs: Math.round(performance.now() - started),
        error: msg,
      });
    }
  }, [projectionRevisionOwner]);

  const acceptGraphRevision = useCallback(
    (revision: ProjectionRevision) => projectionRevisionOwner.accept("graph", revision),
    [projectionRevisionOwner],
  );

  const loadVaultStats = useCallback(async (tag = currentTagRef.current) => {
    const requestId = ++vaultStatsRequestIdRef.current;
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = tag ?? null;
    try {
      const stats = await getVaultStats(tagAtStart);
      if (
        vaultStatsRequestIdRef.current !== requestId
        || vaultPathRef.current !== pathAtStart
        || (currentTagRef.current ?? null) !== tagAtStart
      ) {
        return;
      }
      setVaultStats(stats);
    } catch (err) {
      console.warn("[VAULT_STATS] failed:", err);
    }
  }, []);

  const loadGridSnapshotRef = useRef(loadGridSnapshot);
  loadGridSnapshotRef.current = loadGridSnapshot;
  const loadTaxonomySnapshotRef = useRef(loadTaxonomySnapshotState);
  loadTaxonomySnapshotRef.current = loadTaxonomySnapshotState;
  const loadVaultStatsRef = useRef(loadVaultStats);
  loadVaultStatsRef.current = loadVaultStats;
  const initialRouteLoadDoneRef = useRef(false);

  const requestVaultStatsRefresh = useCallback(() => {
    if (!vaultReady || vaultStatsFrameRef.current !== null) {
      return;
    }
    vaultStatsFrameRef.current = window.requestAnimationFrame(() => {
      vaultStatsFrameRef.current = null;
      void loadVaultStatsRef.current();
    });
  }, [vaultReady]);

  useEffect(() => {
    if (!selectedBlock) {
      setSelectedBlockTags([]);
      return;
    }

    if ("tags" in selectedBlock) {
      setSelectedBlockTags(selectedBlock.tags);
      return;
    }

    let cancelled = false;
    setSelectedBlockTags([]);
    void getBlock(selectedBlock.slug)
      .then((full) => {
        if (!cancelled && full) {
          setSelectedBlockTags(full.tags);
        }
      })
      .catch((error) => {
        console.error("Failed to load block tags:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBlock]);

  useEffect(() => {
    if (!deleteTargetSlug) {
      setDeletePlan(null);
      setDeletePlanError(null);
      return;
    }

    let cancelled = false;
    setDeletePlan(null);
    setDeletePlanError(null);
    prepareDeleteBlock(deleteTargetSlug)
      .then((plan) => {
        if (!cancelled) setDeletePlan(plan);
      })
      .catch((err) => {
        if (!cancelled) {
          setDeletePlanError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deleteTargetSlug]);

  const flushRefreshQueue = useCallback(async () => {
    if (!vaultReady || refreshInFlightRef.current) {
      return;
    }
    const pending = pendingRefreshRef.current;
    if (!pending.grid && !pending.taxonomy && !pending.previews) {
      return;
    }
    pendingRefreshRef.current = {
      grid: false,
      taxonomy: false,
      previews: false,
    };
    refreshInFlightRef.current = true;
    try {
      await Promise.all([
        pending.grid
          ? loadGridSnapshotRef.current({ preferCachedRoute: true, preserveLoadedRange: true })
          : Promise.resolve(),
        pending.taxonomy ? loadTaxonomySnapshotRef.current() : Promise.resolve(),
        pending.previews ? loadPreviews() : Promise.resolve(),
      ]);
    } finally {
      refreshInFlightRef.current = false;
      const next = pendingRefreshRef.current;
      if ((next.grid || next.taxonomy || next.previews) && refreshTimerRef.current === null) {
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = null;
          void flushRefreshQueue();
        }, 2000);
      }
    }
  }, [loadPreviews, vaultReady]);

  const scheduleRefresh = useCallback((
    flags: {
      grid?: boolean;
      taxonomy?: boolean;
      previews?: boolean;
    },
    delayMs = 2000,
    options: { force?: boolean } = {},
  ) => {
    if (!vaultReady) {
      return;
    }
    if (flags.grid || flags.taxonomy) {
      requestVaultStatsRefresh();
    }
    if (flags.grid) pendingRefreshRef.current.grid = true;
    if (flags.taxonomy) pendingRefreshRef.current.taxonomy = true;
    if (flags.previews) pendingRefreshRef.current.previews = true;
    if (options.force && refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (refreshInFlightRef.current || refreshTimerRef.current !== null) {
      return;
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void flushRefreshQueue();
    }, delayMs);
  }, [flushRefreshQueue, requestVaultStatsRefresh, vaultReady]);

  const handleCardMenuOpenChange = useCallback((slug: string, open: boolean) => {
    let wasHeld = false;
    setHeldSlugs((current) => {
      if (open) {
        if (current.has(slug)) return current;
        return new Set(current).add(slug);
      }
      wasHeld = current.has(slug);
      if (!wasHeld) return current;
      const next = new Set(current);
      next.delete(slug);
      return next;
    });
    if (open || !wasHeld) return;
    // The menu is gone, so the feed can finally close over the card. Reload
    // rather than filter locally: the snapshot is the only thing that knows
    // whether the card still belongs here.
    //
    // `preserveLoadedRange` is not optional here. Without it the refresh
    // returns the first page alone, truncating however far the user had
    // scrolled and rebuilding every card below — a visible rebuild of the whole
    // feed as the price of closing one menu. The route cache is left intact for
    // the same reason: this refresh is about one card, not the whole route.
    void loadGridSnapshotRef.current?.({ preserveLoadedRange: true });
  }, []);

  const reloadAllSnapshots = useCallback(async () => {
    invalidateRouteSnapshots();
    await Promise.all([
      // Keep whatever the user had scrolled through. Without this a refresh —
      // connecting a card to a collection, say — hands back the first page
      // alone, so every card past it unmounts and mounts again: video restarts,
      // posters refetch, and the feed visibly rebuilds around an edit that
      // touched one card.
      loadGridSnapshot({ invalidateCachedRoutes: true, preserveLoadedRange: true }),
      loadTaxonomySnapshotState(),
      loadVaultStats(),
      loadPreviews(),
    ]);
  }, [invalidateRouteSnapshots, loadGridSnapshot, loadPreviews, loadTaxonomySnapshotState, loadVaultStats]);

  const loadMoreBlocks = useCallback(async () => {
    if (paginationRequestRef.current || !hasMoreBlocks) return;
    const requestToken = {};
    paginationRequestRef.current = requestToken;
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = currentTagRef.current;
    const offsetAtStart = blocksRef.current.length;
    const routeLoadRequestIdAtStart = loadRequestIdRef.current;
    const generationAtStart = gridGenerationRef.current;
    setLoadingMoreBlocks(true);
    try {
      const grid = await fetchGridBlocks(tagAtStart, offsetAtStart, GRID_PAGE_SIZE);
      if (
        vaultPathRef.current !== pathAtStart
        || currentTagRef.current !== tagAtStart
        || loadRequestIdRef.current !== routeLoadRequestIdAtStart
      ) {
        return;
      }
      const acceptedGeneration = gridGenerationRef.current;
      if (
        generationAtStart === null
        || acceptedGeneration !== generationAtStart
        || grid.generation !== generationAtStart
      ) {
        if (grid.generation > (acceptedGeneration ?? -1)) {
          invalidateRouteSnapshots();
          void loadGridSnapshotRef.current({
            tag: tagAtStart,
            invalidateCachedRoutes: true,
            preserveLoadedRange: true,
          });
        }
        return;
      }
      setBlocks((prev) => {
        const seen = new Set(prev.map((block) => block.id));
        const appended = grid.blocks.filter((block) => !seen.has(block.id));
        const nextBlocks = appended.length > 0 ? [...prev, ...appended] : prev;
        routeSnapshotCacheRef.current.set(routeKeyFor(tagAtStart), {
          generation: grid.generation,
          blocks: nextBlocks,
          total_blocks: grid.total_blocks,
          has_more: grid.has_more,
        });
        return nextBlocks;
      });
      setTotalBlocks(grid.total_blocks);
      setHasMoreBlocks(grid.has_more);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        vaultPathRef.current === pathAtStart
        && currentTagRef.current === tagAtStart
        && loadRequestIdRef.current === routeLoadRequestIdAtStart
      ) {
        console.error("[LOAD_MORE] FAILED:", msg, err);
        setLoadError(msg);
      }
    } finally {
      if (paginationRequestRef.current === requestToken) {
        paginationRequestRef.current = null;
      }
      if (
        vaultPathRef.current === pathAtStart
        && currentTagRef.current === tagAtStart
        && loadRequestIdRef.current === routeLoadRequestIdAtStart
      ) {
        setLoadingMoreBlocks(false);
      }
    }
  }, [hasMoreBlocks, invalidateRouteSnapshots, routeKeyFor]);

  // Paint the first page immediately, then warm exactly one additional page
  // for the active route. Subsequent pages remain demand-driven by Grid's
  // adaptive runway, so startup stays fast without exposing page boundaries
  // during a native trackpad flick.
  useEffect(() => {
    if (
      !vaultReady
      || mainViewMode !== "grid"
      || !gridRouteSnapshotReady
      || blocks.length === 0
      || !hasMoreBlocks
    ) {
      return;
    }
    const routeKey = routeKeyFor(currentTag);
    if (warmRoutePageBufferRef.current.has(routeKey)) return;
    warmRoutePageBufferRef.current.add(routeKey);
    void loadMoreBlocks();
  }, [
    blocks.length,
    currentTag,
    gridRouteSnapshotReady,
    hasMoreBlocks,
    loadMoreBlocks,
    mainViewMode,
    routeKeyFor,
    vaultReady,
  ]);

  useEffect(() => {
    let cancelled = false;
    setVaultReady(false);
    setLoadError(null);
    setVaultStats(null);
    setThumbsRootPath(null);
    invalidateRouteSnapshots();
    pendingRefreshRef.current = {
      grid: false,
      taxonomy: false,
      previews: false,
    };
    refreshInFlightRef.current = false;
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (vaultStatsFrameRef.current !== null) {
      window.cancelAnimationFrame(vaultStatsFrameRef.current);
      vaultStatsFrameRef.current = null;
    }
    const started = performance.now();
    console.info("[startup] openVault:start", { vaultPath });
    void openVault(vaultPath)
      .then((result) => {
        if (!cancelled) {
          console.info("[startup] openVault:done", {
            vaultPath,
            indexed: result.indexed,
            derivedStoreReady: result.derived_store_ready,
            bootstrappedFromLegacy: result.bootstrapped_from_legacy,
            migrationRequired: result.migration_required,
            elapsedMs: Math.round(performance.now() - started),
          });
          setMigrationRequired(result.migration_required);
          setThumbsRootPath(result.thumbs_root);
          setVaultReady(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[OPEN_VAULT] FAILED:", msg, err);
        console.error("[startup] openVault:failed", {
          vaultPath,
          elapsedMs: Math.round(performance.now() - started),
          error: msg,
        });
        setLoadError(msg);
        setIsSyncing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invalidateRouteSnapshots, vaultPath]);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    let cancelled = false;
    let syncTimer: number | null = null;
    const initialTag = currentTag;

    setIsSyncing(true);
    initialRouteLoadDoneRef.current = false;
    void (async () => {
      await Promise.all([
        loadGridSnapshotRef.current({ tag: initialTag }),
        loadTaxonomySnapshotRef.current(),
        loadVaultStatsRef.current(initialTag),
      ]);
      if (cancelled) return;
      initialRouteLoadDoneRef.current = true;
      const activeTag = currentTagRef.current;
      const activeRouteKey = routeKeyFor(activeTag);
      lastRevalidatedRouteKeyRef.current = activeRouteKey;
      if (activeTag !== initialTag) {
        await loadGridSnapshotRef.current({
          tag: activeTag,
          preferCachedRoute: true,
        });
        if (cancelled) return;
      }
      syncTimer = window.setTimeout(() => {
        void startVaultSync()
          .then((started) => {
            if (!started && !cancelled) {
              setIsSyncing(false);
            }
          })
          .catch((err) => {
            if (!cancelled) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error("[SYNC] FAILED TO START:", msg, err);
              setLoadError(msg);
              setIsSyncing(false);
            }
          });
      }, 0);
    })();

    return () => {
      cancelled = true;
      if (syncTimer !== null) {
        window.clearTimeout(syncTimer);
      }
    };
  }, [routeKeyFor, vaultPath, vaultReady]);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    void loadVaultStatsRef.current(currentTag);
  }, [currentTag, vaultReady]);

  // Filesystem catch-up plus passive thumb sweep on focus/visibility.
  // The route refresh joins VaultReconciler before querying, so missed notify
  // events cannot leave Grid/Sidebar stale when the user returns to Mine.
  // Throttled to avoid turning a flurry of focus events into repeated scans.
  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    let lastRun = 0;
    const MIN_INTERVAL_MS = 10_000;
    const run = () => {
      if (isSyncing) return;
      const now = Date.now();
      if (now - lastRun < MIN_INTERVAL_MS) return;
      if (document.visibilityState !== "visible") return;
      lastRun = now;
      scheduleRefresh(
        { grid: true, taxonomy: true, previews: true },
        0,
        { force: true },
      );
      void sweepVaultThumbnails().catch((err) => {
        console.warn("[THUMB_SWEEP] failed:", err);
      });
    };
    const onFocus = () => run();
    const onVisibility = () => run();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isSyncing, scheduleRefresh, vaultReady]);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    if (!initialRouteLoadDoneRef.current) {
      return;
    }
    const routeKey = routeKeyFor(currentTag);
    if (lastRevalidatedRouteKeyRef.current === routeKey) {
      return;
    }
    lastRevalidatedRouteKeyRef.current = routeKey;
    void loadGridSnapshotRef.current({
      tag: currentTag,
      preferCachedRoute: true,
    });
  }, [currentTag, routeKeyFor, vaultReady]);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }

    const unlistenFns: Array<Promise<() => void>> = [];

    unlistenFns.push(listen<BlockAddedEvent>("block:added", (event) => {
      invalidateRoutesForTags(event.payload.tags);
      scheduleRefresh({
        grid: currentTagRef.current === undefined || event.payload.tags.includes(currentTagRef.current),
        taxonomy: true,
        previews: true,
      });
    }));

    unlistenFns.push(listen<BlockRemovedEvent>("block:removed", (event) => {
      invalidateRoutesForTags(event.payload.tags);
      scheduleRefresh({
        grid: currentTagRef.current === undefined || event.payload.tags.includes(currentTagRef.current),
        taxonomy: true,
        previews: true,
      });
    }));

    unlistenFns.push(listen<BlockRenamedEvent>("block:renamed", (event) => {
      invalidateRouteSnapshots();
      setSelectedBlock((current) => {
        if (!current || current.slug !== event.payload.old_slug) {
          return current;
        }
        return {
          ...current,
          slug: event.payload.new_slug,
        };
      });
      void getBlock(event.payload.new_slug)
        .then((full) => {
          if (!full) {
            return;
          }
          setSelectedBlock((current) => {
            if (!current) {
              return current;
            }
            if (
              current.slug !== event.payload.old_slug
              && current.slug !== event.payload.new_slug
            ) {
              return current;
            }
            return full;
          });
        })
        .catch((error) => {
          console.error("Failed to refresh renamed block:", error);
        });
      scheduleRefresh({
        grid: true,
        previews: true,
      }, 0);
    }));

    unlistenFns.push(listen<ThumbUpdatedEvent>("thumb:updated", (event) => {
      const loadedBlock = blocksRef.current.find(
        (block) => block.slug === event.payload.slug,
      );
      const needsGeometryRefresh = loadedBlock
        ? imageCardNeedsGeometryRefresh(loadedBlock)
        : false;
      // Sidebar preview cache-buster (its own version ref, applied on the next
      // previews refresh below).
      bumpThumbVersion(event.payload.slug);
      // Feed cache-buster for the mounted card. save_tile_poster / save_thumb
      // write the regenerated file (and sometimes rewrite preview_manifest), but
      // the block row is byte-identical, so a grid refetch reconciles to a no-op
      // for pixels while streaming the whole scrolled range through IPC — a storm
      // during the Phase-2 thumb backlog. Bumping the per-slug version instead
      // re-renders and refetches only the affected card. A genuine
      // preview geometry transition is the exception: a newly added image can
      // enter the feed before its dimensions are indexed and temporarily use
      // the 240px fallback. Refresh that loaded route once when the preview
      // becomes ready so the deterministic masonry envelope adopts the real
      // aspect ratio. Cards that already have geometry keep the cheap pixel-only
      // path, preserving the cold-start sweep contract.
      bumpFeedThumbVersion(event.payload.slug);
      scheduleRefresh(
        needsGeometryRefresh
          ? { grid: true, previews: true }
          : { previews: true },
        needsGeometryRefresh ? 0 : 2000,
        { force: needsGeometryRefresh },
      );
    }));

    unlistenFns.push(listen<VaultChangedEvent>("vault-changed", (event) => {
      if (event.payload.path !== vaultPathRef.current) {
        return;
      }
      invalidateRouteSnapshots();
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      });
    }));

    unlistenFns.push(listen<VaultStats>("vault:stats-updated", (event) => {
      const currentCollection = currentTagRef.current ?? null;
      if (event.payload.currentCollection === currentCollection) {
        setVaultStats(event.payload);
        return;
      }
      requestVaultStatsRefresh();
    }));

    unlistenFns.push(listen<VaultSyncStartedEvent>("vault-sync-started", (event) => {
      if (event.payload.path === vaultPathRef.current) {
        setIsSyncing(true);
      }
    }));

    unlistenFns.push(listen<VaultSyncFinishedEvent>("vault-sync-finished", (event) => {
      if (event.payload.path !== vaultPathRef.current) {
        return;
      }
      setIsSyncing(false);
      if (event.payload.error) {
        setLoadError(event.payload.error);
        return;
      }
      invalidateRouteSnapshots();
      if (migrationRequired) {
        void reloadAllSnapshots().finally(() => {
          setMigrationRequired(false);
        });
        return;
      }
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      });
    }));

    return () => {
      for (const unlisten of unlistenFns) {
        unlisten.then((fn) => fn());
      }
    };
  }, [bumpThumbVersion, bumpFeedThumbVersion, invalidateRouteSnapshots, invalidateRoutesForTags, migrationRequired, reloadAllSnapshots, requestVaultStatsRefresh, scheduleRefresh, vaultReady]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (vaultStatsFrameRef.current !== null) {
        window.cancelAnimationFrame(vaultStatsFrameRef.current);
        vaultStatsFrameRef.current = null;
      }
    };
  }, []);

  // ── Vault switching ──────────────────────────────────────────────────────

  const handleSwitchVault = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    await selectVault(selected);
    navigate("/", { replace: true });
    onVaultSelected(selected);
  }, [navigate, onVaultSelected]);

  // Search overlay opens above any surface, including an open Detail
  // (SPEC_SEARCH_OVERLAY.md); the modal Dialog owns the keyboard while open.
  const toggleSearchOverlay = useCallback(() => {
    setSearchOverlayOpen((open) => !open);
  }, []);

  const handleSearchOverlayOpenBlock = useCallback((block: LightBlock) => {
    setSearchOverlayOpen(false);
    openDetailBlock(block);
  }, [openDetailBlock]);

  const focusSidebarSearch = useCallback(() => {
    if (sidebarCollapsed) {
      toggleCollapsed();
    }
    setSidebarSearchFocusSequence((sequence) => sequence + 1);
  }, [sidebarCollapsed, toggleCollapsed]);

  useLayoutEffect(() => {
    if (sidebarCollapsed) return;
    if (sidebarSearchFocusSequence <= lastSidebarSearchFocusSequenceRef.current) return;
    const input = sidebarSearchInputRef.current;
    if (!input) return;
    lastSidebarSearchFocusSequenceRef.current = sidebarSearchFocusSequence;
    input.focus({ preventScroll: true });
    input.select();
  }, [sidebarCollapsed, sidebarSearchFocusSequence]);

  const handleSidebarSearchChange = useCallback((query: string) => {
    setSidebarSearchQuery(query);
    setSidebarSearchKeyboardNavigationFocus(null);
  }, []);

  const handleClearSidebarSearch = useCallback(() => {
    setSidebarSearchQuery("");
    setSidebarSearchKeyboardNavigationFocus(null);
    sidebarSearchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSurfaceSearchShortcut = useCallback((target: SurfaceSearchShortcutTarget) => {
    const active = document.activeElement;
    // Focus inside the search overlay must not swallow the shortcut: a repeat
    // Cmd+F closes the overlay (SPEC_SEARCH_OVERLAY.md). Other overlays
    // (dialogs, menus) keep owning the keyboard.
    const insideSearchOverlay =
      active instanceof Element && active.closest("[data-search-overlay]") !== null;
    if (!insideSearchOverlay && isOverlayKeyboardTarget(active)) return;
    if (target === "sidebar") {
      focusSidebarSearch();
      return;
    }
    toggleSearchOverlay();
  }, [focusSidebarSearch, toggleSearchOverlay]);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<SurfaceSearchShortcutTarget>(
      "surface-search-shortcut",
      (event) => {
        if (cancelled) return;
        handleSurfaceSearchShortcut(event.payload);
      },
    );
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [handleSurfaceSearchShortcut]);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen("sidebar-toggle-shortcut", () => {
      if (!cancelled) {
        toggleCollapsed();
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [toggleCollapsed]);

  const handleOpenSettings = useCallback(() => {
    void openSettingsWindow().catch((error) => {
      console.error("Failed to open settings window:", error);
    });
  }, []);

  const handleMainViewModeChange = useCallback((next: MainViewMode) => {
    setMainViewMode((current) => {
      if (current === next) return current;
      persistMainViewMode(next);
      return next;
    });
  }, []);

  // The settings window writes localStorage (shared per origin) and emits
  // this event; re-read the changed key and update the affected state.
  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
      if (cancelled) return;
      const { key } = event.payload;
      if (key === THEME_STORAGE_KEY) {
        applyTheme(getStoredTheme());
      } else if (key === DESIGN_STORAGE_KEY) {
        applyDesign(getStoredDesignMode());
      } else if (key === COMPACT_DETAIL_TOP_MENU_STORAGE_KEY) {
        setCompactDetailTopMenuEnabled(getStoredCompactDetailTopMenu());
      } else if (key === BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY) {
        setBottomActionBarHidden(getStoredBottomActionBarHidden());
      } else if (key === GRAPH_PREFERENCES_STORAGE_KEY) {
        setGraphPreferences(getStoredGraphPreferences());
      } else if (key === SCROLL_EDGE_FADE_STORAGE_KEY) {
        setScrollEdgeFade(getStoredScrollEdgeFade());
      } else if (key === CARD_RADIUS_STORAGE_KEY) {
        applyCardRadius(getStoredCardRadius());
      } else if (key === ACTION_BUTTON_STYLE_STORAGE_KEY) {
        applyActionButtonStyle(getStoredActionButtonStyle());
      } else if (key === DENSITY_STORAGE_KEY) {
        applyDensity(getStoredDensity());
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (isToggleSidebarShortcut(e)) {
        // The native View menu owns this accelerator in packaged Mine. Letting
        // WKWebView handle the same keydown would toggle the sidebar twice.
        if (isTauri()) return;
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      if (isSearchShortcut(e)) {
        if (isOverlayKeyboardTarget(e.target)) return;
        if (e.shiftKey) {
          e.preventDefault();
          handleSurfaceSearchShortcut("sidebar");
          return;
        }
        e.preventDefault();
        handleSurfaceSearchShortcut("main");
        return;
      }
      if (isEditableKeyboardTarget(e.target)) return;
      const historyDirection = historyDirectionForShortcut(e);
      if (historyDirection !== null) {
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        navigate(historyDirection);
        return;
      }
      if (
        e.metaKey
        && !e.shiftKey
        && !e.altKey
        && !e.ctrlKey
        && e.key.toLowerCase() === "k"
        && renderedDetailBlock
      ) {
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        setCompactDetailTopMenuRequestSequence((current) => current + 1);
        return;
      }
      if (
        e.metaKey
        && !e.shiftKey
        && !e.altKey
        && !e.ctrlKey
        && e.key.toLowerCase() === "l"
        && selectedBlock
      ) {
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        copyTextToClipboard(blockMarkdownPath(vaultPath, selectedBlock.slug));
        return;
      }
      if (isOverlayKeyboardTarget(e.target)) return;
      if (!e.metaKey) return;
      if (e.shiftKey && e.key === "O") {
        e.preventDefault();
        handleSwitchVault();
      } else if (e.shiftKey && e.key === "N") {
        e.preventDefault();
        setIsCreatingChannel(true);
      }
      // Cmd+, is owned by the native "Settings…" menu item (NSMenu key
      // equivalent) — it never reaches the webview keydown handler.
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    compactDetailTopMenuActive,
    handleSurfaceSearchShortcut,
    handleSwitchVault,
    navigate,
    renderedDetailBlock,
    selectedBlock,
    toggleCollapsed,
    vaultPath,
  ]);

  // ── Block navigation ──────────────────────────────────────────────────────

  const handleBlockClick = useCallback((block: LightBlock) => {
    openDetailBlock(block);
  }, [openDetailBlock]);

  const handleDetailClose = useCallback(() => {
    if (!selectedBlock || detailChromeClosing) return;
    requestGridFocusRestore(selectedBlock.slug);
    setSelectedBlockAnchor(null);
    setCompactDetailChromeEntered(false);
    setClosingDetailBlock(selectedBlock);
    setClosingDetailTags(selectedBlockTags);
    setDetailChromeClosing(true);
    setSelectedBlock(null);
    if (detailCloseTimerRef.current !== null) {
      window.clearTimeout(detailCloseTimerRef.current);
    }
    detailCloseTimerRef.current = window.setTimeout(() => {
      detailCloseTimerRef.current = null;
      cancelPendingDetailClose();
    }, detailChromeCloseDuration);
  }, [
    selectedBlock,
    selectedBlockTags,
    detailChromeClosing,
    cancelPendingDetailClose,
    requestGridFocusRestore,
    detailChromeCloseDuration,
  ]);

  const handleScrollToTop = useCallback(() => {
    if (selectedBlock) {
      if (detailChromeClosing) return;
      setSelectedBlockAnchor(null);
      setCompactDetailChromeEntered(false);
      setClosingDetailBlock(selectedBlock);
      setClosingDetailTags(selectedBlockTags);
      setDetailChromeClosing(true);
      setSelectedBlock(null);
      setScrollToTopSignal((n) => n + 1);
      if (detailCloseTimerRef.current !== null) {
        window.clearTimeout(detailCloseTimerRef.current);
      }
      detailCloseTimerRef.current = window.setTimeout(() => {
        detailCloseTimerRef.current = null;
        cancelPendingDetailClose();
      }, detailChromeCloseDuration);
      return;
    }
    setScrollToTopSignal((n) => n + 1);
  }, [
    selectedBlock,
    selectedBlockTags,
    detailChromeClosing,
    cancelPendingDetailClose,
    detailChromeCloseDuration,
  ]);

  const handleDetailNavigate = useCallback(
    async (direction: "prev" | "next" | "up" | "down") => {
      if (!selectedBlock) return;
      const idx = activeBlocks.findIndex((b) => b.id === selectedBlock.id);
      if (idx === -1) return;
      const cols = gridColumnCountRef.current;
      let newIdx: number;
      switch (direction) {
        case "prev":  newIdx = idx - 1; break;
        case "next":  newIdx = idx + 1; break;
        case "up":    newIdx = idx - cols; break;
        case "down":  newIdx = idx + cols; break;
      }
      if (newIdx >= 0 && newIdx < activeBlocks.length) {
        const target = activeBlocks[newIdx]!;
        openDetailBlock(target);
      }
    },
    [selectedBlock, activeBlocks, openDetailBlock],
  );

  const handleOpenRelatedNote = useCallback((slug: string) => {
    const blockAnchor = relatedNoteBlockAnchor(slug);
    void getBlock(baseRelatedNoteSlug(slug))
      .then((block) => {
        if (block) {
          openDetailBlock(block, blockAnchor);
        }
      })
      .catch((error) => {
        console.error("Failed to open related note:", error);
      });
  }, [openDetailBlock]);

  // ── Tag management ──────────────────────────────────────────────────────

  const handleRenameTag = useCallback(
    async (oldTag: string, newTag: string) => {
      suppressRedirectRef.current = true;
      try {
        const result = await renameChannel(oldTag, newTag);
        await reloadAllSnapshots();
        if (window.location.pathname === `/channel/${encodeURIComponent(oldTag)}`) {
          navigate(`/channel/${encodeURIComponent(result.tag)}`);
        }
      } catch (err) {
        console.error("Failed to rename channel:", err);
      } finally {
        suppressRedirectRef.current = false;
      }
    },
    [navigate, reloadAllSnapshots],
  );

  const handleDeleteTagFromAll = useCallback(
    async (tag: string) => {
      try {
        await deleteTagFromAll(tag);
        await deleteChannel(tag).catch((err) => console.error("Failed to delete channel:", err));
        if (currentTag === tag) {
          navigate("/");
        }
      } catch (err) {
        console.error("Failed to delete tag:", err);
      }
      await reloadAllSnapshots();
    },
    [currentTag, navigate, reloadAllSnapshots],
  );

  // ── Ordered tags: channels by position, then remaining alphabetically ──

  const orderedTags = useMemo(() => {
    const tagCounts = new Map(tags.map((tc) => [tc.tag, tc.count]));
    const channelTags = new Set(channels.map((ch) => ch.tag));
    const withPos = [...channels]
      .sort((a, b) => (
        a.position - b.position
        || a.tag.localeCompare(b.tag)
      ))
      .map((ch) => ({
        tag: ch.tag,
        count: tagCounts.get(ch.tag) ?? ch.block_count,
      }));
    const noPos = tags.filter((tc) => !channelTags.has(tc.tag));
    noPos.sort((a, b) => a.tag.localeCompare(b.tag));

    return applyPendingTagOrder([...withPos, ...noPos], pendingTagOrder);
  }, [tags, channels, pendingTagOrder]);

  const handleTopCollectionNavigate = useCallback((tag?: string) => {
    navigate(tag ? `/channel/${encodeURIComponent(tag)}` : "/");
  }, [navigate]);

  const handleTopCollectionCreate = useCallback(async (tag: string) => {
    const channel = await createChannel(tag);
    pushRecentTag(channel.tag);
    await reloadAllSnapshots();
    navigate(`/channel/${encodeURIComponent(channel.tag)}`);
  }, [navigate, reloadAllSnapshots]);

  // ── Opt+Cmd+Up/Down — switch channels ─────────────────────────────────
  //
  // Works with a card open: the card belongs to the channel being left, so it
  // closes and the feed moves on. Detail is a full-screen viewer inside the same
  // route, not a modal that owns the keyboard — it does not even intercept the
  // arrows — so `isDetailShortcutBlockedTarget` lets it through while still
  // blocking menus, listboxes, the image preview and other dialogs.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.altKey)) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (
        e.defaultPrevented
        || isEditableKeyboardTarget(e.target)
        || isDetailShortcutBlockedTarget(e.target)
      ) {
        return;
      }
      e.preventDefault();
      const idx = currentTag
        ? orderedTags.findIndex((t) => t.tag === currentTag)
        : -1;
      let targetPath: string | null = null;
      let targetRowKey: string | null = null;
      if (e.key === "ArrowUp") {
        if (idx === 0) {
          targetPath = "/";
          targetRowKey = "all";
        } else if (idx > 0) {
          const targetTag = orderedTags[idx - 1]!.tag;
          targetPath = `/channel/${encodeURIComponent(targetTag)}`;
          targetRowKey = `tag:${targetTag}`;
        }
      } else {
        if (idx === -1 && orderedTags.length > 0) {
          const targetTag = orderedTags[0]!.tag;
          targetPath = `/channel/${encodeURIComponent(targetTag)}`;
          targetRowKey = `tag:${targetTag}`;
        } else if (idx >= 0 && idx < orderedTags.length - 1) {
          const targetTag = orderedTags[idx + 1]!.tag;
          targetPath = `/channel/${encodeURIComponent(targetTag)}`;
          targetRowKey = `tag:${targetTag}`;
        }
      }
      if (!targetPath || !targetRowKey) return;
      if (selectedBlock) handleDetailClose();
      setSidebarKeyboardNavigationFocus((current) => ({
        rowKey: targetRowKey,
        sequence: (current?.sequence ?? 0) + 1,
      }));
      navigate(targetPath);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentTag, orderedTags, navigate, selectedBlock, handleDetailClose]);


  // ── Channel management ─────────────────────────────────────────────────

  const attachBlocksToTag = useCallback(
    async (slugs: string[], tag: string) => {
      const uniqueSlugs = uniqueDragSlugs(slugs);
      if (uniqueSlugs.length === 0) return;

      for (const slug of uniqueSlugs) {
        await addTag(slug, tag);
      }

      if (selectedBlock && uniqueSlugs.includes(selectedBlock.slug)) {
        setSelectedBlockTags((current) => (
          current.includes(tag) ? current : [...current, tag]
        ));
        setSelectedBlock((current) => (
          current && uniqueSlugs.includes(current.slug) && "tags" in current
            ? {
                ...current,
                tags: current.tags.includes(tag) ? current.tags : [...current.tags, tag],
              }
            : current
        ));
      }
    },
    [selectedBlock],
  );

  const handleCreateChannel = useCallback(
    async (tag: string) => {
      const pendingDrop = pendingCreateChannelDrop;
      setPendingCreateChannelDrop(null);
      try {
        const channel = await createChannel(tag);
        pushRecentTag(channel.tag);

        if (pendingDrop?.type === "block") {
          await attachBlocksToTag([pendingDrop.slug], channel.tag);
          await reloadAllSnapshots();
          return;
        }

        if (pendingDrop?.type === "blocks") {
          await attachBlocksToTag(pendingDrop.slugs, channel.tag);
          await reloadAllSnapshots();
          return;
        }

        if (pendingDrop?.type === "media_asset") {
          const block = await createMediaAssetCard({
            source_slug: pendingDrop.payload.asset.source_slug,
            media_ref: pendingDrop.payload.asset.media_ref,
            target_tag: channel.tag,
          });
          invalidateRoutesForTags(block.tags);
          scheduleRefresh({
            grid: currentTagRef.current === undefined || block.tags.includes(currentTagRef.current),
            taxonomy: true,
            previews: true,
          }, 0, { force: true });
          return;
        }

        if (pendingDrop?.type === "text_selection") {
          const payload = pendingDrop.payload;
          const block = await extractTextSelection({
            source_slug: payload.sourceSlug,
            target_tag: channel.tag,
            selected_text: payload.selectedText,
            first_block_start: payload.firstBlockStart,
            first_block_end: payload.firstBlockEnd,
            source_body_hash: payload.sourceBodyHash,
          });
          invalidateRoutesForTags(block.tags);
          scheduleRefresh({
            grid: currentTagRef.current === undefined || block.tags.includes(currentTagRef.current),
            taxonomy: true,
            previews: true,
          }, 0, { force: true });
          return;
        }

        await reloadAllSnapshots();
      } catch (err) {
        console.error("Failed to create collection:", err);
      }
    },
    [
      attachBlocksToTag,
      invalidateRoutesForTags,
      pendingCreateChannelDrop,
      reloadAllSnapshots,
      scheduleRefresh,
    ],
  );

  const handleSetCreatingChannel = useCallback((creating: boolean) => {
    setPendingCreateChannelDrop(null);
    setIsCreatingChannel(creating);
  }, []);

  const sidebarSearchNavigationRows = useMemo(() => (
    buildSidebarSearchNavigationRows(orderedTags, sidebarSearchQuery)
  ), [orderedTags, sidebarSearchQuery]);

  useEffect(() => {
    if (
      sidebarSearchKeyboardNavigationFocus
      && !sidebarSearchNavigationRows.includes(sidebarSearchKeyboardNavigationFocus.rowKey)
    ) {
      setSidebarSearchKeyboardNavigationFocus(null);
    }
  }, [sidebarSearchKeyboardNavigationFocus, sidebarSearchNavigationRows]);

  const setSidebarSearchNavigationRow = useCallback((rowKey: string | null) => {
    if (!rowKey) {
      setSidebarSearchKeyboardNavigationFocus(null);
      return;
    }
    setSidebarSearchKeyboardNavigationFocus((current) => ({
      rowKey,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }, []);

  const moveSidebarSearchNavigationRow = useCallback((direction: 1 | -1) => {
    if (sidebarSearchNavigationRows.length === 0) return;
    const currentIndex = sidebarSearchKeyboardNavigationFocus
      ? sidebarSearchNavigationRows.indexOf(sidebarSearchKeyboardNavigationFocus.rowKey)
      : -1;
    const nextIndex = currentIndex === -1
      ? direction > 0 ? 0 : sidebarSearchNavigationRows.length - 1
      : Math.max(0, Math.min(sidebarSearchNavigationRows.length - 1, currentIndex + direction));
    setSidebarSearchNavigationRow(sidebarSearchNavigationRows[nextIndex] ?? null);
  }, [
    setSidebarSearchNavigationRow,
    sidebarSearchKeyboardNavigationFocus,
    sidebarSearchNavigationRows,
  ]);

  const activateSidebarSearchNavigationRow = useCallback((rowKey: string | null) => {
    if (!rowKey) return;
    if (rowKey === SIDEBAR_CREATE_CHANNEL_ROW_KEY) {
      handleSetCreatingChannel(true);
      return;
    }
    const route = sidebarRowKeyToRoute(rowKey);
    if (!route) return;
    navigate(route);
  }, [handleSetCreatingChannel, navigate]);

  const handleSidebarSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (sidebarSearchHasValue) {
        handleClearSidebarSearch();
        return;
      }
      setSidebarSearchNavigationRow(null);
      sidebarSearchInputRef.current?.blur();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveSidebarSearchNavigationRow(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key !== "Enter") return;
    const activeRowKey = sidebarSearchKeyboardNavigationFocus?.rowKey ?? null;
    if (!activeRowKey) return;
    event.preventDefault();
    event.stopPropagation();
    activateSidebarSearchNavigationRow(activeRowKey);
  }, [
    activateSidebarSearchNavigationRow,
    handleClearSidebarSearch,
    moveSidebarSearchNavigationRow,
    setSidebarSearchNavigationRow,
    sidebarSearchHasValue,
    sidebarSearchKeyboardNavigationFocus,
  ]);

  const beginCreateChannelFromDrop = useCallback((pendingDrop: PendingCreateChannelDrop) => {
    setPendingCreateChannelDrop(pendingDrop);
    setIsCreatingChannel(true);
  }, []);

  const handleReorderTag = useCallback(
    async (activeTag: string, overTag: string) => {
      const currentOrder = orderedTags.map((t) => t.tag);
      const oldIndex = currentOrder.indexOf(activeTag);
      const newIndex = currentOrder.indexOf(overTag);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
      // Show the result of the gesture at once. Waiting for the write and a
      // full snapshot reload leaves the row in its old place for the whole
      // round trip, which reads as the drop snapping back and then jumping.
      setPendingTagOrder(newOrder);
      try {
        const items = newOrder.map((tag, i) => ({ tag, position: i }));
        await reorderChannels(items);
        await reloadAllSnapshots();
      } catch (err) {
        // Dropping the optimistic order restores whatever the vault says, so a
        // failed write never leaves the sidebar claiming an order it does not
        // have.
        console.error("Failed to reorder channels:", err);
      } finally {
        setPendingTagOrder(null);
      }
    },
    [orderedTags, reloadAllSnapshots],
  );

  // ── Card drag-to-tag (dnd-kit) ──────────────────────────────────────────

  const handleCardDrop = useCallback(
    async (slug: string, tag: string) => {
      try {
        await attachBlocksToTag([slug], tag);
      } catch (err) {
        console.error("Failed to add tag:", err);
      }
      await reloadAllSnapshots();
    },
    [attachBlocksToTag, reloadAllSnapshots],
  );

  const handleCardsDrop = useCallback(
    async (slugs: string[], tag: string) => {
      try {
        await attachBlocksToTag(slugs, tag);
      } catch (err) {
        console.error("Failed to add tags:", err);
      }
      await reloadAllSnapshots();
    },
    [attachBlocksToTag, reloadAllSnapshots],
  );

  const handleMediaAssetDrop = useCallback(
    async (payload: MediaAssetDragPayload, tag: string) => {
      try {
        const block = await createMediaAssetCard({
          source_slug: payload.asset.source_slug,
          media_ref: payload.asset.media_ref,
          target_tag: tag,
        });
        invalidateRoutesForTags(block.tags);
        scheduleRefresh({
          grid: currentTagRef.current === undefined || block.tags.includes(currentTagRef.current),
          taxonomy: true,
          previews: true,
        }, 0, { force: true });
      } catch (err) {
        console.error("Failed to create media asset card:", err);
      }
    },
    [invalidateRoutesForTags, scheduleRefresh],
  );

  const handleMediaAssetCreateCard = useCallback(
    async (asset: MediaAssetRef, tag: string) => {
      const block = await createMediaAssetCard({
        source_slug: asset.source_slug,
        media_ref: asset.media_ref,
        target_tag: tag,
      });
      invalidateRoutesForTags(block.tags);
      scheduleRefresh({
        grid: currentTagRef.current === undefined || block.tags.includes(currentTagRef.current),
        taxonomy: true,
        previews: true,
      }, 0, { force: true });
    },
    [invalidateRoutesForTags, scheduleRefresh],
  );

  const handleMediaAssetCreateChannelAndCard = useCallback(
    async (asset: MediaAssetRef, tag: string) => {
      const channel = await createChannel(tag);
      pushRecentTag(channel.tag);
      await handleMediaAssetCreateCard(asset, channel.tag);
    },
    [handleMediaAssetCreateCard],
  );

  const handleMediaAssetRename = useCallback(
    async (asset: MediaAssetRef, newStem: string) => {
      await renameMediaAsset({
        media_ref: asset.media_ref,
        new_stem: newStem,
      });
      invalidateRouteSnapshots();
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      }, 0, { force: true });
      window.dispatchEvent(new Event("vault-refreshed"));
    },
    [invalidateRouteSnapshots, scheduleRefresh],
  );

  const handleMediaAssetDelete = useCallback(
    async (asset: MediaAssetRef) => {
      await deleteMediaAsset(asset.media_ref);
      invalidateRouteSnapshots();
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      }, 0, { force: true });
      window.dispatchEvent(new Event("vault-refreshed"));
    },
    [invalidateRouteSnapshots, scheduleRefresh],
  );

  const handleMediaAssetRemoveFromCard = useCallback(
    async (asset: MediaAssetRef) => {
      await removeMediaAssetFromCard({
        media_ref: asset.media_ref,
        source_slug: asset.source_slug,
        reference_kind: asset.reference_kind,
        occurrence_index: asset.occurrence_index ?? null,
      });
      invalidateRouteSnapshots();
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      }, 0, { force: true });
      window.dispatchEvent(new Event("vault-refreshed"));
    },
    [invalidateRouteSnapshots, scheduleRefresh],
  );

  const handleTextSelectionDrop = useCallback(
    async (payload: MineTextSelectionDragPayload, tag: string) => {
      try {
        const block = await extractTextSelection({
          source_slug: payload.sourceSlug,
          target_tag: tag,
          selected_text: payload.selectedText,
          first_block_start: payload.firstBlockStart,
          first_block_end: payload.firstBlockEnd,
          source_body_hash: payload.sourceBodyHash,
        });
        invalidateRoutesForTags(block.tags);
        scheduleRefresh({
          grid: currentTagRef.current === undefined || block.tags.includes(currentTagRef.current),
          taxonomy: true,
          previews: true,
        }, 0, { force: true });
      } catch (err) {
        console.error("Failed to extract text selection:", err);
      }
    },
    [invalidateRoutesForTags, scheduleRefresh],
  );

  const handleTextSelectionCreateChannelAndCard = useCallback(
    async (payload: MineTextSelectionDragPayload, tag: string) => {
      const channel = await createChannel(tag);
      pushRecentTag(channel.tag);
      await handleTextSelectionDrop(payload, channel.tag);
    },
    [handleTextSelectionDrop],
  );

  const handleTextSelectionDelete = useCallback(
    async (payload: MineTextSelectionDragPayload) => {
      try {
        const block = await deleteTextSelection({
          source_slug: payload.sourceSlug,
          selected_text: payload.selectedText,
          first_block_start: payload.firstBlockStart,
          first_block_end: payload.firstBlockEnd,
          source_body_hash: payload.sourceBodyHash,
        });
        invalidateRouteSnapshots();
        setSelectedBlock((current) => (
          current?.slug === block.slug ? block : current
        ));
        setSelectedBlockTags(block.tags);
        scheduleRefresh({
          grid: true,
          taxonomy: true,
          previews: true,
        }, 0, { force: true });
        window.dispatchEvent(new Event("vault-refreshed"));
      } catch (err) {
        console.error("Failed to delete text selection:", err);
      }
    },
    [invalidateRouteSnapshots, scheduleRefresh],
  );

  const handleDndStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      const data = event.active.data.current as ({
        type?: string;
        slug?: string;
        block?: LightBlock;
      } & Partial<BlockDragData> & Partial<MediaAssetDragPayload> & Partial<MineTextSelectionDragPayload>) | undefined;
      if (data?.type === "media_asset") {
        setActiveDragMediaAsset({
          src: data.imageSrc ?? "",
        });
        setActiveDragBlocks([]);
        setActiveDragTag(null);
        setActiveDragTextSelection(null);
        setOverlayDressing("point");
        return;
      }
      const textSelectionPayload = data?.type === "text_selection"
        ? data as MineTextSelectionDragPayload
        : id.startsWith("text-selection:")
          ? getActiveMineTextSelectionDragPayload()
          : null;
      if (textSelectionPayload) {
        setActiveDragTextSelection({
          selectedText: textSelectionPayload.selectedText,
        });
        setActiveDragBlocks([]);
        setActiveDragTag(null);
        setActiveDragMediaAsset(null);
        setOverlayDressing("point");
        return;
      }
      if (id.startsWith("tag:")) {
        setActiveDragTag(id.slice(4));
        setActiveDragBlocks([]);
        setActiveDragMediaAsset(null);
        setActiveDragTextSelection(null);
        setOverlayDressing("row");
      } else {
        if (data?.type === "block") {
          data.clearSelectionOnDragStart?.();
        }
        setActiveDragBlocks(resolveBlockDragBlocks(id, data, blocks));
        setActiveDragTag(null);
        setActiveDragMediaAsset(null);
        setActiveDragTextSelection(null);
        setOverlayDressing("point");
      }
    },
    [blocks],
  );

  const handleDndEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragBlocks([]);
      setActiveDragTag(null);
      setActiveDragMediaAsset(null);
      setActiveDragTextSelection(null);
      const { active, over } = event;
      if (!over) {
        clearActiveMineTextSelectionDragPayload();
        return;
      }

      const activeId = String(active.id);
      const overId = String(over.id);
      const activeData = active.data.current as ({
        type?: string;
        slug?: string;
      } & Partial<BlockDragData> & Partial<MediaAssetDragPayload> & Partial<MineTextSelectionDragPayload>) | undefined;
      if (activeData?.type === "media_asset") {
        if (overId === "create-channel") {
          beginCreateChannelFromDrop({
            type: "media_asset",
            payload: activeData as MediaAssetDragPayload,
          });
          return;
        }
        if (overId.startsWith("tag:")) {
          void handleMediaAssetDrop(activeData as MediaAssetDragPayload, overId.slice(4));
        }
        return;
      }
      const textSelectionPayload = activeData?.type === "text_selection"
        ? activeData as MineTextSelectionDragPayload
        : activeId.startsWith("text-selection:")
          ? getActiveMineTextSelectionDragPayload()
          : null;
      if (textSelectionPayload) {
        if (overId === "create-channel") {
          beginCreateChannelFromDrop({
            type: "text_selection",
            payload: textSelectionPayload,
          });
          clearActiveMineTextSelectionDragPayload();
          return;
        }
        if (overId.startsWith("tag:")) {
          void handleTextSelectionDrop(textSelectionPayload, overId.slice(4));
        }
        clearActiveMineTextSelectionDragPayload();
        return;
      }
      const activeIsTag = activeId.startsWith("tag:");
      const activeSlug = activeData?.type === "block" && activeData.slug
        ? activeData.slug
        : activeId.startsWith("detail:")
          ? activeId.slice("detail:".length)
          : activeId;
      const activeSlugs = !activeIsTag
        ? resolveBlockDragSlugs(activeId, activeData)
        : [];

      // Tag reorder in sidebar
      if (activeIsTag && overId.startsWith("tag:")) {
        handleReorderTag(activeId.slice(4), overId.slice(4));
        return;
      }

      if (!activeIsTag && overId === "create-channel") {
        beginCreateChannelFromDrop(
          activeSlugs.length > 1
            ? { type: "blocks", slugs: activeSlugs }
            : { type: "block", slug: activeSlug },
        );
        return;
      }

      // Card dropped on tag
      if (!activeIsTag && overId.startsWith("tag:")) {
        if (activeSlugs.length > 1) {
          handleCardsDrop(activeSlugs, overId.slice(4));
        } else {
          handleCardDrop(activeSlug, overId.slice(4));
        }
      }
    },
    [
      beginCreateChannelFromDrop,
      handleCardDrop,
      handleCardsDrop,
      handleMediaAssetDrop,
      handleReorderTag,
      handleTextSelectionDrop,
    ],
  );

  const handleDndCancel = useCallback(() => {
    setActiveDragBlocks([]);
    setActiveDragTag(null);
    setActiveDragMediaAsset(null);
    setActiveDragTextSelection(null);
    clearActiveMineTextSelectionDragPayload();
  }, []);

  // ── Card tag management (context menu) ───────────────────────────────────

  const handleToggleTag = useCallback(
    async (slug: string, tag: string, hasTag: boolean) => {
      try {
        if (hasTag) {
          await removeTag(slug, tag);
          if (selectedBlock?.slug === slug) {
            setSelectedBlockTags((current) => current.filter((item) => item !== tag));
            setSelectedBlock((current) => (
              current && current.slug === slug && "tags" in current
                ? { ...current, tags: current.tags.filter((item) => item !== tag) }
                : current
            ));
          }
        } else {
          await addTag(slug, tag);
          pushRecentTag(tag);
          if (selectedBlock?.slug === slug) {
            setSelectedBlockTags((current) => (
              current.includes(tag) ? current : [...current, tag]
            ));
            setSelectedBlock((current) => (
              current && current.slug === slug && "tags" in current
                ? {
                    ...current,
                    tags: current.tags.includes(tag) ? current.tags : [...current.tags, tag],
                  }
                : current
            ));
          }
        }
      } catch (err) {
        console.error("Failed to toggle tag:", err);
      }
      await reloadAllSnapshots();
    },
    [reloadAllSnapshots, selectedBlock?.slug],
  );

  const handleCreateTagFromMenu = useCallback(
    async (tag: string, blockSlug: string) => {
      try {
        await addTag(blockSlug, tag);
        pushRecentTag(tag);
        if (selectedBlock?.slug === blockSlug) {
          setSelectedBlockTags((current) => (
            current.includes(tag) ? current : [...current, tag]
          ));
          setSelectedBlock((current) => (
            current && current.slug === blockSlug && "tags" in current
              ? {
                  ...current,
                  tags: current.tags.includes(tag) ? current.tags : [...current.tags, tag],
                }
              : current
          ));
        }
      } catch (err) {
        console.error("Failed to create tag:", err);
      }
      await reloadAllSnapshots();
    },
    [reloadAllSnapshots, selectedBlock?.slug],
  );

  const handleLoadBlockTags = useCallback(async (slugs: string[]) => {
    const entries = await Promise.all(
      slugs.map(async (slug) => {
        const block = await getBlock(slug);
        return [slug, block?.tags ?? []] as const;
      }),
    );
    return new Map(entries);
  }, []);

  const handleBatchSetTag = useCallback(
    async (slugs: string[], tag: string, connected: boolean) => {
      if (slugs.length === 0) return;
      try {
        for (const slug of slugs) {
          if (connected) {
            await addTag(slug, tag);
          } else {
            await removeTag(slug, tag);
          }
        }
        if (connected) {
          pushRecentTag(tag);
        }
        if (selectedBlock && slugs.includes(selectedBlock.slug)) {
          setSelectedBlockTags((current) => {
            if (connected) {
              return current.includes(tag) ? current : [...current, tag];
            }
            return current.filter((item) => item !== tag);
          });
          setSelectedBlock((current) => (
            current && slugs.includes(current.slug) && "tags" in current
              ? {
                  ...current,
                  tags: connected
                    ? (current.tags.includes(tag) ? current.tags : [...current.tags, tag])
                    : current.tags.filter((item) => item !== tag),
                }
              : current
          ));
        }
      } catch (err) {
        console.error("Failed to batch update tags:", err);
        throw err;
      } finally {
        invalidateRoutesForTags([tag]);
        scheduleRefresh({
          grid: currentTagRef.current === undefined || currentTagRef.current === tag,
          taxonomy: true,
          previews: true,
        }, BATCH_TAG_REFRESH_DELAY_MS);
      }
    },
    [invalidateRoutesForTags, scheduleRefresh, selectedBlock],
  );

  const handleCreateTagFromBatchMenu = useCallback(
    async (tag: string, slugs: string[]) => {
      await handleBatchSetTag(slugs, tag, true);
    },
    [handleBatchSetTag],
  );

  const handleDeleteSelectedBlocks = useCallback(
    async (slugs: string[]) => {
      if (slugs.length === 0) return;
      setSelectedBlock(null);
      setSelectedBlockAnchor(null);
      try {
        for (const slug of slugs) {
          await deleteBlock(slug, false);
        }
      } catch (err) {
        console.error("Failed to delete selected blocks:", err);
        throw err;
      } finally {
        await reloadAllSnapshots();
      }
    },
    [reloadAllSnapshots],
  );

  const handleMergeSelectedBlocks = useCallback(
    async (orderedSlugs: string[]) => {
      if (orderedSlugs.length < 2) return;
      setSelectedBlock(null);
      setSelectedBlockAnchor(null);
      try {
        await mergeBlocks(orderedSlugs);
      } catch (err) {
        console.error("Failed to merge selected blocks:", err);
        throw err;
      } finally {
        await reloadAllSnapshots();
      }
    },
    [reloadAllSnapshots],
  );

  const requestDeleteBlock = useCallback((slug: string) => {
    setDeleteTargetSlug(slug);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeleteTargetSlug(null);
    setDeletePlan(null);
    setDeletePlanError(null);
  }, []);

  const performDeleteBlock = useCallback(
    async (slug: string, deleteUnusedMedia: boolean) => {
      setSelectedBlock(null);
      setSelectedBlockAnchor(null);
      // Optimistic notice for overlay-owned result sets (search): the row
      // disappears immediately; the later "vault-refreshed" confirms the
      // truth (and self-heals the list if the delete failed).
      window.dispatchEvent(new CustomEvent("block-deleted", { detail: { slug } }));
      try {
        await deleteBlock(slug, deleteUnusedMedia);
      } catch (err) {
        console.error("Failed to delete block:", err);
      }
      await reloadAllSnapshots();
    },
    [reloadAllSnapshots],
  );

  const confirmDeleteBlock = useCallback(
    (deleteUnusedMedia: boolean) => {
      if (!deleteTargetSlug || !deletePlan || deletePlanError) return;
      const slug = deleteTargetSlug;
      closeDeleteDialog();
      void performDeleteBlock(slug, deleteUnusedMedia);
    },
    [closeDeleteDialog, deletePlan, deletePlanError, deleteTargetSlug, performDeleteBlock],
  );

  const handleRenameBlock = useCallback(
    async (block: LightBlock | IndexedBlock, newStem: string) => {
      const result = await renameBlockFile(block.slug, newStem);
      await reloadAllSnapshots();
      const refreshed = await getBlock(result.new_slug);
      if (refreshed) {
        setSelectedBlock((current) => {
          if (!current || current.slug !== block.slug) {
            return current;
          }
          return refreshed;
        });
      } else {
        setSelectedBlock((current) => {
          if (!current || current.slug !== block.slug) {
            return current;
          }
          return {
            ...current,
            slug: result.new_slug,
          };
        });
      }
    },
    [reloadAllSnapshots],
  );

  if (!vaultReady && !loadError) {
    return (
      <div className="flex h-screen w-screen flex-col bg-background text-foreground">
        <header
          data-tauri-drag-region
          className={cn(
            "flex h-8 shrink-0 items-center border-b border-border",
            topChromeSurfaceClass,
          )}
        >
          <div
            data-tauri-drag-region
            data-traffic-light-reserve=""
            className={cn("w-20 shrink-0", topChromeSurfaceClass)}
          />
          <div data-tauri-drag-region className="flex flex-1 items-center px-3" />
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Opening vault…</p>
        </div>
      </div>
    );
  }

  const showPreparingLibrary =
    migrationRequired
    && !loadError
    && (isSyncing || (blocks.length === 0 && tags.length === 0 && channels.length === 0));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarPointerWithin}
      autoScroll={{ canScroll: (el) => el.hasAttribute("data-sidebar-scroll") }}
      onDragStart={handleDndStart}
      onDragEnd={handleDndEnd}
      onDragCancel={handleDndCancel}
    >
    <div
      className="flex h-screen w-screen flex-col bg-background text-foreground"
      style={{ minWidth: APP_MIN_WIDTH_PX }}
    >
      {/* Top toolbar */}
      <header
        data-tauri-drag-region
        className={cn(
          "flex h-8 shrink-0 items-center border-b border-border",
          topChromeSurfaceClass,
        )}
      >
        <div
          data-tauri-drag-region
          data-app-top-sidebar-segment=""
          className={cn(
            "flex h-full shrink-0 items-center overflow-hidden border-r border-sidebar-border",
            sidebarCollapsed && "w-auto max-w-[240px]",
            !sidebarResizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={sidebarCollapsed ? undefined : { width: "var(--sidebar-width)" }}
        >
          <div
            data-tauri-drag-region
            data-traffic-light-reserve=""
            className={cn("w-20 max-w-full shrink-0", topChromeSurfaceClass)}
          />
          <div
            aria-hidden="true"
            className="h-full w-px shrink-0 bg-border"
            data-top-chrome-space-separator=""
          />
          <div
            className={cn(
              "flex h-full min-w-0",
              sidebarCollapsed ? "flex-none" : "flex-1",
            )}
            data-top-chrome-space-search-group=""
          >
            <VaultSwitcher
              currentPath={vaultPath}
              onVaultSelected={(path) => {
                navigate("/", { replace: true });
                onVaultSelected(path);
              }}
              surface="topChrome"
              topChromeCollapsed={sidebarCollapsed}
            />
            {!sidebarCollapsed && (
              <>
                <div
                  aria-hidden="true"
                  className="h-full w-px shrink-0 bg-border"
                  data-top-chrome-search-separator=""
                />
                <div
                  {...sidebarSearchChromeDragGesture}
                  className={[
                    "group/sidebar-search flex h-full min-w-0 flex-1 items-center",
                    sidebarSearchActiveSurfaceClass,
                  ].filter(Boolean).join(" ")}
                  data-sidebar-top-search-surface=""
                >
                  <Input
                    ref={sidebarSearchInputRef}
                    {...SEARCH_INPUT_SUPPRESSION_PROPS}
                    aria-label="Filter collections"
                    aria-activedescendant={
                      sidebarSearchKeyboardNavigationFocus
                        ? sidebarRowDomId(sidebarSearchKeyboardNavigationFocus.rowKey)
                        : undefined
                    }
                    placeholder="Filter collections..."
                    variant="ghost"
                    value={sidebarSearchQuery}
                    onChange={(event) => handleSidebarSearchChange(event.target.value)}
                    onKeyDown={handleSidebarSearchKeyDown}
                    className="h-full min-w-0 flex-1 rounded-0 bg-transparent px-3 py-0 font-mono text-sm text-muted-foreground hover:placeholder:text-muted-foreground focus:placeholder:text-muted-foreground group-hover/sidebar-search:placeholder:text-muted-foreground"
                    data-sidebar-top-search=""
                  />
                  {sidebarSearchHasValue && (
                    <button
                      type="button"
                      aria-label="Clear collection search"
                      className={cn(
                        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-1 text-muted-foreground hover:bg-component-fill-hover hover:text-foreground focus-visible:bg-component-fill-hover focus-visible:text-foreground focus-visible:outline-none",
                        compactDetailTopMenuActive ? "mr-1" : "mr-3",
                      )}
                      onClick={handleClearSidebarSearch}
                      data-sidebar-top-search-clear=""
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  )}
                  {compactDetailTopMenuActive && renderedDetailBlock && (
                    <CompactDetailLinkModeSwitch
                      value={detailLinkMode}
                      onChange={setDetailLinkMode}
                      chromeDragEnabled={false}
                      className="detail-top-bar-enter mr-2"
                      entered={compactDetailChromeEntered}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center">
          <TopCollectionSwitcher
            currentTag={currentTag}
            orderedTags={orderedTags}
            compact={topCollectionSwitcherCompact}
            onNavigate={handleTopCollectionNavigate}
            onCreateCollection={handleTopCollectionCreate}
          />
          {compactDetailTopMenuActive && renderedDetailBlock ? (
            <CompactDetailTopMenu
              block={renderedDetailBlock}
              cardTitle={compactDetailCardTitle}
              vaultPath={vaultPath}
              tags={orderedTags}
              currentTag={currentTag}
              onToggleTag={handleToggleTag}
              onCreateAndAssign={handleCreateTagFromMenu}
              onRequestRename={setRenamingBlock}
              onRequestDelete={requestDeleteBlock}
              onClose={handleDetailClose}
              menuOpenRequestSequence={compactDetailTopMenuRequestSequence}
              entered={compactDetailChromeEntered}
            />
          ) : (
            <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
          )}
          {bottomActionBarHidden && (
            <div
              // Right-edge inset follows the app-wide edge rhythm (the bottom
              // action bar, the grid's side insets, the sidebar table).
              className="ml-2 mr-[var(--edge-rhythm,32px)] flex shrink-0 items-center gap-2"
              data-top-chrome-settings-fallback=""
            >
              <ActionButton hotkey="⌘," onClick={handleOpenSettings}>
                Settings
              </ActionButton>
            </div>
          )}
        </div>
      </header>

      {mainSecondaryTopBarVisible && (
        <MainSecondaryTopBar
          sidebarCollapsed={sidebarCollapsed}
          sidebarResizing={sidebarResizing}
          stats={vaultStats}
          cloudPending={blocks.filter((item) => item.content_in_cloud).length}
          indexing={isSyncing}
          onRevealSpace={() => void revealItemInDir(vaultPath)}
          detailBlock={renderedDetailBlock}
          detailTitle={compactDetailCardTitle}
          detailEntered={compactDetailChromeEntered}
          detailLinkMode={detailLinkMode}
          onDetailLinkModeChange={setDetailLinkMode}
          viewMode={mainViewMode}
          onViewModeChange={handleMainViewModeChange}
          vaultPath={vaultPath}
          tags={orderedTags}
          currentTag={currentTag}
          onToggleTag={handleToggleTag}
          onCreateAndAssign={handleCreateTagFromMenu}
          onRequestRename={setRenamingBlock}
          onRequestDelete={requestDeleteBlock}
          onDetailClose={handleDetailClose}
          detailMenuOpenRequestSequence={compactDetailTopMenuRequestSequence}
        />
      )}

      {/* Body: sidebar + main */}
      <div className="flex min-h-0 flex-1">
      <Sidebar
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        isResizing={sidebarResizing}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath ?? undefined}
        tags={orderedTags}
        currentTag={currentTag}
        orderedTags={orderedTags}
        channelPreviews={channelPreviews}
        totalBlocks={totalBlocks}
        isDropDragging={
          activeDragBlock !== null
          || activeDragMediaAsset !== null
          || activeDragTextSelection !== null
        }
        isTagDragging={activeDragTag !== null}
        isCreatingChannel={isCreatingChannel}
        onSetCreatingChannel={handleSetCreatingChannel}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
        onCreateChannel={handleCreateChannel}
        onOpenBlock={openDetailBlock}
        onOpenCardMenu={openCardActionsMenu}
        hoverPreviewFrozen={cardActionsMenuTarget !== null}
        onToggleTag={handleToggleTag}
        onCreateAndAssign={handleCreateTagFromMenu}
        onRequestRename={setRenamingBlock}
        onRequestDelete={requestDeleteBlock}
        onNavClick={handleDetailClose}
        onScrollToTop={handleScrollToTop}
        keyboardNavigationFocus={
          sidebarSearchKeyboardNavigationFocus ?? sidebarKeyboardNavigationFocus
        }
        keyboardNavigationFocusPersistent={sidebarSearchKeyboardNavigationFocus !== null}
        searchQuery={sidebarSearchQuery}
        headerSlot={
          <>
            <ClipperRecoveryBanner
              vaultReady={vaultReady}
              onRecovered={() => void reloadAllSnapshots()}
            />
            <VaultConflictsBanner vaultReady={vaultReady} />
          </>
        }
        linkedBlockSlug={renderedLinkedBlockSlug}
        linkedTags={renderedLinkedTags}
        onToggleLinkedTag={handleToggleTag}
        linkMode={detailLinkMode}
        onLinkModeChange={setDetailLinkMode}
        showLinkModeChrome={false}
        detailChromeClosing={detailChromeClosing}
        scrollEdgeFade={scrollEdgeFade}
      />

      <SidebarResizeHandle
        isResizing={sidebarResizing}
        secondaryBarVisible={mainSecondaryTopBarVisible}
        disabled={
          activeDragBlock !== null
          || activeDragMediaAsset !== null
          || activeDragTag !== null
          || activeDragTextSelection !== null
        }
        onResizeStart={startResize}
        onResizeUpdate={updateResize}
        onResizeEnd={endResize}
        onToggleCollapsed={toggleCollapsed}
      />

      <main
        ref={mainRef}
        className="relative isolate flex-1 overflow-hidden"
        style={{ minWidth: APP_MAIN_MIN_WIDTH_PX }}
      >
        {loadError && (
          <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-destructive">{loadError}</p>
          </div>
        )}
        {!loadError && showPreparingLibrary && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/96 px-[var(--edge-rhythm,32px)]">
            <div className="max-w-md text-center">
              <p className="text-base font-medium text-foreground">Preparing library…</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Creating a local index and preview cache for this vault. The shell is ready;
                the first usable snapshot will appear as soon as the initial rebuild commits.
              </p>
              <p className="mt-4 text-sm text-muted-foreground">
                Steps: Creating local index → Scanning markdown → Generating previews
              </p>
            </div>
          </div>
        )}
        <Routes>
          <Route
            element={
              <PageShell
                blocks={activeBlocks}
                vaultPath={vaultPath}
                thumbsRootPath={thumbsRootPath ?? undefined}
                thumbVersions={feedThumbVersions}
                tags={orderedTags}
                currentTag={currentTag}
                viewMode={mainViewMode}
                graphPreferences={graphPreferences}
                scrollEdgeFade={scrollEdgeFade}
                routeSnapshotReady={gridRouteSnapshotReady}
                scrollToTop={scrollToTopSignal}
                blockDragActive={activeDragBlocks.length > 0}
                detailOpen={Boolean(renderedDetailBlock)}
                selectedBlockSlug={renderedDetailBlock?.slug ?? null}
                keyboardNavigationDisabled={gridKeyboardNavigationDisabled}
                restoreFocusSlug={gridFocusRestore?.slug ?? null}
                restoreFocusSequence={gridFocusRestore?.sequence ?? 0}
                onBlockClick={handleBlockClick}
                onToggleTag={handleToggleTag}
                onCreateAndAssign={handleCreateTagFromMenu}
                onLoadBlockTags={handleLoadBlockTags}
                onBatchSetTag={handleBatchSetTag}
                onCreateAndAssignBatch={handleCreateTagFromBatchMenu}
                onDeleteSelectedBlocks={handleDeleteSelectedBlocks}
                onMergeSelectedBlocks={handleMergeSelectedBlocks}
                onCardMenuOpenChange={handleCardMenuOpenChange}
                onRequestRename={setRenamingBlock}
                onRequestDelete={requestDeleteBlock}
                onColumnCountChange={handleColumnCountChange}
                hasMoreBlocks={hasMoreBlocks}
                loadingMoreBlocks={loadingMoreBlocks}
                onLoadMoreBlocks={loadMoreBlocks}
                onOpenBlock={openDetailBlock}
                onOpenCardMenu={openCardActionsMenu}
                hoverPreviewFrozen={cardActionsMenuTarget !== null}
                onNavigateCollection={handleTopCollectionNavigate}
                acceptGraphRevision={acceptGraphRevision}
                onInstallClipper={() => void openSettingsWindow()}
              />
            }
          >
            <Route index element={<AllBlocksPage />} />
            <Route path="channel/:tag" element={<ChannelPage />} />
          </Route>
        </Routes>

        {designSystemOpen && (
          <div className="absolute inset-0 z-40 overflow-y-auto bg-background" data-design-scroll>
            <Suspense fallback={null}>
              <ComponentTestBench />
            </Suspense>
          </div>
        )}

        {renderedDetailBlock && (
          <Suspense fallback={null}>
            <Detail
              block={renderedDetailBlock}
              scrollAnchor={selectedBlockAnchor}
              vaultPath={vaultPath}
              thumbsRootPath={thumbsRootPath ?? undefined}
              isClosing={detailChromeClosing}
              scrollEdgeFade={scrollEdgeFade}
              topChromeMode="external"
              onClose={handleDetailClose}
              onNavigate={handleDetailNavigate}
              tags={orderedTags}
              currentTag={currentTag}
              onToggleTag={handleToggleTag}
              onCreateAndAssign={handleCreateTagFromMenu}
              onRequestRename={setRenamingBlock}
              onRequestDelete={requestDeleteBlock}
              onCreateMediaAssetCard={handleMediaAssetCreateCard}
              onCreateChannelAndMediaAssetCard={handleMediaAssetCreateChannelAndCard}
              onRenameMediaAsset={handleMediaAssetRename}
              onRemoveMediaAssetFromCard={handleMediaAssetRemoveFromCard}
              onDeleteMediaAsset={handleMediaAssetDelete}
              onOpenImagePreview={setImagePreview}
              onOpenRelatedNote={handleOpenRelatedNote}
              onTextSelectionDrop={handleTextSelectionDrop}
              onCreateChannelAndTextSelectionCard={handleTextSelectionCreateChannelAndCard}
              onTextSelectionDelete={handleTextSelectionDelete}
              onTagsChanged={() => {
                void reloadAllSnapshots();
              }}
            />
          </Suspense>
        )}

        <DeleteBlockDialog
          open={deleteTargetSlug !== null}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath ?? undefined}
          plan={deletePlan}
          error={deletePlanError}
          onOpenChange={(open) => {
            if (!open) closeDeleteDialog();
          }}
          onKeepMedia={() => confirmDeleteBlock(false)}
          onDeleteMedia={() => confirmDeleteBlock(Boolean(deletePlan?.unused_media.length))}
        />
      </main>

      <RenameBlockDialog
        open={renamingBlock !== null}
        currentSlug={renamingBlock?.slug ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingBlock(null);
          }
        }}
        onRename={async (currentSlug, newStem) => {
          const current =
            (selectedBlock && selectedBlock.slug === currentSlug ? selectedBlock : null)
            ?? renamingBlock;
          if (!current) {
            throw { kind: "block_not_found", slug: currentSlug } as const;
          }
          await handleRenameBlock(current, newStem);
          setRenamingBlock(null);
        }}
      />

      <SearchOverlay
        open={searchOverlayOpen}
        query={searchOverlayQuery}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath ?? undefined}
        onQueryChange={setSearchOverlayQuery}
        scrollEdgeFade={scrollEdgeFade}
        onClose={() => setSearchOverlayOpen(false)}
        onOpenBlock={handleSearchOverlayOpenBlock}
        loadBlockTags={handleLoadBlockTags}
        tags={orderedTags}
        currentTag={currentTag}
        onToggleTag={handleToggleTag}
        onCreateAndAssign={handleCreateTagFromMenu}
        onRequestRename={setRenamingBlock}
        onRequestDelete={requestDeleteBlock}
      />
      {cardActionsMenuTarget ? (
        <CardPointMenu
          block={cardActionsMenuTarget.block}
          vaultPath={vaultPath}
          tags={orderedTags}
          currentTag={currentTag}
          x={cardActionsMenuTarget.x}
          y={cardActionsMenuTarget.y}
          openRequestSequence={cardActionsMenuTarget.sequence}
          onToggleTag={handleToggleTag}
          onCreateAndAssign={handleCreateTagFromMenu}
          onRequestRename={setRenamingBlock}
          onRequestDelete={requestDeleteBlock}
          onOpenChange={(open) => {
            if (!open) {
              setCardActionsMenuTarget(null);
            }
          }}
        />
      ) : null}
    </div>{/* end body */}

      {!bottomActionBarHidden && (
        <div
          className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-accent px-[var(--edge-rhythm,32px)]"
          data-bottom-action-bar=""
        >
          <ActionButton hotkey="⌘⇧N" onClick={() => setIsCreatingChannel(true)}>
            New Collection
          </ActionButton>
          <ActionButton hotkey="⌘," onClick={handleOpenSettings}>
            Settings
          </ActionButton>
          <ActionButton
            onClick={() => setDesignSystemOpen((v) => !v)}
            isSelected={designSystemOpen}
          >
            Design
          </ActionButton>
          <div className="flex-1" />
          {isSyncing && (
            <span className="text-sm text-muted-foreground">Syncing…</span>
          )}
          <ActionButton
            hotkey="⌘F"
            onClick={toggleSearchOverlay}
          >
            Search elements
          </ActionButton>
        </div>
      )}

      <Suspense fallback={null}>
        <DropZone
          currentTag={currentTag}
          onBlocksCreated={() => {
            void reloadAllSnapshots();
          }}
        />
      </Suspense>
      <ImagePreviewOverlay
        preview={imagePreview}
        onClose={() => setImagePreview(null)}
      />
    </div>{/* end flex-col */}

    <DragOverlay
      dropAnimation={overlayDressing === "row" ? TAG_ROW_DROP_ANIMATION : null}
      modifiers={overlayDressing === "row" ? TAG_ROW_OVERLAY_MODIFIERS : POINT_OVERLAY_MODIFIERS}
      style={{ pointerEvents: "none" }}
    >
      {activeDragBlocks.length > 0 && (
        <DragCardStackPreview
          blocks={activeDragBlocks}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath ?? undefined}
        />
      )}
      {activeDragMediaAsset && activeDragMediaAsset.src && (
        // Single sizing owner: the img box. A max-h/max-w pair on an <img>
        // always yields an aspect-true box, so no object-fit is needed. The
        // frame is decoration only — it shrink-wraps the image (inline-flex)
        // and carries border/radius/shadow. Giving the frame its own max-*
        // double-constrains the geometry: the border eats into the clamped
        // box and background slivers leak around the image.
        <div className="pointer-events-none inline-flex overflow-hidden rounded-1 border border-border bg-background shadow-lg">
          <img
            src={activeDragMediaAsset.src}
            alt=""
            className="max-h-48 max-w-64"
            draggable={false}
          />
        </div>
      )}
      {activeDragTextSelection && (
        <div className="pointer-events-none w-72 max-w-[calc(100vw-2rem)] rounded-1 border border-border bg-background px-3 py-2 text-sm shadow-lg">
          <p
            className="overflow-hidden whitespace-pre-wrap text-foreground"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 3,
            }}
          >
            {activeDragTextSelection.selectedText}
          </p>
        </div>
      )}
      {activeDragTag && (
        <SidebarTagRowDragPreview
          label={collectionRefLabel(activeDragTag)}
          count={orderedTags.find((tc) => tc.tag === activeDragTag)?.count ?? 0}
          cards={channelPreviews.get(activeDragTag) ?? []}
        />
      )}
    </DragOverlay>
    </DndContext>
  );
}

// ─── Route context ─────────────────────────────────────────────────────────

interface RouteContext {
  blocks: LightBlock[];
  vaultPath: string;
  thumbsRootPath?: string;
  thumbVersions: ReadonlyMap<string, number>;
  tags: TagCount[];
  currentTag?: string;
  viewMode: MainViewMode;
  graphPreferences: GraphPreferences;
  scrollEdgeFade: boolean;
  routeSnapshotReady: boolean;
  scrollToTop: number;
  blockDragActive: boolean;
  detailOpen: boolean;
  selectedBlockSlug: string | null;
  keyboardNavigationDisabled: boolean;
  restoreFocusSlug: string | null;
  restoreFocusSequence: number;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
  onLoadBlockTags: (slugs: string[]) => Promise<Map<string, string[]>>;
  onBatchSetTag: (slugs: string[], tag: string, connected: boolean) => void | Promise<void>;
  onCreateAndAssignBatch: (tag: string, slugs: string[]) => void | Promise<void>;
  onDeleteSelectedBlocks: (slugs: string[]) => void | Promise<void>;
  onMergeSelectedBlocks: (orderedSlugs: string[]) => void | Promise<void>;
  onGroupSelectionStart?: () => void;
  onCardMenuOpenChange?: (slug: string, open: boolean) => void;
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onColumnCountChange: (count: number) => void;
  hasMoreBlocks: boolean;
  loadingMoreBlocks: boolean;
  onLoadMoreBlocks: () => void;
  onOpenBlock: (block: LightBlock | IndexedBlock) => void;
  onOpenCardMenu: (block: LightBlock | IndexedBlock, point: { x: number; y: number }) => void;
  hoverPreviewFrozen: boolean;
  onNavigateCollection: (collectionRef?: string) => void;
  acceptGraphRevision: (revision: ProjectionRevision) => boolean;
  /// Offered by the empty-space onboarding, which is the only place in the app
  /// that can introduce the clipper to someone who has never seen it.
  onInstallClipper: () => void;
}

function PageShell(props: RouteContext) {
  return <Outlet context={props} />;
}

function useRouteCtx(): RouteContext {
  return useOutletContext<RouteContext>();
}

// ─── Pages ─────────────────────────────────────────────────────────────────

function AllBlocksPage() {
  const ctx = useRouteCtx();
  if (ctx.viewMode === "graph") {
    return (
      <GraphView
        currentCollection={undefined}
        vaultPath={ctx.vaultPath}
        thumbsRootPath={ctx.thumbsRootPath}
        loadedBlocks={ctx.blocks}
        thumbVersions={ctx.thumbVersions}
        graphPreferences={ctx.graphPreferences}
        hoverPreviewFrozen={ctx.hoverPreviewFrozen}
        selectedSlug={ctx.selectedBlockSlug}
        detailOpen={ctx.detailOpen}
        onOpenBlock={ctx.onOpenBlock}
        onOpenCardMenu={ctx.onOpenCardMenu}
        onNavigateCollection={ctx.onNavigateCollection}
        acceptSnapshotRevision={ctx.acceptGraphRevision}
      />
    );
  }
  return <Grid {...ctx} blocks={ctx.blocks} />;
}

function ChannelPage() {
  const ctx = useRouteCtx();
  if (ctx.viewMode === "graph") {
    return (
      <GraphView
        currentCollection={ctx.currentTag}
        vaultPath={ctx.vaultPath}
        thumbsRootPath={ctx.thumbsRootPath}
        loadedBlocks={ctx.blocks}
        thumbVersions={ctx.thumbVersions}
        graphPreferences={ctx.graphPreferences}
        hoverPreviewFrozen={ctx.hoverPreviewFrozen}
        selectedSlug={ctx.selectedBlockSlug}
        detailOpen={ctx.detailOpen}
        onOpenBlock={ctx.onOpenBlock}
        onOpenCardMenu={ctx.onOpenCardMenu}
        onNavigateCollection={ctx.onNavigateCollection}
        acceptSnapshotRevision={ctx.acceptGraphRevision}
      />
    );
  }
  return <Grid {...ctx} blocks={ctx.blocks} />;
}
