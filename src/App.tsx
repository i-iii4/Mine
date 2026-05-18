import { Suspense, lazy, useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  useOutletContext,
  useNavigate,
  useLocation,
} from "react-router";
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
import { arrayMove } from "@dnd-kit/sortable";
import { collectionRefLabel } from "@/lib/collections";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";
import {
  isDetailShortcutBlockedTarget,
  isEditableKeyboardTarget,
  isOverlayKeyboardTarget,
} from "@/lib/keyboardTargets";

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

const BATCH_TAG_REFRESH_DELAY_MS = 750;

import type { DeleteBlockPlan, IndexedBlock, LightBlock, TagCount, ChannelDto, GridSnapshot, MediaAssetRef } from "@/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getVaultPath,
  openVault,
  selectVault,
  startVaultSync,
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
  getBlock,
  createMediaAssetCard,
  renameMediaAsset,
  deleteMediaAsset,
  removeMediaAssetFromCard,
  extractTextSelection,
  sweepVaultThumbnails,
} from "@/lib/commands";
import { ArticleAudioGatewayProvider } from "@/lib/articleAudioGateway";
import { desktopArticleAudioGateway } from "@/lib/articleAudioDesktopGateway";
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
import { VaultPicker } from "@/components/VaultPicker";
import { VaultSwitcher } from "@/components/VaultSwitcher";
import { Sidebar } from "@/components/Sidebar";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { ClipperRecoveryBanner } from "@/components/ClipperRecoveryBanner";
import { VaultConflictsBanner } from "@/components/VaultConflictsBanner";
import { Grid } from "@/components/Grid";
import { DragCardStackPreview } from "@/components/Card";
import { ActionButton } from "@/components/ActionButton";
import { ThemeMenuButton, type ThemeMenuHandle } from "@/components/ThemeMenuButton";
import { RenameBlockDialog } from "@/components/RenameBlockDialog";
import { DeleteBlockDialog } from "@/components/DeleteBlockDialog";
import {
  ImagePreviewOverlay,
  type ImagePreviewRequest,
} from "@/components/ImagePreviewOverlay";

const Search = lazy(async () => {
  const mod = await import("@/components/Search");
  return { default: mod.Search };
});

const Detail = lazy(async () => {
  const mod = await import("@/components/Detail");
  return { default: mod.Detail };
});

const ImportDialog = lazy(async () => {
  const mod = await import("@/components/ImportDialog");
  return { default: mod.ImportDialog };
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
const DETAIL_CHROME_TRANSITION_MS = 360;

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const started = performance.now();
    console.info("[startup] getVaultPath:start");
    getVaultPath()
      .then((path) => {
        console.info("[startup] getVaultPath:done", {
          path,
          elapsedMs: Math.round(performance.now() - started),
        });
        setVaultPath(path);
      })
      .catch((err) => {
        console.error("[startup] getVaultPath:failed", err);
        setVaultPath(null);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <p className="text-base text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!vaultPath) {
    return <VaultPicker onVaultSelected={setVaultPath} />;
  }

  return (
    <ArticleAudioGatewayProvider gateway={desktopArticleAudioGateway}>
      <BrowserRouter>
        <AppWithVault
          key={vaultPath}
          vaultPath={vaultPath}
          onVaultSelected={setVaultPath}
        />
      </BrowserRouter>
    </ArticleAudioGatewayProvider>
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

  const currentTag = location.pathname.startsWith("/channel/")
    ? decodeURIComponent(location.pathname.slice("/channel/".length))
    : undefined;

  const [blocks, setBlocks] = useState<LightBlock[]>([]);
  const [totalBlocks, setTotalBlocks] = useState(0);
  const [hasMoreBlocks, setHasMoreBlocks] = useState(false);
  const [loadingMoreBlocks, setLoadingMoreBlocks] = useState(false);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [designSystemOpen, setDesignSystemOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreviewRequest | null>(null);
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [pendingCreateChannelDrop, setPendingCreateChannelDrop] =
    useState<PendingCreateChannelDrop | null>(null);
  const [renamingBlock, setRenamingBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [selectedBlockAnchor, setSelectedBlockAnchor] = useState<string | null>(null);
  const [selectedBlockTags, setSelectedBlockTags] = useState<string[]>([]);
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
  const [scrollToTopSignal, setScrollToTopSignal] = useState(0);
  const [sidebarKeyboardNavigationFocus, setSidebarKeyboardNavigationFocus] = useState<{
    rowKey: string;
    sequence: number;
  } | null>(null);
  const [activeDragBlocks, setActiveDragBlocks] = useState<LightBlock[]>([]);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);
  const [activeDragMediaAsset, setActiveDragMediaAsset] = useState<MediaAssetDragPreview | null>(null);
  const [activeDragTextSelection, setActiveDragTextSelection] = useState<TextSelectionDragPreview | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const themeMenuRef = useRef<ThemeMenuHandle>(null);
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
  const routeSnapshotCacheRef = useRef<Map<string, GridSnapshot>>(new Map());
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
    setSelectedBlockAnchor(anchor);
    setSelectedBlock(block);
  }, [cancelPendingDetailClose]);

  const applyGridSnapshot = useCallback((tag: string | undefined, grid: GridSnapshot) => {
    routeSnapshotCacheRef.current.set(routeKeyFor(tag), grid);
    setBlocks(grid.blocks);
    setTotalBlocks(grid.total_blocks);
    setHasMoreBlocks(grid.has_more);
    setLoadingMoreBlocks(false);
  }, [routeKeyFor]);

  const invalidateRouteSnapshots = useCallback(() => {
    routeSnapshotCacheRef.current.clear();
    lastRevalidatedRouteKeyRef.current = null;
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
  const renderedDetailBlock = selectedBlock ?? closingDetailBlock;
  const renderedLinkedBlockSlug = selectedBlock?.slug
    ?? (detailChromeClosing ? closingDetailBlock?.slug ?? null : null);
  const renderedLinkedTags = selectedBlock
    ? selectedBlockTags
    : (detailChromeClosing ? closingDetailTags : []);
  const gridKeyboardNavigationDisabled = Boolean(renderedDetailBlock)
    || searchOpen
    || designSystemOpen
    || importOpen
    || renamingBlock !== null
    || deleteTargetSlug !== null
    || isCreatingChannel;

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
  });

  // Phase 2 thumbnail upgrade pipeline: Web Worker decodes webp/heic/
  // video media via the browser's native decoder and writes real JPEG
  // bytes back through save_thumb. Mounts once vault is open.
  useThumbnailUpgrade(vaultReady);

  const [loadError, setLoadError] = useState<string | null>(null);

  const invalidateRoutesForTags = useCallback((affectedTags: readonly string[]) => {
    routeSnapshotCacheRef.current.delete(routeKeyFor(undefined));
    for (const tag of affectedTags) {
      routeSnapshotCacheRef.current.delete(routeKeyFor(tag));
    }
    lastRevalidatedRouteKeyRef.current = null;
  }, [routeKeyFor]);

  const loadGridSnapshot = useCallback(async ({
    tag = currentTagRef.current,
    preferCachedRoute = false,
    invalidateCachedRoutes = false,
  }: {
    tag?: string;
    preferCachedRoute?: boolean;
    invalidateCachedRoutes?: boolean;
  } = {}) => {
    const requestId = ++loadRequestIdRef.current;
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
    try {
      const grid = await listGridBlocks(tagAtStart, 0, GRID_PAGE_SIZE);
      if (
        loadRequestIdRef.current !== requestId
        || vaultPathRef.current !== pathAtStart
        || currentTagRef.current !== tagAtStart
      ) {
        return;
      }
      applyGridSnapshot(tagAtStart, grid);
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
  }, []);

  const loadGridSnapshotRef = useRef(loadGridSnapshot);
  loadGridSnapshotRef.current = loadGridSnapshot;
  const loadTaxonomySnapshotRef = useRef(loadTaxonomySnapshotState);
  loadTaxonomySnapshotRef.current = loadTaxonomySnapshotState;
  const initialRouteLoadDoneRef = useRef(false);

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
    void getBlock(selectedBlock.slug).then((full) => {
      if (!cancelled && full) {
        setSelectedBlockTags(full.tags);
      }
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
        pending.grid ? loadGridSnapshotRef.current({ preferCachedRoute: true }) : Promise.resolve(),
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
  }, [flushRefreshQueue, vaultReady]);

  const reloadAllSnapshots = useCallback(async () => {
    invalidateRouteSnapshots();
    await Promise.all([
      loadGridSnapshot({ invalidateCachedRoutes: true }),
      loadTaxonomySnapshotState(),
      loadPreviews(),
    ]);
  }, [invalidateRouteSnapshots, loadGridSnapshot, loadPreviews, loadTaxonomySnapshotState]);

  const loadMoreBlocks = useCallback(async () => {
    if (loadingMoreBlocks || !hasMoreBlocks) return;
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = currentTagRef.current;
    const offsetAtStart = blocksRef.current.length;
    setLoadingMoreBlocks(true);
    try {
      const grid = await listGridBlocks(tagAtStart, offsetAtStart, GRID_PAGE_SIZE);
      if (vaultPathRef.current !== pathAtStart || currentTagRef.current !== tagAtStart) {
        return;
      }
      setBlocks((prev) => {
        const seen = new Set(prev.map((block) => block.id));
        const appended = grid.blocks.filter((block) => !seen.has(block.id));
        const nextBlocks = appended.length > 0 ? [...prev, ...appended] : prev;
        routeSnapshotCacheRef.current.set(routeKeyFor(tagAtStart), {
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
      if (vaultPathRef.current === pathAtStart && currentTagRef.current === tagAtStart) {
        console.error("[LOAD_MORE] FAILED:", msg, err);
        setLoadError(msg);
      }
    } finally {
      if (vaultPathRef.current === pathAtStart && currentTagRef.current === tagAtStart) {
        setLoadingMoreBlocks(false);
      }
    }
  }, [hasMoreBlocks, loadingMoreBlocks, routeKeyFor]);

  useEffect(() => {
    let cancelled = false;
    setVaultReady(false);
    setLoadError(null);
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

  // Passive thumb sweep on window focus / visibility changes.
  // Covers the gap where `notify` on iCloud Drive does not reliably
  // deliver Modify events: when the user returns to Mine after editing
  // an image elsewhere (or after iCloud syncs a file from another
  // device), we re-verify the thumb cache against current media mtimes
  // and regenerate only what is actually stale. Throttled to at most
  // once every 10 seconds so a flurry of focus events does not pile up.
  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    let lastRun = 0;
    const MIN_INTERVAL_MS = 10_000;
    const run = () => {
      const now = Date.now();
      if (now - lastRun < MIN_INTERVAL_MS) return;
      if (document.visibilityState !== "visible") return;
      lastRun = now;
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
  }, [vaultReady]);

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
      void getBlock(event.payload.new_slug).then((full) => {
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
      });
      scheduleRefresh({
        grid: true,
        previews: true,
      }, 0);
    }));

    unlistenFns.push(listen<ThumbUpdatedEvent>("thumb:updated", (event) => {
      bumpThumbVersion(event.payload.slug);
      scheduleRefresh({ previews: true });
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
  }, [bumpThumbVersion, invalidateRouteSnapshots, invalidateRoutesForTags, migrationRequired, reloadAllSnapshots, scheduleRefresh, vaultReady]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
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

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableKeyboardTarget(e.target)) return;
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
        && e.key.toLowerCase() === "l"
        && selectedBlock
      ) {
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        void navigator.clipboard
          .writeText(blockMarkdownPath(vaultPath, selectedBlock.slug))
          .catch((err) => console.error("Failed to copy card path:", err));
        return;
      }
      if (isOverlayKeyboardTarget(e.target)) return;
      if (!e.metaKey) return;
      if (e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.shiftKey && e.key === "O") {
        e.preventDefault();
        handleSwitchVault();
      } else if (e.shiftKey && e.key === "N") {
        e.preventDefault();
        setIsCreatingChannel(true);
      } else if (e.key === ",") {
        e.preventDefault();
        themeMenuRef.current?.toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSwitchVault, navigate, selectedBlock, vaultPath]);

  // ── Block navigation ──────────────────────────────────────────────────────

  const handleBlockClick = useCallback((block: LightBlock) => {
    openDetailBlock(block);
  }, [openDetailBlock]);

  const handleDetailClose = useCallback(() => {
    if (!selectedBlock || detailChromeClosing) return;
    requestGridFocusRestore(selectedBlock.slug);
    setSelectedBlockAnchor(null);
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
    }, DETAIL_CHROME_TRANSITION_MS);
  }, [selectedBlock, selectedBlockTags, detailChromeClosing, cancelPendingDetailClose, requestGridFocusRestore]);

  const handleScrollToTop = useCallback(() => {
    if (selectedBlock) {
      if (detailChromeClosing) return;
      setSelectedBlockAnchor(null);
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
      }, DETAIL_CHROME_TRANSITION_MS);
      return;
    }
    setScrollToTopSignal((n) => n + 1);
  }, [selectedBlock, selectedBlockTags, detailChromeClosing, cancelPendingDetailClose]);

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
    void getBlock(baseRelatedNoteSlug(slug)).then((block) => {
      if (block) {
        openDetailBlock(block, blockAnchor);
      }
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

    return [...withPos, ...noPos];
  }, [tags, channels]);

  // ── Opt+Cmd+Up/Down — switch channels ─────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey && e.altKey)) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (
        e.defaultPrevented
        || selectedBlock
        || searchOpen
        || isEditableKeyboardTarget(e.target)
        || isOverlayKeyboardTarget(e.target)
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
      setSidebarKeyboardNavigationFocus((current) => ({
        rowKey: targetRowKey,
        sequence: (current?.sequence ?? 0) + 1,
      }));
      navigate(targetPath);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentTag, orderedTags, navigate, searchOpen, selectedBlock]);


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
        console.error("Failed to create channel:", err);
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

      try {
        const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
        const items = newOrder.map((tag, i) => ({ tag, position: i }));
        await reorderChannels(items);
      } catch (err) {
        console.error("Failed to reorder channels:", err);
      }
      await reloadAllSnapshots();
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
        return;
      }
      if (id.startsWith("tag:")) {
        setActiveDragTag(id.slice(4));
        setActiveDragBlocks([]);
        setActiveDragMediaAsset(null);
        setActiveDragTextSelection(null);
      } else {
        if (data?.type === "block") {
          data.clearSelectionOnDragStart?.();
        }
        setActiveDragBlocks(resolveBlockDragBlocks(id, data, blocks));
        setActiveDragTag(null);
        setActiveDragMediaAsset(null);
        setActiveDragTextSelection(null);
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
      console.log("[DELETE] start", slug, "currentTag:", currentTag, "selectedBlock:", selectedBlock?.slug);
      setSelectedBlock(null);
      setSelectedBlockAnchor(null);
      console.log("[DELETE] cleared selectedBlock");
      try {
        console.log("[DELETE] calling deleteBlock IPC...");
        await deleteBlock(slug, deleteUnusedMedia);
        console.log("[DELETE] deleteBlock IPC done");
      } catch (err) {
        console.error("[DELETE] deleteBlock FAILED:", err);
      }
      console.log("[DELETE] calling reloadAllSnapshots...");
      await reloadAllSnapshots();
      console.log("[DELETE] reloadAllSnapshots done, blocks:", blocks.length, "tags:", tags.length);
    },
    [reloadAllSnapshots, currentTag, selectedBlock, blocks.length, tags.length],
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
          className="flex h-8 shrink-0 items-center border-b border-border"
        >
          <div data-tauri-drag-region className="w-20 shrink-0" />
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
        className="flex h-8 shrink-0 items-center border-b border-border"
      >
        {/* Traffic light spacer (macOS) */}
        <div data-tauri-drag-region className="w-20 shrink-0" />
        {/* Toolbar content area */}
        <div data-tauri-drag-region className="flex flex-1 items-center px-3" />
      </header>

      {/* Body: sidebar + main */}
      <div className="flex min-h-0 flex-1">
      <Sidebar
        width={sidebarWidth}
        collapsed={sidebarCollapsed}
        isResizing={sidebarResizing}
        vaultPath={vaultPath}
        thumbsRootPath={thumbsRootPath ?? undefined}
        tags={tags}
        currentTag={currentTag}
        orderedTags={orderedTags}
        channelPreviews={channelPreviews}
        totalBlocks={totalBlocks}
        isDropDragging={
          activeDragBlock !== null
          || activeDragMediaAsset !== null
          || activeDragTextSelection !== null
        }
        isCreatingChannel={isCreatingChannel}
        onSetCreatingChannel={handleSetCreatingChannel}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
        onCreateChannel={handleCreateChannel}
        onOpenBlock={openDetailBlock}
        onToggleTag={handleToggleTag}
        onCreateAndAssign={handleCreateTagFromMenu}
        onRequestRename={setRenamingBlock}
        onRequestDelete={requestDeleteBlock}
        onNavClick={handleDetailClose}
        onScrollToTop={handleScrollToTop}
        keyboardNavigationFocus={sidebarKeyboardNavigationFocus}
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
        detailChromeClosing={detailChromeClosing}
      />

      <SidebarResizeHandle
        isResizing={sidebarResizing}
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
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/96 px-8">
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
                tags={tags}
                currentTag={currentTag}
                scrollToTop={scrollToTopSignal}
                sidebarCollapsed={sidebarCollapsed}
                blockDragActive={activeDragBlocks.length > 0}
                detailOpen={Boolean(renderedDetailBlock)}
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
                onRequestRename={setRenamingBlock}
                onRequestDelete={requestDeleteBlock}
                onColumnCountChange={handleColumnCountChange}
                hasMoreBlocks={hasMoreBlocks}
                loadingMoreBlocks={loadingMoreBlocks}
                onLoadMoreBlocks={loadMoreBlocks}
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
              onClose={handleDetailClose}
              onNavigate={handleDetailNavigate}
              tags={tags}
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

      <Suspense fallback={null}>
        <Search
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onSelect={(block) => {
            openDetailBlock(block);
            setSearchOpen(false);
          }}
        />
      </Suspense>

      <Suspense fallback={null}>
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImportComplete={() => {
            void reloadAllSnapshots();
          }}
        />
      </Suspense>

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
    </div>{/* end body */}

      {/* Bottom action bar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-accent px-8">
        <VaultSwitcher
          currentPath={vaultPath}
          onVaultSelected={(path) => {
            navigate("/", { replace: true });
            onVaultSelected(path);
          }}
          hotkey="⌘⇧O"
        />
        <ActionButton hotkey="⌘⇧N" onClick={() => setIsCreatingChannel(true)}>
          New Channel
        </ActionButton>
        <ThemeMenuButton
          ref={themeMenuRef}
        />
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
        <ActionButton hotkey="⌘K" onClick={() => setSearchOpen(true)}>
          Search
        </ActionButton>
      </div>

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
      dropAnimation={null}
      modifiers={[snapToCursor]}
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
        <div className="pointer-events-none max-h-48 max-w-64 overflow-hidden rounded-1 border border-border bg-background shadow-lg">
          <img
            src={activeDragMediaAsset.src}
            alt=""
            className="max-h-48 max-w-64 object-contain"
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
        <div className="pointer-events-none rounded-1 bg-secondary px-3 py-1.5 text-base font-semibold shadow-lg">
          {collectionRefLabel(activeDragTag)}
        </div>
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
  tags: TagCount[];
  currentTag?: string;
  scrollToTop: number;
  sidebarCollapsed: boolean;
  blockDragActive: boolean;
  detailOpen: boolean;
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
  onRequestRename: (block: LightBlock | IndexedBlock) => void;
  onRequestDelete: (slug: string) => void;
  onColumnCountChange: (count: number) => void;
  hasMoreBlocks: boolean;
  loadingMoreBlocks: boolean;
  onLoadMoreBlocks: () => void;
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
  return <Grid {...ctx} blocks={ctx.blocks} />;
}

function ChannelPage() {
  const ctx = useRouteCtx();
  return <Grid {...ctx} blocks={ctx.blocks} />;
}
