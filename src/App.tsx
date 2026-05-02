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
  pointerWithin,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";

/** Convert a collection ref to a compact display title. */
function titleFromTag(tag: string): string {
  const parts = tag.split("/");
  const label = (parts[parts.length - 1] ?? tag).trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function baseRelatedNoteSlug(target: string): string {
  return target.split("#", 1)[0] ?? target;
}

function relatedNoteBlockAnchor(target: string): string | null {
  const fragment = target.split("#", 2)[1];
  if (!fragment?.startsWith("^")) return null;
  const blockId = fragment.slice(1).trim();
  return blockId || null;
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

import type { DeleteBlockPlan, IndexedBlock, LightBlock, TagCount, ChannelDto, GridSnapshot } from "@/types";
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
  extractInlineMedia,
  extractTextSelection,
  sweepVaultThumbnails,
} from "@/lib/commands";
import { ArticleAudioGatewayProvider } from "@/lib/articleAudioGateway";
import { desktopArticleAudioGateway } from "@/lib/articleAudioDesktopGateway";
import { findBlockElement } from "@/lib/domSelectors";
import {
  getStoredDetailTopMenuMode,
  storeDetailTopMenuMode,
  type DetailTopMenuMode,
} from "@/lib/appPreferences";
import { pushRecentTag } from "@/lib/recentTags";
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
import { VaultConflictsBanner } from "@/components/VaultConflictsBanner";
import { Grid } from "@/components/Grid";
import { DragCardPreview } from "@/components/Card";
import { ActionButton } from "@/components/ActionButton";
import { ThemeMenuButton, type ThemeMenuHandle } from "@/components/ThemeMenuButton";
import { RenameBlockDialog } from "@/components/RenameBlockDialog";
import { DeleteBlockDialog } from "@/components/DeleteBlockDialog";

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

type InlineMediaDragPayload = {
  type: "inline_media";
  sourceSlug: string;
  mediaRef: string;
  mediaKind: "image";
  imageSrc?: string;
};

type InlineMediaDragPreview = {
  src: string;
};

type TextSelectionDragPreview = {
  selectedText: string;
};

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

// ─── Visual grid navigation ────────────────────────────────────────────────

/** Find the nearest card in a given arrow direction based on screen coordinates. */
function findVisualNeighbor(
  currentSlug: string,
  direction: string,
): string | null {
  const current = findBlockElement(currentSlug);
  if (!current) return null;

  const rect = current.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  let bestSlug: string | null = null;
  let bestScore = Infinity;

  for (const card of document.querySelectorAll<HTMLElement>("[data-block-slug]")) {
    const slug = card.getAttribute("data-block-slug");
    if (slug === currentSlug) continue;

    const r = card.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - cx;
    const dy = (r.top + r.height / 2) - cy;

    // Must be in the correct direction (10px dead zone)
    const valid =
      direction === "ArrowRight" ? dx > 10 :
      direction === "ArrowLeft"  ? dx < -10 :
      direction === "ArrowDown"  ? dy > 10 :
      /* ArrowUp */                dy < -10;

    if (!valid) continue;

    // Primary axis + 3× cross axis — prefers cards in the same "lane"
    const score = horizontal
      ? Math.abs(dx) + Math.abs(dy) * 3
      : Math.abs(dy) + Math.abs(dx) * 3;

    if (score < bestScore) {
      bestScore = score;
      bestSlug = slug!;
    }
  }

  return bestSlug;
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
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [renamingBlock, setRenamingBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [selectedBlockAnchor, setSelectedBlockAnchor] = useState<string | null>(null);
  const [selectedBlockTags, setSelectedBlockTags] = useState<string[]>([]);
  const [deleteTargetSlug, setDeleteTargetSlug] = useState<string | null>(null);
  const [deletePlan, setDeletePlan] = useState<DeleteBlockPlan | null>(null);
  const [deletePlanError, setDeletePlanError] = useState<string | null>(null);
  const [detailTopMenuMode, setDetailTopMenuMode] = useState<DetailTopMenuMode>(
    getStoredDetailTopMenuMode,
  );
  const [detailChromeClosing, setDetailChromeClosing] = useState(false);
  const [closingDetailBlock, setClosingDetailBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [closingDetailTags, setClosingDetailTags] = useState<string[]>([]);
  const [focusedBlockId, setFocusedBlockId] = useState<number | null>(null);
  const [scrollToTopSignal, setScrollToTopSignal] = useState(0);
  const [activeDragBlock, setActiveDragBlock] = useState<LightBlock | null>(null);
  const [activeDragTag, setActiveDragTag] = useState<string | null>(null);
  const [activeDragInlineMedia, setActiveDragInlineMedia] = useState<InlineMediaDragPreview | null>(null);
  const [activeDragTextSelection, setActiveDragTextSelection] = useState<TextSelectionDragPreview | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const themeMenuRef = useRef<ThemeMenuHandle>(null);
  const gridColumnCountRef = useRef(1);
  const suppressRedirectRef = useRef(false);
  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;
  const currentTagRef = useRef(currentTag);
  currentTagRef.current = currentTag;
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

  const openDetailBlock = useCallback((
    block: LightBlock | IndexedBlock,
    anchor: string | null = null,
  ) => {
    cancelPendingDetailClose();
    setFocusedBlockId(null);
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

  const handleColumnCountChange = useCallback((n: number) => {
    gridColumnCountRef.current = n;
  }, []);

  // Close Detail and clear grid focus when navigating to a different route
  useEffect(() => {
    cancelPendingDetailClose();
    setSelectedBlock(null);
    setSelectedBlockAnchor(null);
    setFocusedBlockId(null);
  }, [location.pathname, cancelPendingDetailClose]);

  // ── Grid keyboard navigation (when Detail is closed) ───────────────────
  // Refs avoid re-subscribing the keydown listener on every focus change
  const focusedRef = useRef(focusedBlockId);
  focusedRef.current = focusedBlockId;
  const activeBlocksRef = useRef(activeBlocks);
  activeBlocksRef.current = activeBlocks;

  useEffect(() => {
    if (selectedBlock || searchOpen) return; // Detail or search handles keys

    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;

      const cur = focusedRef.current;
      const ab = activeBlocksRef.current;

      if (e.key === "Enter" && cur !== null) {
        const block = ab.find((b) => b.id === cur);
        if (block) {
          openDetailBlock(block);
        }
        return;
      }

      if (e.key === "Escape") {
        if (cur !== null) setFocusedBlockId(null);
        return;
      }

      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();

      if (cur === null) {
        if (ab.length > 0) setFocusedBlockId(ab[0]!.id);
        return;
      }

      // Visual navigation: find nearest card by screen coordinates
      const currentBlock = ab.find((b) => b.id === cur);
      if (!currentBlock) { setFocusedBlockId(ab[0]?.id ?? null); return; }

      const targetSlug = findVisualNeighbor(currentBlock.slug, e.key);
      if (!targetSlug) return;

      const targetBlock = ab.find((b) => b.slug === targetSlug);
      if (targetBlock) {
        setFocusedBlockId(targetBlock.id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedBlock, searchOpen, openDetailBlock]);

  // Auto-scroll to focused card
  useEffect(() => {
    if (focusedBlockId === null) return;
    const block = activeBlocks.find((b) => b.id === focusedBlockId);
    if (!block) return;
    requestAnimationFrame(() => {
      const el = findBlockElement(block.slug);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [focusedBlockId, activeBlocks]);

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
    const tagAtStart = currentTag;
    setLoadingMoreBlocks(true);
    try {
      const grid = await listGridBlocks(currentTag, blocks.length, GRID_PAGE_SIZE);
      if (vaultPathRef.current !== pathAtStart || currentTag !== tagAtStart) {
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
      console.error("[LOAD_MORE] FAILED:", msg, err);
      setLoadError(msg);
    } finally {
      if (vaultPathRef.current === pathAtStart && currentTag === tagAtStart) {
        setLoadingMoreBlocks(false);
      }
    }
  }, [blocks.length, currentTag, hasMoreBlocks, loadingMoreBlocks, routeKeyFor]);

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
      lastRevalidatedRouteKeyRef.current = routeKeyFor(initialTag);
      initialRouteLoadDoneRef.current = true;
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
  }, [handleSwitchVault]);

  // ── Block navigation ──────────────────────────────────────────────────────

  const handleBlockClick = useCallback((block: LightBlock) => {
    openDetailBlock(block);
  }, [openDetailBlock]);

  const handleDetailClose = useCallback(() => {
    if (!selectedBlock || detailChromeClosing) return;
    setFocusedBlockId(selectedBlock.id);
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
  }, [selectedBlock, selectedBlockTags, detailChromeClosing, cancelPendingDetailClose]);

  const handleScrollToTop = useCallback(() => {
    if (selectedBlock) {
      if (detailChromeClosing) return;
      setFocusedBlockId(selectedBlock.id);
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

  const handleDetailTopMenuModeChange = useCallback((mode: DetailTopMenuMode) => {
    setDetailTopMenuMode(mode);
    storeDetailTopMenuMode(mode);
  }, []);

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
        || a.title.localeCompare(b.title)
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
      e.preventDefault();
      const idx = currentTag
        ? orderedTags.findIndex((t) => t.tag === currentTag)
        : -1;
      if (e.key === "ArrowUp") {
        if (idx === 0) navigate("/");
        else if (idx > 0) navigate(`/channel/${encodeURIComponent(orderedTags[idx - 1]!.tag)}`);
      } else {
        if (idx === -1 && orderedTags.length > 0) {
          navigate(`/channel/${encodeURIComponent(orderedTags[0]!.tag)}`);
        } else if (idx >= 0 && idx < orderedTags.length - 1) {
          navigate(`/channel/${encodeURIComponent(orderedTags[idx + 1]!.tag)}`);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentTag, orderedTags, navigate]);


  // ── Channel management ─────────────────────────────────────────────────

  const handleCreateChannel = useCallback(
    async (tag: string) => {
      try {
        await createChannel(tag);
      } catch (err) {
        console.error("Failed to create channel:", err);
      }
      await reloadAllSnapshots();
    },
    [reloadAllSnapshots],
  );

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
        await addTag(slug, tag);
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
      } catch (err) {
        console.error("Failed to add tag:", err);
      }
      await reloadAllSnapshots();
    },
    [reloadAllSnapshots, selectedBlock?.slug],
  );

  const handleInlineMediaDrop = useCallback(
    async (payload: InlineMediaDragPayload, tag: string) => {
      try {
        const block = await extractInlineMedia({
          source_slug: payload.sourceSlug,
          media_ref: payload.mediaRef,
          target_tag: tag,
        });
        invalidateRoutesForTags(block.tags);
        scheduleRefresh({
          grid: currentTagRef.current === undefined || block.tags.includes(currentTagRef.current),
          taxonomy: true,
          previews: true,
        }, 0, { force: true });
      } catch (err) {
        console.error("Failed to extract inline media:", err);
      }
    },
    [invalidateRoutesForTags, scheduleRefresh],
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
      } & Partial<InlineMediaDragPayload> & Partial<MineTextSelectionDragPayload>) | undefined;
      if (data?.type === "inline_media") {
        setActiveDragInlineMedia({
          src: data.imageSrc ?? "",
        });
        setActiveDragBlock(null);
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
        setActiveDragBlock(null);
        setActiveDragTag(null);
        setActiveDragInlineMedia(null);
        return;
      }
      if (id.startsWith("tag:")) {
        setActiveDragTag(id.slice(4));
        setActiveDragBlock(null);
        setActiveDragInlineMedia(null);
        setActiveDragTextSelection(null);
      } else {
        const slug = data?.type === "block" && data.slug
          ? data.slug
          : id.startsWith("detail:")
            ? id.slice("detail:".length)
            : id;
        const block = data?.type === "block" && data.block
          ? data.block
          : blocks.find((b) => b.slug === slug);
        if (block) setActiveDragBlock(block);
        setActiveDragTag(null);
        setActiveDragInlineMedia(null);
        setActiveDragTextSelection(null);
      }
    },
    [blocks],
  );

  const handleDndEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragBlock(null);
      setActiveDragTag(null);
      setActiveDragInlineMedia(null);
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
      } & Partial<InlineMediaDragPayload> & Partial<MineTextSelectionDragPayload>) | undefined;
      if (activeData?.type === "inline_media") {
        if (overId.startsWith("tag:")) {
          void handleInlineMediaDrop(activeData as InlineMediaDragPayload, overId.slice(4));
        }
        return;
      }
      const textSelectionPayload = activeData?.type === "text_selection"
        ? activeData as MineTextSelectionDragPayload
        : activeId.startsWith("text-selection:")
          ? getActiveMineTextSelectionDragPayload()
          : null;
      if (textSelectionPayload) {
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

      // Tag reorder in sidebar
      if (activeIsTag && overId.startsWith("tag:")) {
        handleReorderTag(activeId.slice(4), overId.slice(4));
        return;
      }

      // Card dropped on tag
      if (!activeIsTag && overId.startsWith("tag:")) {
        handleCardDrop(activeSlug, overId.slice(4));
      }
    },
    [handleCardDrop, handleInlineMediaDrop, handleReorderTag, handleTextSelectionDrop],
  );

  const handleDndCancel = useCallback(() => {
    setActiveDragBlock(null);
    setActiveDragTag(null);
    setActiveDragInlineMedia(null);
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
      setFocusedBlockId(null);
      console.log("[DELETE] cleared selectedBlock/focusedBlockId");
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
      collisionDetection={pointerWithin}
      autoScroll={{ canScroll: (el) => el.hasAttribute("data-sidebar-scroll") }}
      onDragStart={handleDndStart}
      onDragEnd={handleDndEnd}
      onDragCancel={handleDndCancel}
    >
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
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
        orderedTags={orderedTags}
        channelPreviews={channelPreviews}
        totalBlocks={totalBlocks}
        isDropDragging={
          activeDragBlock !== null
          || activeDragInlineMedia !== null
          || activeDragTextSelection !== null
        }
        isCreatingChannel={isCreatingChannel}
        onSetCreatingChannel={setIsCreatingChannel}
        onDeleteTag={handleDeleteTagFromAll}
        onRenameTag={handleRenameTag}
        onCreateChannel={handleCreateChannel}
        onNavClick={handleDetailClose}
        onScrollToTop={handleScrollToTop}
        headerSlot={<VaultConflictsBanner vaultReady={vaultReady} />}
        linkedBlockSlug={renderedLinkedBlockSlug}
        linkedTags={renderedLinkedTags}
        onToggleLinkedTag={handleToggleTag}
        detailTopMenuMode={detailTopMenuMode}
        detailChromeClosing={detailChromeClosing}
      />

      <SidebarResizeHandle
        isResizing={sidebarResizing}
        disabled={
          activeDragBlock !== null
          || activeDragInlineMedia !== null
          || activeDragTag !== null
          || activeDragTextSelection !== null
        }
        onResizeStart={startResize}
        onResizeUpdate={updateResize}
        onResizeEnd={endResize}
        onToggleCollapsed={toggleCollapsed}
      />

      <main ref={mainRef} className="relative isolate flex-1 overflow-hidden">
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
                focusedBlockId={focusedBlockId}
                onBlockClick={handleBlockClick}
                onToggleTag={handleToggleTag}
                onCreateAndAssign={handleCreateTagFromMenu}
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
              detailTopMenuMode={detailTopMenuMode}
              tags={tags}
              currentTag={currentTag}
              onToggleTag={handleToggleTag}
              onCreateAndAssign={handleCreateTagFromMenu}
              onRequestRename={setRenamingBlock}
              onRequestDelete={requestDeleteBlock}
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
          detailTopMenuMode={detailTopMenuMode}
          onDetailTopMenuModeChange={handleDetailTopMenuModeChange}
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
    </div>{/* end flex-col */}

    <DragOverlay dropAnimation={null} modifiers={[snapToCursor]}>
      {activeDragBlock && (
        <DragCardPreview
          block={activeDragBlock}
          vaultPath={vaultPath}
          thumbsRootPath={thumbsRootPath ?? undefined}
        />
      )}
      {activeDragInlineMedia && activeDragInlineMedia.src && (
        <div className="pointer-events-none max-h-48 max-w-64 overflow-hidden rounded-1 border border-border bg-background shadow-lg">
          <img
            src={activeDragInlineMedia.src}
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
          {titleFromTag(activeDragTag)}
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
  focusedBlockId: number | null;
  onBlockClick: (block: LightBlock) => void;
  onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  onCreateAndAssign: (tag: string, blockSlug: string) => void;
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
