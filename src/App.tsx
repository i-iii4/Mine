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
import { Plus, X } from "lucide-react";
import { AppSettingsMenu } from "@/components/AppSettingsMenu";
import { ActivityIndicators } from "@/components/ActivityIndicators";
import { Button } from "@/components/ui/button";
import { ChromeRow, ChromeShell } from "@/components/ChromeRow";
import type { SettingsSection } from "@/lib/settingsSections";
import { isTauri } from "@tauri-apps/api/core";
import { listenPage } from "@/lib/pageEvents";
import { getNavigationLabel } from "@/lib/displayTitle";
import { applyChromeRowHeight, CHROME_ROWS_EVENT } from "@/lib/chromeHeight";
import {
  SPACE_LEAD_CHANGED_EVENT,
  TAB_GO_EVERYTHING_EVENT,
  TAB_HISTORY_GO_EVENT,
  TAB_REFRESH_REQUESTED_EVENT,
  TAB_SPACE_FORGOTTEN_EVENT,
  WINDOW_SIDEBAR_CHANGED_EVENT,
  afterTwoFrames,
  createTabViewReporter,
  tabLocationOf,
  tabLocationPath,
  takeLegacyTabState,
  type TabViewReporter,
} from "@/lib/tabPage";
import {
  TAB_VISIBILITY_CHANGED_EVENT,
  pauseTabMedia,
  setTabVisible,
} from "@/lib/tabVisibility";
import {
  EMPTY_PLACE_HISTORY,
  historyDirections,
  recordPlace,
  samePlace,
  settlePlace,
  stepPlace,
  type Place,
  type PlaceHistory,
} from "@/lib/placeHistory";
// The tab bar's own reading of ⌃Tab and ⌃⇧Tab from the command registry:
// both pages of a window answer them the same way (SPEC_TABS.md, В57).
import { adjacentTabDirection } from "@/lib/adjacentTab";
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
  tagRowDropAnimation,
  TAG_ROW_OVERLAY_MODIFIERS,
} from "@/lib/tagRowDragOverlay";
import { arrayMove } from "@dnd-kit/sortable";
import { applyPendingTagOrder } from "@/lib/collectionOrder";
import { collectionRefLabel } from "@/lib/collections";
import { reconcileBlocks } from "@/lib/blockIdentity";
import { refreshPageLimit } from "@/lib/gridPaging";
import { createPreviewRowQueue } from "@/lib/previewRowQueue";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX, SIDEBAR_PREVIEW_SLOTS } from "@/lib/appLayout";
import { cn } from "@/lib/utils";
import { commandById } from "@/lib/commandRegistry";
import { EDGE_FADE_WIDTH, createRightFadeMaskStyle } from "@/lib/edgeFade";
import { createParamsForClipboardPayload } from "@/lib/pasteImport";
import { BAR_HIDE_PRIORITIES } from "@/lib/bottomBarOverflow";
import {
  isDetailShortcutBlockedTarget,
  isEditableKeyboardTarget,
  isOverlayKeyboardTarget,
} from "@/lib/keyboardTargets";
import {
  buildSidebarSearchNavigationRows,
  filterSidebarTags,
  sidebarRowDomId,
  sidebarRowKeyToRoute,
} from "@/lib/sidebarSearch";
import { SEARCH_INPUT_SUPPRESSION_PROPS } from "@/lib/searchInputSuppression";
import { useSidebarRowFit } from "@/hooks/useSidebarRowFit";
import {
  BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY,
  getStoredBottomActionBarHidden,
} from "@/lib/bottomActionBarVisibility";
import {
  SCROLL_EDGE_FADE_STORAGE_KEY,
  getStoredScrollEdgeFade,
} from "@/lib/scrollEdgeFade";
import { DENSITY_STORAGE_KEY, applyDensity, getStoredDensity } from "@/lib/density";
import { getFeedDisplay, useFeedDisplay } from "@/lib/feedDisplay";
import {
  CONTENT_FONT_STORAGE_KEY,
  INTERFACE_FONT_STORAGE_KEY,
  applyContentFont,
  applyInterfaceFont,
  getStoredContentFont,
  getStoredInterfaceFont,
} from "@/lib/fontChoice";
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
  CompactDetailTopMenu,
  MainSecondaryTopBar,
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

/// Keys come from the command registry, the user's rebinding included: a
/// rebound command no longer answers its old chord (SPEC_AUDIT_FIXES.md, Ф11).
function commandPressed(id: string, e: KeyboardEvent): boolean {
  return commandById(id).matches?.(e) ?? false;
}

function historyDirectionForShortcut(e: KeyboardEvent): -1 | 1 | null {
  if (commandPressed("history-back", e)) return -1;
  if (commandPressed("history-forward", e)) return 1;
  return null;
}

/// How long a preview for a card the feed has not loaded yet is remembered:
/// long enough to cover a feed read in flight, short enough that cards paged
/// in much later, read after their preview, are not read twice.
const UNSEEN_PREVIEW_WINDOW_MS = 10_000;
const UNSEEN_PREVIEW_LIMIT = 500;

function rememberUnseenPreview(unseen: Map<string, number>, slug: string, now: number) {
  unseen.delete(slug);
  unseen.set(slug, now);
  // A cold-start sweep reports previews for cards far off screen: keep the
  // newest few hundred, the only ones a read in flight can bring.
  while (unseen.size > UNSEEN_PREVIEW_LIMIT) {
    const oldest = unseen.keys().next().value;
    if (oldest === undefined) break;
    unseen.delete(oldest);
  }
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
  // The feed's order, as chosen in the Display panel (SPEC_FEED_DISPLAY.md, Д8).
  order: FeedOrder = getFeedDisplay().sort,
) {
  return listGridBlocks(tag, offset, limit, order);
}

import type {
  UnavailableVault,
  UnavailableVaultReason,
  DeleteBlockPlan,
  FeedOrder,
  IndexedBlock,
  LightBlock,
  MainViewMode,
  TagCount,
  ChannelDto,
  GridSnapshot,
  MediaAssetRef,
  ProjectionRevision,
  ScrollAnchor,
  SidebarLayout,
  SpaceLead,
  SpaceMovedPayload,
  SpaceRename,
  TabBootstrap,
  TabHistoryStep,
  ChromeRows,
  TabView,
  TabVisibility,
  VaultChangedPayload,
  VaultStats,
} from "@/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  getVaultPath,
  getUnavailableVault,
  firstCardMarkerPending,
  completeFirstCardMarker,
  spaceOnboardingPending,
  openVault,
  selectVault,
  startVaultSync,
  recordStartupMilestone,
  type StartupMilestone,
  startStartupMaintenance,
  getVaultStats,
  listGridBlocks,
  getGridRows,
  listTaxonomySnapshot,
  createChannel,
  deleteChannel,
  reorderChannels,
  renameChannel,
  checkCollectionName,
  renameBlockFile,
  checkBlockRename,
  prepareDeleteBlock,
  deleteTagFromAll,
  addTag,
  removeTag,
  deleteBlock,
  deleteBlocks,
  mergeBlocks,
  getBlock,
  createMediaAssetCard,
  renameMediaAsset,
  deleteMediaAsset,
  deleteSourceVideo,
  removeMediaAssetFromCard,
  extractTextSelection,
  deleteTextSelection,
  sweepVaultThumbnails,
  openSettingsWindow,
  clipperExtensionFolder,
  createBlock,
  readClipboardPayload,
  getTabBootstrap,
  activateAdjacentTab,
  openPlace,
  reportTabHistory,
  reportTabView,
  tabPainted,
  setWindowSidebar,
  dismissSpaceNotice,
  spaceNoticeDismissed,
  newTab,
} from "@/lib/commands";
import { ArticleAudioGatewayProvider } from "@/lib/articleAudioGateway";
import { scheduleAfterNextPaint, whenCardsRendered } from "@/lib/startup";
import { desktopArticleAudioGateway } from "@/lib/articleAudioDesktopGateway";
import { ARTICLE_AUDIO_ENABLED } from "@/lib/featureFlags";
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
import { useStaleDragRecovery } from "@/hooks/useStaleDragRecovery";
import { useProjectionRevisionOwner } from "@/hooks/useProjectionRevisionOwner";
import { useCommandOverrides } from "@/hooks/useCommandOverrides";
import { VaultPicker } from "@/components/VaultPicker";
import { SpaceUnavailable } from "@/components/SpaceUnavailable";
import { CloudRecommendation } from "@/components/CloudRecommendation";
import { FirstCardMarkerCard } from "@/components/FirstCardMarker";
import { NotificationAnchor, NotificationCard } from "@/components/NotificationCard";
import {
  IndexingProgress,
  openingStep,
  useIndexingNotice,
  type IndexingCount,
} from "@/components/IndexingProgress";
import { PreviewsPendingContext } from "@/lib/cardPreviewState";
import { VaultSwitcher } from "@/components/VaultSwitcher";
import { TopCollectionSwitcher } from "@/components/TopCollectionSwitcher";
import { Sidebar, SidebarTagRowDragPreview } from "@/components/Sidebar";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { VaultConflictsBanner } from "@/components/VaultConflictsBanner";
import { Grid } from "@/components/Grid";
import { GraphView } from "@/components/GraphView";
import { DragCardStackPreview } from "@/components/Card";
import { ActionButton } from "@/components/ActionButton";
import { applyTheme, getStoredTheme, THEME_STORAGE_KEY } from "@/lib/themeMode";
import { flipWindowButtonStyleHere } from "@/lib/buttonStyle";
import { ButtonStyleNotice } from "@/components/ButtonStyleNotice";
import {
  applyDesign,
  getStoredDesignMode,
  useDesignMode,
  DESIGN_STORAGE_KEY,
} from "@/lib/designMode";
import {
  getStoredGraphPreferences,
  GRAPH_PREFERENCES_STORAGE_KEY,
  type GraphPreferences,
} from "@/lib/graphPreferences";
import {
  SETTINGS_CHANGED_EVENT,
  adoptSettingsChange,
  type SettingsChangedPayload,
} from "@/lib/settingsChanged";
import { RenameBlockDialog } from "@/components/RenameBlockDialog";
import { SearchOverlay } from "@/components/SearchOverlay";
import { CreateCollectionDialog } from "@/components/CreateCollectionDialog";
import { DeleteBlockDialog } from "@/components/DeleteBlockDialog";
import {
  ImagePreviewOverlay,
  type ImagePreviewRequest,
} from "@/components/ImagePreviewOverlay";
import { copyTextToClipboard } from "@/lib/clipboard";
import { setCollectionMemberships } from "@/lib/collectionHover";

const Detail = lazy(async () => {
  const mod = await import("@/components/Detail");
  return { default: mod.Detail };
});


const DropZone = lazy(async () => {
  const mod = await import("@/components/DropZone");
  return { default: mod.DropZone };
});


const GRID_PAGE_SIZE = 200;
/// Delays before each automatic read after a failed feed read: the route's
/// re-read and the next page each spend their own run of them. The number of
/// entries bounds the retries: a store that keeps failing leaves its error on
/// screen instead of being polled forever (SPEC_AUDIT_FIXES.md, Г4.1, Д1.4).
const FEED_READ_RETRY_DELAYS_MS = [1_000, 4_000, 15_000] as const;
const DETAIL_SECONDARY_CHROME_EXIT_MS = 190;
const DETAIL_COMPACT_CHROME_EXIT_MS = 260;
/// How many further feed pages a restored tab reads to find the card it was
/// scrolled to before it starts at the top instead (SPEC_TABS.md, В40):
/// GRID_PAGE_SIZE cards each.
const SCROLL_RESTORE_PAGE_LIMIT = 25;
/// The space notice for the opening's progress (О13), as the backend names
/// it when it remembers the notice closed (SPEC_TABS.md, В20).
const INDEXING_SPACE_NOTICE = "indexing";

/// `vault-changed`. A command's news names what it renamed (SPEC_TABS.md,
/// В17); the watcher's names nothing, and a preview pass's carries
/// `preview_only` and no renames at all.
type VaultChangedEvent = Omit<VaultChangedPayload, "renames"> & {
  renames?: SpaceRename[];
  preview_only?: boolean;
};

interface VaultSyncStartedEvent {
  path: string;
}

interface VaultSyncProgressEvent {
  path: string;
  processed: number;
  total: number;
}

interface VaultSyncFinishedEvent {
  path: string;
  indexed: number;
  errors: number;
  error: string | null;
}

/** A full preview pass waits or runs for the space. */
interface DerivedPreviewQueuedEvent {
  path: string;
}

/** How far the running full preview pass has come (О13). */
interface DerivedPreviewProgressEvent {
  path: string;
  processed: number;
  total: number;
}

/** No full preview pass waits or runs for the space any more. */
interface DerivedPreviewFinishedEvent {
  path: string;
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
  path?: string;
  slug: string;
  is_text: boolean;
}

// ─── Root ──────────────────────────────────────────────────────────────────

/// The collection filter dissolves its overflow at the panel's right edge, the
/// same way sidebar row names do, instead of cutting a letter in half.
const SIDEBAR_SEARCH_MASK_STYLE = createRightFadeMaskStyle(EDGE_FADE_WIDTH, 0);

/// Whether a source's error notice is open over the feed, and how the reader
/// closes it. Closing hides that error and does not clear it: the source still
/// owns it. A different error, or the same one after it cleared, opens again.
function useErrorNotice(error: string | null): { open: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Adjusted while rendering, before the stale value can show: an error that
  // cleared forgets that it was closed.
  if (error === null && dismissed !== null) setDismissed(null);
  const dismiss = useCallback(() => setDismissed(error), [error]);
  return { open: error !== null && error !== dismissed, dismiss };
}

/// What a restored tab returns to in its space (SPEC_TABS.md, В40, В78):
/// `view` is applied once the space at `path` opens, and `saved` is what the
/// backend holds, so a view that differs from it is reported. A `null` path
/// is the first space a tab opens from the space picker: the mode stored
/// before tabs waits for it there (В79).
interface TabRestore {
  path: string | null;
  view: TabView;
  saved: TabView;
}


/// What this page needs from the backend as a tab: none for a page that is
/// not a tab (a dev browser route), which then behaves as before tabs.
async function readTabBootstrap(): Promise<TabBootstrap | null> {
  if (!isTauri()) return null;
  try {
    return await getTabBootstrap();
  } catch (error) {
    console.error("[startup] getTabBootstrap:failed", error);
    return null;
  }
}

/// The one-time move of the main view and the sidebar out of localStorage
/// (В79). Only a launch that read no saved windows takes them: the stored
/// mode becomes this tab's and the stored sidebar its window's. The keys go
/// in any case.
function adoptLegacyTabState(bootstrap: TabBootstrap): { view: TabView; sidebar: SidebarLayout } {
  const legacy = takeLegacyTabState();
  if (!bootstrap.fresh_start) return { view: bootstrap.view, sidebar: bootstrap.sidebar };
  const view = legacy.mode !== null ? { ...bootstrap.view, mode: legacy.mode } : bootstrap.view;
  if (legacy.sidebar === null) return { view, sidebar: bootstrap.sidebar };
  void setWindowSidebar(legacy.sidebar).catch((error: unknown) => {
    console.error("Could not move the stored sidebar to the window:", error);
  });
  return { view, sidebar: legacy.sidebar };
}

export function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [unavailablePath, setUnavailablePath] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<UnavailableVaultReason>("missing");
  const [creatingNewSpace, setCreatingNewSpace] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectionReadSucceeded, setSelectionReadSucceeded] = useState(false);
  // This page as a tab (SPEC_TABS.md); null for a page that is not one.
  const [tab, setTab] = useState<TabBootstrap | null>(null);
  const isTab = tab !== null;
  // Whether this tab leads its space: only the lead does the space's page
  // work and shows its notices (В19). A page that is not a tab always does.
  const [lead, setLead] = useState(true);
  // The sidebar belongs to the window (В56): the bootstrap's, then every
  // `window-sidebar-changed`.
  const [windowSidebar, setWindowSidebarLayout] = useState<SidebarLayout | null>(null);
  const [tabRestore, setTabRestore] = useState<TabRestore | null>(null);
  // The first screen of this page is on the page: the backend waits for its
  // frame before it shows the tab (В5).
  const [firstScreenShown, setFirstScreenShown] = useState(false);
  const handleFirstScreen = useCallback(() => setFirstScreenShown(true), []);

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    console.info("[startup] getVaultPath:start");
    const bootstrapRead = readTabBootstrap();
    // The tab's bootstrap holds whether or not its space could be read.
    let bootstrapAdopted = false;
    const adoptBootstrap = async (path: string | null) => {
      const bootstrap = await bootstrapRead;
      if (cancelled || bootstrapAdopted || !bootstrap) return;
      bootstrapAdopted = true;
      // The tab bar above is as tall as the backend laid it out (В83).
      applyChromeRowHeight(bootstrap.chrome_rows.page);
      const adopted = adoptLegacyTabState(bootstrap);
      setTab(bootstrap);
      setLead(bootstrap.lead);
      setWindowSidebarLayout(adopted.sidebar);
      if (path) setTabRestore({ path, view: adopted.view, saved: bootstrap.view });
      else if (adopted.view !== bootstrap.view) setTabRestore({ path: null, view: adopted.view, saved: bootstrap.view });
    };
    getVaultPath()
      .then(async (path) => {
        console.info("[startup] getVaultPath:done", {
          path,
          elapsedMs: Math.round(performance.now() - started),
        });
        await adoptBootstrap(path);
        if (cancelled) return;
        setVaultPath(path);
        // No path may mean two very different things: nothing was ever chosen,
        // or the chosen folder is unreachable at the moment. Only the second
        // deserves an explanation instead of a first-run screen.
        if (!path) {
          const unavailable = await getUnavailableVault();
          if (cancelled) return;
          setUnavailablePath(unavailable?.path ?? null);
          setUnavailableReason(unavailable?.reason ?? "missing");
        }
        setSelectionReadSucceeded(true);
      })
      .catch(async (err) => {
        console.error("[startup] getVaultPath:failed", err);
        await adoptBootstrap(null);
        if (!cancelled) setVaultPath(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // The legacy keys are taken once: a run cancelled before its answer
    // leaves them to the run that replaces it.
    return () => {
      cancelled = true;
    };
  }, []);

  // The first screen of a tab drew: the backend may show the tab now (В5).
  useEffect(() => {
    if (!isTab || !firstScreenShown) return;
    return afterTwoFrames(() => {
      void tabPainted().catch((error: unknown) => console.error("Could not report the tab's frame:", error));
    });
  }, [firstScreenShown, isTab]);

  // What the backend says about this tab: shown or hidden (В41), its lead
  // role (В19, В20), its window's sidebar (В56) and its space forgotten (В70).
  useEffect(() => {
    if (!isTab) return;
    let cancelPaint: (() => void) | null = null;
    const subscriptions = [
      listenPage<TabVisibility>(TAB_VISIBILITY_CHANGED_EVENT, (event) => {
        const { visible } = event.payload;
        setTabVisible(visible);
        cancelPaint?.();
        cancelPaint = null;
        if (visible) {
          // Shown again: the backend waits for a fresh frame before it hides
          // the tab this one replaces.
          cancelPaint = afterTwoFrames(() => {
            void tabPainted().catch((error: unknown) => console.error("Could not report the tab's frame:", error));
          });
        } else {
          // Nothing plays in a hidden tab, and nothing starts again on show.
          pauseTabMedia();
        }
      }),
      listenPage<SpaceLead>(SPACE_LEAD_CHANGED_EVENT, (event) => setLead(event.payload.lead)),
      listenPage<ChromeRows>(CHROME_ROWS_EVENT, (event) => applyChromeRowHeight(event.payload.page)),
      listenPage<SidebarLayout>(WINDOW_SIDEBAR_CHANGED_EVENT, (event) => setWindowSidebarLayout(event.payload)),
      listenPage(TAB_SPACE_FORGOTTEN_EVENT, () => {
        setCreatingNewSpace(false);
        setUnavailablePath(null);
        setTabRestore(null);
        setVaultPath(null);
      }),
    ];
    return () => {
      cancelPaint?.();
      for (const subscription of subscriptions) void subscription.then((stop) => stop());
    };
  }, [isTab]);

  // ⌃Tab and ⌃⇧Tab show the next and the previous tab of the window from any
  // screen of the page, fields and dialogs included (В55, В57). ⇧⌘] and ⇧⌘[
  // are items of the native menu, which takes them before the page.
  useEffect(() => {
    if (!isTab) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = adjacentTabDirection(event);
      if (direction === null) return;
      event.preventDefault();
      event.stopPropagation();
      void activateAdjacentTab(direction === "forward").catch((error: unknown) => {
        console.error("Could not show the adjacent tab:", error);
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isTab]);

  // A screen without a space is this page's first screen as soon as it shows.
  const showsSpace = !loading && vaultPath !== null;
  useEffect(() => {
    if (!loading && !showsSpace) setFirstScreenShown(true);
  }, [loading, showsSpace]);

  useEffect(() => {
    if (loading || vaultPath || !isTauri()) return;
    return scheduleAfterNextPaint(() => {
      void recordStartupMilestone("interactive").catch(() => {});
      if (selectionReadSucceeded) {
        void recordStartupMilestone("update_ready").catch(() => {});
      }
      void startStartupMaintenance().catch((error) => {
        console.warn("Startup maintenance could not begin:", error);
      });
    });
  }, [loading, vaultPath, selectionReadSucceeded]);

  // A space switch may originate in another window (settings). The backend
  // broadcasts every select_vault; key={vaultPath} below re-mounts the app.
  // Switches initiated here resolve to the same path — an idempotent set.
  useEffect(() => {
    let cancelled = false;
    const unlisten = listenPage<{ path: string }>("vault-selected", (event) => {
      if (cancelled) return;
      setVaultPath(event.payload.path);
    });
    // The space this tab shows moved and reopened at its new folder
    // (SPEC_VAULT_LIFECYCLE.md, П30; SPEC_TABS.md, В73).
    const unlistenMoved = listenPage<SpaceMovedPayload>("space-moved", (event) => {
      if (cancelled) return;
      setVaultPath(event.payload.path);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
      unlistenMoved.then((fn) => fn());
    };
  }, []);

  // The open space's folder disappeared while the app ran and could not be
  // found beside its old path: show the same screen as at startup
  // (SPEC_VAULT_LIFECYCLE.md, П15). A space found under a new name reopens
  // through "space-moved" above instead. The report names the lost space
  // and counts only while that space is the open one: a loss of A detected
  // after the switch to B leaves B on screen (SPEC_AUDIT_FIXES.md, В2.1).
  // Paths compare as spelled, like every space-scoped event here: the
  // backend reports the path the space was opened with.
  const vaultPathRef = useRef(vaultPath);
  vaultPathRef.current = vaultPath;
  useEffect(() => {
    let cancelled = false;
    const unlisten = listenPage<UnavailableVault>("space-unavailable", (event) => {
      if (cancelled || event.payload.path !== vaultPathRef.current) return;
      setUnavailablePath(event.payload.path);
      setUnavailableReason(event.payload.reason);
      setVaultPath(null);
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

  if (!vaultPath && unavailablePath && !creatingNewSpace) {
    return (
      <div className="h-screen w-screen">
        <SpaceUnavailable
          path={unavailablePath}
          reason={unavailableReason}
          onReopened={(path) => {
            setUnavailablePath(null);
            setVaultPath(path);
          }}
          onForgotten={() => setUnavailablePath(null)}
          onCreateNew={() => setCreatingNewSpace(true)}
        />
      </div>
    );
  }

  if (!vaultPath) {
    return (
      <VaultPicker
        onVaultSelected={(path) => {
          setCreatingNewSpace(false);
          setUnavailablePath(null);
          setVaultPath(path);
        }}
        onBack={unavailablePath && creatingNewSpace ? () => setCreatingNewSpace(false) : undefined}
      />
    );
  }

  const routedApp = (
    <BrowserRouter>
      <AppWithVault
        key={vaultPath}
        vaultPath={vaultPath}
        onVaultSelected={setVaultPath}
        tabPage={isTab}
        lead={lead}
        windowSidebar={windowSidebar}
        restore={tabRestore && (tabRestore.path === null || tabRestore.path === vaultPath) ? tabRestore : null}
        onRestored={() => setTabRestore(null)}
        onFirstScreen={handleFirstScreen}
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
  tabPage = false,
  lead = true,
  windowSidebar = null,
  restore = null,
  onRestored,
  onFirstScreen,
}: {
  vaultPath: string;
  onVaultSelected: (path: string) => void;
  /// This page is a tab: it reports its view and opens spaces in new tabs.
  tabPage?: boolean;
  /// This tab leads its space (SPEC_TABS.md, В19).
  lead?: boolean;
  /// The sidebar of this tab's window (В56); null for a page that is not a tab.
  windowSidebar?: SidebarLayout | null;
  /// What this tab returns to, read once when it mounts (В40).
  restore?: TabRestore | null;
  onRestored?: () => void;
  /// The first route of the space, or its failure, is on screen (В5).
  onFirstScreen?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const projectionRevisionOwner = useProjectionRevisionOwner();
  // The bar shows chords: a rebind in Settings re-renders them (Ф11).
  useCommandOverrides();

  const onFirstScreenRef = useRef(onFirstScreen);
  onFirstScreenRef.current = onFirstScreen;
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  // The first reads of the space landed: the feed, the collections, the stats.
  const [initialLoadsDone, setInitialLoadsDone] = useState(false);
  // The view this tab returns to, taken once: later renders hand none.
  const [restoreView] = useState<TabView | null>(() => restore?.view ?? null);
  // What the backend holds for this tab: known for a restored tab only.
  const savedViewRef = useRef<TabView | null>(restore?.saved ?? null);
  // The place is restored before the first route read, so the feed reads the
  // restored collection at once instead of Everything first. A collection
  // that no longer exists sends the tab to Everything once collections are
  // read (В18).
  // A passive effect: the router hears navigation only once its own layout
  // effect has subscribed, after this component's layout effects.
  const placeRestoredRef = useRef(false);
  useEffect(() => {
    if (placeRestoredRef.current) return;
    placeRestoredRef.current = true;
    if (restoreView?.location.kind === "collection") {
      navigate(tabLocationPath(restoreView.location), { replace: true });
    }
  }, [navigate, restoreView]);

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
  // The id of the latest route load whose answer is on screen. Paging continues
  // the list on screen, so it waits while a newer load is in flight: an offset
  // taken from the previous list (another order, a longer or shorter range)
  // skips or repeats a page (SPEC_FEED_DISPLAY.md, Д8; SPEC_AUDIT_FIXES.md,
  // В5.1). State rather than a ref: applying a load hands the feed a new
  // `loadMoreBlocks`, so a request refused while the load was in flight is
  // asked again against the new list.
  const [appliedRouteLoadId, setAppliedRouteLoadId] = useState(0);
  // The route and order of the list on screen: the next page continues that
  // list in that order (SPEC_AUDIT_FIXES.md, Г4.1).
  const shownListRef = useRef<{ routeKey: string; order: FeedOrder } | null>(null);
  // The pending automatic re-read after a failed route read, and how many of
  // the bounded retries the current failure has spent.
  const gridRetryTimerRef = useRef<number | null>(null);
  const gridRetryAttemptsRef = useRef(0);
  // The same for a failed next page. Kept apart from the route's: a page that
  // keeps failing neither restarts the route's retry nor spends its budget
  // (SPEC_AUDIT_FIXES.md, Д1.4).
  const pageRetryTimerRef = useRef<number | null>(null);
  const pageRetryAttemptsRef = useRef(0);
  // An index pass is over and the feed on screen was read before it: the id of
  // the last route load issued by then, or null. Only a later load reads what
  // the pass found; until one lands the feed counts as indexing, so an old
  // empty snapshot is neither marked as painted nor introduced as an empty
  // space (SPEC_AUDIT_FIXES.md, Б5.4, В5.6).
  const [indexRereadAfterLoadId, setIndexRereadAfterLoadId] = useState<number | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  // The space's collections were read at least once.
  const [taxonomyLoaded, setTaxonomyLoaded] = useState(false);
  const compactDetailTopMenuEnabled = false;
  const [bottomActionBarHidden, setBottomActionBarHidden] = useState(
    getStoredBottomActionBarHidden,
  );
  const [graphPreferences, setGraphPreferences] = useState(
    getStoredGraphPreferences,
  );
  const [scrollEdgeFade, setScrollEdgeFade] = useState(getStoredScrollEdgeFade);
  // Grid or Graph is the tab's own (SPEC_TABS.md, В78).
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>(() => restoreView?.mode ?? "grid");
  const [imagePreview, setImagePreview] = useState<ImagePreviewRequest | null>(null);
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [isNamingCollection, setIsNamingCollection] = useState(false);
  // Whether the active view holds a focus that Enter would open. The bottom bar
  // shows a command only while it can be used, and Focus has nothing to act on
  // until something is focused.
  // The action lives in a ref and only its presence is state. Holding the
  // function itself in state re-rendered the shell on every focus report, which
  // handed the view a fresh callback, which triggered the next report — a loop
  // that made stepping between collections stutter with both keys and mouse.
  const activateFocusedRef = useRef<(() => void) | null>(null);
  const [hasFocusedItem, setHasFocusedItem] = useState(false);
  const reportKeyboardFocus = useCallback((activate: (() => void) | null) => {
    activateFocusedRef.current = activate;
    setHasFocusedItem(activate !== null);
  }, []);
  // Reported separately from focus: the feed answers ⌘K only under keyboard
  // focus, while Enter also opens an element focused by pointer. The act
  // itself lives in a ref so a press on the bar's Command entry opens the
  // same menu the keystroke would — presence alone is state.
  const cardMenuActivateRef = useRef<(() => void) | null>(null);
  const [feedCardMenuAvailable, setFeedCardMenuAvailable] = useState(false);
  const reportCardMenuCommand = useCallback((activate: (() => void) | null) => {
    cardMenuActivateRef.current = activate;
    setFeedCardMenuAvailable(activate !== null);
  }, []);
  // Selection owns one bar command — clearing itself — and reports it the
  // same way.
  const selectionClearRef = useRef<(() => void) | null>(null);
  // The chrome row's slot the feed portals the selection commands into.
  const [selectionCommandsHost, setSelectionCommandsHost] =
    useState<HTMLDivElement | null>(null);
  // The top row the sidebar's line runs through: the resize handle lays its
  // catch there too.
  const [topRowHost, setTopRowHost] = useState<HTMLDivElement | null>(null);
  // The bar hides whole entries by decided priority when the window narrows.
  // Widths are cached from the last visible render, so a hidden entry keeps
  // its claim and returns the moment there is room again.
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const [hiddenBarEntries, setHiddenBarEntries] = useState<ReadonlySet<string>>(new Set());
  // Overflow is measured, not computed. An arithmetic guess at the free width
  // has to model padding, gaps, the spacer and every fixed child correctly, and
  // one wrong term leaves entries hanging off the edge of the window — which is
  // exactly what happened. `scrollWidth > clientWidth` asks the layout itself.
  const remeasureBottomBar = useCallback(() => {
    const bar = bottomBarRef.current;
    if (!bar) return;
    const slots = Array.from(
      bar.querySelectorAll<HTMLElement>("[data-bar-entry]"),
    );
    if (slots.length === 0) return;

    // Show everything first, so a window that grew gets its entries back.
    for (const slot of slots) slot.style.display = "";
    const byPriority = [...slots].sort((a, b) => (
      (BAR_HIDE_PRIORITIES[a.dataset.barEntry ?? ""] ?? Number.MAX_SAFE_INTEGER)
      - (BAR_HIDE_PRIORITIES[b.dataset.barEntry ?? ""] ?? Number.MAX_SAFE_INTEGER)
    ));
    const hidden = new Set<string>();
    for (const slot of byPriority) {
      if (bar.scrollWidth <= bar.clientWidth) break;
      const id = slot.dataset.barEntry;
      if (!id) continue;
      slot.style.display = "none";
      hidden.add(id);
    }

    setHiddenBarEntries((current) => {
      if (current.size === hidden.size && [...hidden].every((id) => current.has(id))) {
        return current;
      }
      return hidden;
    });
  }, []);
  useLayoutEffect(() => {
    const bar = bottomBarRef.current;
    if (!bar) return;
    remeasureBottomBar();
    const observer = new ResizeObserver(() => remeasureBottomBar());
    observer.observe(bar);
    return () => observer.disconnect();
  }, [remeasureBottomBar, bottomActionBarHidden]);
  // The set of entries changes with state (focus, selection, open element), so
  // the bar is measured again after every commit; the setter ignores a result
  // that did not change.
  useLayoutEffect(() => {
    remeasureBottomBar();
  });
  const [hasSelection, setHasSelection] = useState(false);
  const reportSelectionCommand = useCallback((clear: (() => void) | null) => {
    selectionClearRef.current = clear;
    setHasSelection(clear !== null);
  }, []);
  const [pendingCreateChannelDrop, setPendingCreateChannelDrop] =
    useState<PendingCreateChannelDrop | null>(null);
  const [renamingBlock, setRenamingBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<LightBlock | IndexedBlock | null>(null);
  const [cardActionsMenuTarget, setCardActionsMenuTarget] =
    useState<CardActionsMenuTarget | null>(null);
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
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  // Query survives the session: reopening shows it selected (SPEC_SEARCH_OVERLAY).
  const [searchOverlayQuery, setSearchOverlayQuery] = useState("");
  // The collection filter is the tab's own too (В78).
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState(() => restoreView?.collection_filter ?? "");
  const sidebarSearchHasValue = sidebarSearchQuery.length > 0;
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
  // Bumped when a sync pass lands: cloud waits may have just repeated, and the
  // Keep Downloaded card re-evaluates on it.
  const [cloudAdviceToken, setCloudAdviceToken] = useState(0);
  // The first index counted out loud (О13); null once the pass lands.
  const [syncProgress, setSyncProgress] = useState<IndexingCount | null>(null);
  // The full preview pass that follows the index, from the moment it is
  // queued until the backend says none is left; its count is null until the
  // pass has counted its cards.
  const [previewPass, setPreviewPass] = useState<{ count: IndexingCount | null } | null>(null);
  // Whether the previews of this space are still being prepared: a full
  // preview pass is queued or running.
  const previewsPending = previewPass !== null;
  // One opening, two phases in order, one notice (О13): notes while the index
  // pass counts, then previews. The notice's delay and hiding span both.
  const indexingStep = openingStep(
    isSyncing ? syncProgress : null,
    previewsPending,
    previewPass?.count ?? null,
  );
  const indexingCountNotice = useIndexingNotice(indexingStep !== null);
  // The space's notices belong to its lead tab (SPEC_TABS.md, В19, В20). A
  // notice closed there stays closed for the space's opening: the backend
  // remembers it, and a tab that starts leading asks.
  const { hide: hideIndexingNotice } = indexingCountNotice;
  const leadRef = useRef(lead);
  leadRef.current = lead;
  useEffect(() => {
    if (!tabPage || !lead) return;
    let cancelled = false;
    void spaceNoticeDismissed(INDEXING_SPACE_NOTICE)
      .then((dismissed) => {
        if (!cancelled && dismissed) hideIndexingNotice();
      })
      .catch((error: unknown) => console.error("Could not read the space's closed notices:", error));
    return () => {
      cancelled = true;
    };
  }, [hideIndexingNotice, lead, tabPage]);
  const closeIndexingNotice = useCallback(() => {
    hideIndexingNotice();
    if (!tabPage) return;
    void dismissSpaceNotice(INDEXING_SPACE_NOTICE).catch((error: unknown) => {
      console.error("Could not record the closed notice:", error);
    });
  }, [hideIndexingNotice, tabPage]);
  // A count belongs to the pass that sent it: the next pass starts from none.
  useEffect(() => {
    if (!isSyncing) setSyncProgress(null);
  }, [isSyncing]);
  // The first saved card's slug, while its one-time marker is on screen (О19).
  // Only the lead tab marks it: one marker for the space, not one per tab.
  const [firstCardSlug, setFirstCardSlug] = useState<string | null>(null);
  const firstCardPendingRef = useRef(false);
  useEffect(() => {
    firstCardPendingRef.current = false;
    setFirstCardSlug(null);
    firstCardMarkerPending()
      .then((pending) => {
        firstCardPendingRef.current = pending;
      })
      .catch(() => {});
  }, [vaultPath]);
  const [vaultReady, setVaultReady] = useState(false);
  // Whether this space still owes the empty-feed onboarding (О14, О15); null
  // until the space's own index answers.
  const [spaceOnboardingOwed, setSpaceOnboardingOwed] = useState<boolean | null>(null);
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [thumbsRootPath, setThumbsRootPath] = useState<string | null>(null);
  const activeDragBlock = activeDragBlocks[0] ?? null;
  const renderedDragBlocks = useMemo(() => {
    const current = new Map(blocks.map((block) => [block.slug, block]));
    return activeDragBlocks.map((block) => current.get(block.slug) ?? block);
  }, [activeDragBlocks, blocks]);

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

  const previewRowRevisionsRef = useRef(new Map<string, number>());
  const applyGridSnapshot = useCallback((tag: string | undefined, grid: GridSnapshot): boolean => {
    if (!projectionRevisionOwner.accept("grid", grid.generation)) {
      return false;
    }
    gridGenerationRef.current = grid.generation;
    const routeKey = routeKeyFor(tag);
    const currentBySlug = new Map(blocksRef.current.map((block) => [block.slug, block]));
    const incoming = grid.blocks.map((block) =>
      (previewRowRevisionsRef.current.get(block.slug) ?? -1) > grid.generation
        ? currentBySlug.get(block.slug) ?? block : block);
    routeSnapshotCacheRef.current.set(routeKey, { ...grid, blocks: incoming });
    // Preserve object identity for blocks whose content did not change so a
    // no-op refresh does not invalidate the grid's downstream memos or remount
    // any cards.
    setBlocks((prev) => reconcileBlocks(prev, incoming, heldSlugsRef.current));
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

  const previewRowsRef = useRef<ReturnType<typeof createPreviewRowQueue> | null>(null);
  // A preview that lands before the feed holds its card: the feed read that
  // brings the card may have started before the preview was written, and
  // would leave the card on its provisional shape until the next full read.
  // Remembered briefly, re-read on arrival.
  const unseenPreviewSlugsRef = useRef(new Map<string, number>());
  useEffect(() => {
    previewRowRevisionsRef.current.clear();
    if (!vaultReady) return;
    const path = vaultPath;
    const tag = currentTag;
    const queue = createPreviewRowQueue({
      fetch: (slugs) => getGridRows(path, slugs),
      apply: (snapshot) => {
        if (snapshot.path !== vaultPathRef.current || currentTagRef.current !== tag) return;
        if (snapshot.generation < (gridGenerationRef.current ?? -1)) return;
        invalidateRouteSnapshots();
        const replacements = new Map(snapshot.blocks.filter((block) => {
          if (snapshot.generation < (previewRowRevisionsRef.current.get(block.slug) ?? -1)) return false;
          previewRowRevisionsRef.current.set(block.slug, snapshot.generation);
          return true;
        }).map((block) => [block.slug, block]));
        // Keep route membership/order and identities of unchanged cards. A late
        // response never resurrects a deleted card or truncates loaded pages.
        setBlocks((current) => reconcileBlocks(current,
          current.map((block) => replacements.get(block.slug) ?? block)));
      },
      onError: (error) => console.error("Failed to refresh preview rows:", error),
    });
    previewRowsRef.current = queue;
    return () => { queue.dispose(); previewRowsRef.current = null; };
  }, [vaultPath, currentTag, vaultReady, invalidateRouteSnapshots, projectionRevisionOwner]);

  useEffect(() => {
    unseenPreviewSlugsRef.current.clear();
  }, [vaultPath]);

  // A card whose preview landed before it did gets its row read again.
  useEffect(() => {
    const unseen = unseenPreviewSlugsRef.current;
    if (unseen.size === 0) return;
    const now = Date.now();
    for (const block of blocks) {
      const landedAt = unseen.get(block.slug);
      if (landedAt === undefined) continue;
      unseen.delete(block.slug);
      if (now - landedAt <= UNSEEN_PREVIEW_WINDOW_MS) previewRowsRef.current?.add(block.slug);
    }
  }, [blocks]);

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

  // The collection this tab is moving to because another tab renamed it.
  const followedCollectionRef = useRef<string | null>(null);
  // Redirect if navigated to a channel that doesn't exist (check both tags and
  // channels). Judged once collections were read at least once, even when the
  // space has none: a restored tab or another tab's deletion can leave this
  // tab in a collection that is gone (SPEC_TABS.md, В18).
  useEffect(() => {
    if (suppressRedirectRef.current) return;
    // Following a renamed collection: the new route lands after the renamed
    // list, and the old name in between is not a deletion (В18).
    const followed = followedCollectionRef.current;
    if (followed !== null) {
      if (currentTag !== followed) return;
      followedCollectionRef.current = null;
    }
    if (currentTag && taxonomyLoaded
      && !tags.some((t) => t.tag === currentTag)
      && !channels.some((c) => c.tag === currentTag)) {
      navigate("/");
    }
  }, [currentTag, tags, channels, navigate, taxonomyLoaded]);

  const activeBlocks = blocks;
  const gridRouteSnapshotReady =
    gridSnapshotIdentity?.routeKey === routeKeyFor(currentTag);
  const renderedDetailBlock = selectedBlock ?? closingDetailBlock;
  // The menu the bar's Command entry opens, and so the chord it shows: over an
  // open element its own command, in the feed the selection's or the card's.
  const barMenuCommand = commandById(
    renderedDetailBlock ? "element-menu-open" : hasSelection ? "batch-menu" : "element-menu",
  );
  const renderedLinkedBlockSlug = selectedBlock?.slug
    ?? (detailChromeClosing ? closingDetailBlock?.slug ?? null : null);
  const renderedLinkedTags = selectedBlock
    ? selectedBlockTags
    : (detailChromeClosing ? closingDetailTags : []);
  // Alt 2 moves the metadata row to the foot of the window and drops the button
  // bar entirely: one strip along the bottom instead of two, with the row that
  // describes what you are looking at nearest to the content it describes.
  const design = useDesignMode();
  const metadataRowAtBottom = design === "alt2";
  const compactDetailTopMenuActive =
    (compactDetailTopMenuEnabled || metadataRowAtBottom) && renderedDetailBlock !== null;
  // At the bottom the row survives an open card — that is where its collections
  // and note metadata now live, so hiding it would take them away.
  const mainSecondaryTopBarVisible = metadataRowAtBottom || !compactDetailTopMenuActive;
  const detailChromeCloseDuration = compactDetailTopMenuActive
    ? DETAIL_COMPACT_CHROME_EXIT_MS
    : DETAIL_SECONDARY_CHROME_EXIT_MS;
  const topChromeSurfaceClass = "bg-chrome";
  const topChromeSurfaceToken: NativeWindowChromeSurfaceToken = "--chrome";
  // No third row: what it held over the feed joins the second row after the
  // collection switcher; with the sidebar collapsed nothing parts space and
  // collection (DESIGN_SYSTEM.md, «Верхние ряды»).
  const foldedMetadataRow = !metadataRowAtBottom;
  // The open card is named by the shared visible title rule, without its
  // folder or extension (SPEC_DISPLAY_TITLE.md).
  const compactDetailCardTitle = renderedDetailBlock ? getNavigationLabel(renderedDetailBlock) : "";
  // The search overlay is modal: while it is open the feed answers no key,
  // ⌘K included (SPEC_SEARCH_OVERLAY.md; SPEC_AUDIT_FIXES.md, Г4.2).
  const gridKeyboardNavigationDisabled = Boolean(renderedDetailBlock)
    || renamingBlock !== null
    || deleteTargetSlug !== null
    || isCreatingChannel
    || searchOverlayOpen;
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

  // A route change made to follow a renamed collection keeps the open card
  // (SPEC_TABS.md, В18).
  const keepDetailOnRouteChangeRef = useRef(false);
  // Close Detail when navigating to a different route. Feed keyboard focus is
  // owned by Grid and resets with the route-scoped Grid instance.
  useEffect(() => {
    if (keepDetailOnRouteChangeRef.current) {
      keepDetailOnRouteChangeRef.current = false;
      return;
    }
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
    minWidth: sidebarMinWidthPx,
    maxWidth: sidebarMaxWidthPx,
    startResize,
    updateResize,
    endResize,
    resizeTo: resizeSidebarTo,
    toggleCollapsed,
  } = useSidebarResize(windowSidebar);

  // The filter row over the sidebar's table narrows the space name so the
  // field keeps its minimum (useSidebarRowFit.ts).
  const { fit: sidebarRowFit, rowRef: sidebarRowRef } = useSidebarRowFit(
    sidebarSearchInputRef,
    [
      vaultPath,
      sidebarCollapsed,
      renderedDetailBlock !== null,
      sidebarSearchHasValue,
      isSyncing,
      blocks.some((item) => item.content_in_cloud),
    ].join("|"),
  );



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
    limit: SIDEBAR_PREVIEW_SLOTS,
    revisionOwner: projectionRevisionOwner,
  });

  // Phase 2 thumbnail upgrade pipeline: Web Worker decodes webp/heic/
  // video media via the browser's native decoder and writes real JPEG
  // bytes back through save_thumb. Mounts once vault is open, and only in
  // the tab that leads the space: one page decodes for all of them, and a
  // hidden page has no frames to decode with (SPEC_TABS.md, В19).
  useThumbnailUpgrade(vaultReady && lead);

  // Errors are kept per source, and only that source clears its own
  // (SPEC_AUDIT_FIXES.md, Г4.1, Д2.4): a late collections answer never hides
  // a failed feed read, and no successful read hides a failed index pass.
  // - Opening the space: cleared by opening a space again.
  // - The index pass: cleared by a pass that finishes without one, or a new
  //   open. A read that succeeds reads the index as it is, not a repaired one.
  // - The feed read (its route or its next page) and the collections read:
  //   cleared by their own next successful answer.
  // - Creating an element from a selection: cleared by closing its notice or
  //   by a new open.
  const [openError, setOpenError] = useState<string | null>(null);
  const [indexingError, setIndexingError] = useState<string | null>(null);
  const [gridLoadError, setGridLoadError] = useState<string | null>(null);
  const [taxonomyLoadError, setTaxonomyLoadError] = useState<string | null>(null);
  const [selectionCardError, setSelectionCardError] = useState<string | null>(null);
  const loadError = openError ?? indexingError ?? gridLoadError ?? taxonomyLoadError;
  const indexingNotice = useErrorNotice(indexingError);
  const gridLoadNotice = useErrorNotice(gridLoadError);
  const taxonomyLoadNotice = useErrorNotice(taxonomyLoadError);

  useEffect(() => {
    if (!loadError) return;
    // An error in the feed's place is this tab's first screen too (В5).
    onFirstScreenRef.current?.();
    if (!isTauri()) return;
    return scheduleAfterNextPaint(() => {
      void recordStartupMilestone("interactive").catch(() => {});
      void startStartupMaintenance().catch((error) => {
        console.warn("Startup maintenance could not begin:", error);
      });
    });
  }, [loadError]);

  const cancelGridRetry = useCallback(() => {
    if (gridRetryTimerRef.current !== null) {
      window.clearTimeout(gridRetryTimerRef.current);
      gridRetryTimerRef.current = null;
    }
  }, []);

  const cancelPageRetry = useCallback(() => {
    if (pageRetryTimerRef.current !== null) {
      window.clearTimeout(pageRetryTimerRef.current);
      pageRetryTimerRef.current = null;
    }
  }, []);

  // A failed route read is read again on its own, a bounded number of times.
  // The retry re-reads the whole loaded range of the route that failed; any
  // newer read cancels it, and a route or space change leaves it unanswered.
  const scheduleGridRetry = useCallback((tag: string | undefined) => {
    cancelGridRetry();
    const attempt = gridRetryAttemptsRef.current;
    const delay = FEED_READ_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    gridRetryAttemptsRef.current = attempt + 1;
    const pathAtStart = vaultPathRef.current;
    gridRetryTimerRef.current = window.setTimeout(() => {
      gridRetryTimerRef.current = null;
      if (vaultPathRef.current !== pathAtStart || currentTagRef.current !== tag) return;
      void loadGridSnapshotRef.current({ tag, preserveLoadedRange: true, retry: true });
    }, delay);
  }, [cancelGridRetry]);

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
    retry = false,
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
    /** The read is an automatic retry of a failed one and spends its budget. */
    retry?: boolean;
  } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    cancelGridRetry();
    // The route's list is read again from its first card: a page retry for
    // the list on screen has nothing left to continue.
    cancelPageRetry();
    if (!retry) gridRetryAttemptsRef.current = 0;
    paginationRequestRef.current = null;
    setLoadingMoreBlocks(false);
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = tag;
    const routeKey = routeKeyFor(tagAtStart);
    const orderAtStart = getFeedDisplay().sort;
    const started = performance.now();
    if (invalidateCachedRoutes) {
      invalidateRouteSnapshots();
    }
    if (preferCachedRoute) {
      const cached = routeSnapshotCacheRef.current.get(routeKey);
      // Cached routes are dropped whenever the order changes, so a cached list
      // is a list in the current order.
      if (cached && applyGridSnapshot(tagAtStart, cached)) {
        shownListRef.current = { routeKey, order: orderAtStart };
        setGridLoadError(null);
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
      const grid = await fetchGridBlocks(tagAtStart, 0, pageLimit, orderAtStart);
      if (
        loadRequestIdRef.current !== requestId
        || vaultPathRef.current !== pathAtStart
        || currentTagRef.current !== tagAtStart
      ) {
        return false;
      }
      if (!applyGridSnapshot(tagAtStart, grid)) {
        return false;
      }
      shownListRef.current = { routeKey, order: orderAtStart };
      gridRetryAttemptsRef.current = 0;
      pageRetryAttemptsRef.current = 0;
      setAppliedRouteLoadId(requestId);
      setIndexRereadAfterLoadId((after) => (after !== null && requestId > after ? null : after));
      setGridLoadError(null);
      window.dispatchEvent(new Event("vault-refreshed"));
      console.info("[startup] loadGrid:done", {
        requestId,
        blocks: grid.blocks.length,
        elapsedMs: Math.round(performance.now() - started),
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        loadRequestIdRef.current === requestId
        && vaultPathRef.current === pathAtStart
        && currentTagRef.current === tagAtStart
      ) {
        console.error("[LOAD_GRID] FAILED:", msg, err);
        // The list on screen stays. Paging waits for the retry: the next page
        // continues the list only once it is read again (Д1.4).
        setGridLoadError(msg);
        scheduleGridRetry(tagAtStart);
      }
      console.error("[startup] loadGrid:failed", {
        requestId,
        tag: tagAtStart ?? "__all__",
        elapsedMs: Math.round(performance.now() - started),
        error: msg,
      });
      return false;
    }
  }, [applyGridSnapshot, cancelGridRetry, cancelPageRetry, invalidateRouteSnapshots, routeKeyFor, scheduleGridRetry]);

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
      setTaxonomyLoaded(true);
      setTotalBlocks(snapshot.total_blocks);
      // Kept outside React state: hovering cards and rows reads it on every
      // pointer move (SPEC_CARD_STATES.md, С3 and С4).
      setCollectionMemberships(snapshot.memberships ?? []);
      setTaxonomyLoadError(null);
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
        setTaxonomyLoadError(msg);
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

  // A new order re-reads the feed from its first card. The load bumps the
  // request id, so a page of the old order still in flight is dropped, and
  // cached routes of the old order are discarded (SPEC_FEED_DISPLAY.md, Д8).
  const { sort: feedSort } = useFeedDisplay();
  const appliedFeedSortRef = useRef(feedSort);
  useEffect(() => {
    if (appliedFeedSortRef.current === feedSort) return;
    appliedFeedSortRef.current = feedSort;
    if (!vaultReady) return;
    invalidateRouteSnapshots();
    setScrollToTopSignal((n) => n + 1);
    void loadGridSnapshotRef.current({ invalidateCachedRoutes: true });
  }, [feedSort, invalidateRouteSnapshots, vaultReady]);
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

  // A failed next page is asked again on its own, a bounded number of times,
  // while the route load it continues is still the one on screen. Any route
  // read cancels it: that read brings the list again from its first card.
  const schedulePageRetry = useCallback(() => {
    cancelPageRetry();
    const attempt = pageRetryAttemptsRef.current;
    const delay = FEED_READ_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    pageRetryAttemptsRef.current = attempt + 1;
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = currentTagRef.current;
    const routeLoadRequestIdAtStart = loadRequestIdRef.current;
    pageRetryTimerRef.current = window.setTimeout(() => {
      pageRetryTimerRef.current = null;
      if (
        vaultPathRef.current !== pathAtStart
        || currentTagRef.current !== tagAtStart
        || loadRequestIdRef.current !== routeLoadRequestIdAtStart
      ) {
        return;
      }
      void loadNextPageRef.current({ retry: true });
    }, delay);
  }, [cancelPageRetry]);

  const loadNextPage = useCallback(async ({ retry }: { retry: boolean }) => {
    if (paginationRequestRef.current || !hasMoreBlocks) return;
    // A newer route load has not landed: the list on screen is not the one the
    // next page continues.
    if (appliedRouteLoadId !== loadRequestIdRef.current) return;
    // A failed read is answered by its own bounded retry, not by the feed. The
    // feed asks whenever it stands at its end and nothing is loading, so a
    // request it makes after a failure would fail again at once, and again,
    // as fast as the store answers (SPEC_AUDIT_FIXES.md, Д1.4).
    if (
      !retry
      && (gridLoadError !== null || gridRetryTimerRef.current !== null || pageRetryTimerRef.current !== null)
    ) {
      return;
    }
    const requestToken = {};
    paginationRequestRef.current = requestToken;
    const pathAtStart = vaultPathRef.current;
    const tagAtStart = currentTagRef.current;
    const offsetAtStart = blocksRef.current.length;
    const routeLoadRequestIdAtStart = loadRequestIdRef.current;
    const generationAtStart = gridGenerationRef.current;
    // The next page continues the list on screen, in that list's order.
    const orderAtStart = shownListRef.current?.order ?? getFeedDisplay().sort;
    setLoadingMoreBlocks(true);
    try {
      const grid = await fetchGridBlocks(tagAtStart, offsetAtStart, GRID_PAGE_SIZE, orderAtStart);
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
      pageRetryAttemptsRef.current = 0;
      // Paging is refused while a feed read has failed, so the error a retried
      // page answers is that page's own.
      if (retry) setGridLoadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        vaultPathRef.current === pathAtStart
        && currentTagRef.current === tagAtStart
        && loadRequestIdRef.current === routeLoadRequestIdAtStart
      ) {
        console.error("[LOAD_MORE] FAILED:", msg, err);
        // The route's own retry, its timer and its budget, are not the page's
        // to restart or spend.
        setGridLoadError(msg);
        schedulePageRetry();
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
  }, [appliedRouteLoadId, gridLoadError, hasMoreBlocks, invalidateRouteSnapshots, routeKeyFor, schedulePageRetry]);
  const loadNextPageRef = useRef(loadNextPage);
  loadNextPageRef.current = loadNextPage;

  // The feed's own request for the next page.
  const loadMoreBlocks = useCallback(() => loadNextPage({ retry: false }), [loadNextPage]);

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
      // A cached list is on screen while its fresh read is in flight: the warm
      // page waits for that read instead of being spent on a refused request.
      || appliedRouteLoadId !== loadRequestIdRef.current
      // A failed feed read refuses paging until its retry succeeds (Д1.4).
      || gridLoadError !== null
    ) {
      return;
    }
    const routeKey = routeKeyFor(currentTag);
    if (warmRoutePageBufferRef.current.has(routeKey)) return;
    warmRoutePageBufferRef.current.add(routeKey);
    void loadMoreBlocks();
  }, [
    appliedRouteLoadId,
    blocks.length,
    currentTag,
    gridLoadError,
    gridRouteSnapshotReady,
    hasMoreBlocks,
    loadMoreBlocks,
    mainViewMode,
    routeKeyFor,
    vaultReady,
  ]);

  // The empty-space onboarding shows where the extension is: the folder a
  // browser loads once (SPEC_ONBOARDING.md, О16).
  const revealClipperExtensionFolder = useCallback(() => {
    void clipperExtensionFolder()
      .then((folder) => revealItemInDir(folder))
      .catch((error) => console.error("Could not show the extension folder:", error));
  }, []);

  const checkSpaceOnboarding = useCallback(() => {
    const path = vaultPath;
    void spaceOnboardingPending()
      .then((owed) => {
        if (vaultPathRef.current === path) setSpaceOnboardingOwed(owed);
      })
      .catch(() => {});
  }, [vaultPath]);
  useEffect(() => {
    setSpaceOnboardingOwed(null);
    if (vaultReady) checkSpaceOnboarding();
  }, [checkSpaceOnboarding, vaultReady]);
  // Cards appeared while the onboarding was owed: the space's index is asked
  // again and records its first card, after which deleting every card leaves
  // an empty feed, not the introduction (О15).
  useEffect(() => {
    if (spaceOnboardingOwed === true && totalBlocks > 0) checkSpaceOnboarding();
  }, [checkSpaceOnboarding, spaceOnboardingOwed, totalBlocks]);

  useEffect(() => {
    let cancelled = false;
    setVaultReady(false);
    setOpenError(null);
    setIndexingError(null);
    setGridLoadError(null);
    setTaxonomyLoadError(null);
    setSelectionCardError(null);
    cancelGridRetry();
    cancelPageRetry();
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
        setOpenError(msg);
        setIsSyncing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cancelGridRetry, cancelPageRetry, invalidateRouteSnapshots, vaultPath]);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    let cancelled = false;
    let cancelPostPaint: (() => void) | null = null;
    const initialTag = currentTag;

    setIsSyncing(true);
    initialRouteLoadDoneRef.current = false;
    void (async () => {
      const [gridLoaded] = await Promise.all([
        loadGridSnapshotRef.current({ tag: initialTag }),
        loadTaxonomySnapshotRef.current(),
        loadVaultStatsRef.current(initialTag),
      ]);
      if (cancelled) return;
      initialRouteLoadDoneRef.current = true;
      const activeTag = currentTagRef.current;
      const activeRouteKey = routeKeyFor(activeTag);
      lastRevalidatedRouteKeyRef.current = activeRouteKey;
      let routeCommitted = gridLoaded;
      if (activeTag !== initialTag) {
        routeCommitted = await loadGridSnapshotRef.current({
          tag: activeTag,
          preferCachedRoute: true,
        });
        if (cancelled) return;
      }
      if (routeCommitted && isTauri()) {
        void recordStartupMilestone("first_route_committed").catch(() => {});
      }
      // The first route, read or failed, is what this tab shows first (В5).
      onFirstScreenRef.current?.();
      setInitialLoadsDone(true);
      cancelPostPaint = scheduleAfterNextPaint(() => {
        if (cancelled) return;
        if (routeCommitted && isTauri()) {
          // Recorded when the feed shows cards with their content, not when
          // the route commits under skeletons (SPEC_AUDIT_FIXES.md, А8.2).
          void whenCardsRendered()
            .then(() => recordStartupMilestone("first_cards_painted"))
            .catch(() => {});
          void recordStartupMilestone("interactive").catch(() => {});
          void recordStartupMilestone("update_ready").catch(() => {});
          void startStartupMaintenance().catch((error) => {
            console.warn("Startup maintenance could not begin:", error);
          });
        }
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
              setIsSyncing(false);
            }
          });
      });
    })();

    return () => {
      cancelled = true;
      cancelPostPaint?.();
    };
  }, [routeKeyFor, vaultPath, vaultReady]);

  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    void loadVaultStatsRef.current(currentTag);
  }, [currentTag, vaultReady]);

  // Filesystem catch-up plus passive thumb sweep when the person comes back to
  // Mine. The route refresh joins VaultReconciler before querying, so missed
  // notify events cannot leave Grid/Sidebar stale. The backend asks for it on
  // the focus of a tab window, once per open space and at most every 10 s;
  // showing a tab asks for nothing (SPEC_TABS.md, В42).
  const isSyncingRef = useRef(isSyncing);
  isSyncingRef.current = isSyncing;
  useEffect(() => {
    if (!vaultReady) {
      return;
    }
    const subscription = listenPage(TAB_REFRESH_REQUESTED_EVENT, () => {
      if (isSyncingRef.current) return;
      scheduleRefresh(
        { grid: true, taxonomy: true, previews: true },
        0,
        { force: true },
      );
      void sweepVaultThumbnails().catch((err) => {
        console.warn("[THUMB_SWEEP] failed:", err);
      });
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, [scheduleRefresh, vaultReady]);

  // ── Tab memory (SPEC_TABS.md, В18, В31, В40, В78) ───────────────────────

  const selectedBlockRef = useRef(selectedBlock);
  selectedBlockRef.current = selectedBlock;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  /// Another tab of this space or the world outside changed it (В18): the
  /// place follows a renamed collection, the open card a renamed card, and
  /// an open card that is gone closes. A collection that is gone sends the
  /// tab to Everything once collections are read again (the redirect above).
  const followSpaceChange = (renames: readonly SpaceRename[]) => {
    for (const rename of renames) {
      if (rename.kind !== "collection") continue;
      // Renamed here at once, so the redirect does not take the old name's
      // absence for a deletion before the collections are read again.
      setTags((current) => current.map((item) => (
        item.tag === rename.from ? { ...item, tag: rename.to } : item
      )));
      setChannels((current) => current.map((item) => (
        item.tag === rename.from ? { ...item, tag: rename.to } : item
      )));
      if (currentTagRef.current === rename.from) {
        keepDetailOnRouteChangeRef.current = selectedBlockRef.current !== null;
        followedCollectionRef.current = rename.to;
        navigateRef.current(tabLocationPath({ kind: "collection", tag: rename.to }), { replace: true });
      }
    }
    const open = selectedBlockRef.current;
    if (!open) return;
    const cardRename = renames.find((rename) => rename.kind === "card" && rename.from === open.slug);
    const slug = cardRename?.to ?? open.slug;
    if (cardRename) {
      setSelectedBlock((current) => (
        current && current.slug === cardRename.from ? { ...current, slug: cardRename.to } : current
      ));
    }
    void getBlock(slug)
      .then((full) => {
        setSelectedBlock((current) => {
          if (!current || current.slug !== slug) return current;
          // Gone: closed. Renamed: the fresh card under its new name. Still
          // there: the card on screen stays as it is.
          if (!full) return null;
          return cardRename ? full : current;
        });
        if (!full) setSelectedBlockAnchor(null);
      })
      .catch((error: unknown) => {
        console.error("Could not re-read the open card:", error);
      });
  };
  const followSpaceChangeRef = useRef(followSpaceChange);
  followSpaceChangeRef.current = followSpaceChange;

  // The place, the mode and the filter came back as the first state; the
  // open card and the scroll follow once the space is read.
  const [viewRestored, setViewRestored] = useState(restoreView === null);
  useEffect(() => {
    if (viewRestored || !initialLoadsDone) return;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      setViewRestored(true);
      onRestoredRef.current?.();
    };
    const card = restoreView?.open_card ?? null;
    if (!card) {
      finish();
      return;
    }
    void getBlock(card.slug)
      .then((full) => {
        if (cancelled || !full) return;
        // A card that is gone stays closed (В18).
        openDetailBlock(full);
      })
      .catch((error: unknown) => console.error("Could not reopen the tab's card:", error))
      .finally(finish);
    return () => {
      cancelled = true;
    };
  }, [initialLoadsDone, openDetailBlock, restoreView, viewRestored]);

  // ── Back and forward through the tab's places (SPEC_TABS.md, В81) ───────
  // Every place the tab comes to by itself is recorded. A step asked by the
  // tab bar goes to its place and records nothing on the way; a place that
  // is gone (a card deleted, a collection renamed) settles the step where it
  // landed.
  const placeHistoryRef = useRef<PlaceHistory>(EMPTY_PLACE_HISTORY);
  const stepTargetRef = useRef<Place | null>(null);
  const reportedHistoryRef = useRef<{ back: boolean; forward: boolean } | null>(null);
  const handleDetailCloseRef = useRef<() => void>(() => {});
  const selectedSlug = selectedBlock?.slug ?? null;
  const placeRef = useRef<Place>({ tag: null, card: null });
  placeRef.current = { tag: currentTag ?? null, card: selectedSlug };

  const reportPlaceHistory = useCallback(() => {
    if (!tabPage) return;
    const directions = historyDirections(placeHistoryRef.current);
    const reported = reportedHistoryRef.current;
    if (reported?.back === directions.back && reported.forward === directions.forward) return;
    reportedHistoryRef.current = directions;
    void reportTabHistory(directions.back, directions.forward).catch((error: unknown) => {
      console.error("Could not report the tab's history:", error);
    });
  }, [tabPage]);

  // A place is read once the page settles: a route change closes the open
  // card a render later, and the new route with the old card is no place.
  useEffect(() => {
    if (!viewRestored) return;
    return afterTwoFrames(() => {
      const place = placeRef.current;
      const target = stepTargetRef.current;
      if (target !== null) {
        // On the way to a step's place only its arrival counts.
        if (!samePlace(target, place)) return;
        stepTargetRef.current = null;
      } else {
        placeHistoryRef.current = recordPlace(placeHistoryRef.current, place);
      }
      reportPlaceHistory();
    });
  }, [currentTag, reportPlaceHistory, selectedSlug, viewRestored]);

  /// Go to `target`, unless a later step took over while its card was read.
  const goToPlace = useCallback(async (target: Place, latest: () => boolean) => {
    const block = target.card === null
      ? null
      : await getBlock(target.card).catch((error: unknown) => {
        console.error("Could not read the card of a place:", error);
        return null;
      });
    if (!latest()) return;
    const current = placeRef.current;
    const routeChanges = target.tag !== current.tag;
    if (routeChanges) {
      // The place's card opens over its route instead of being closed by it.
      if (block) keepDetailOnRouteChangeRef.current = true;
      navigate(tabLocationPath(tabLocationOf(target.tag ?? undefined)));
    }
    if (block) openDetailBlock(block);
    else if (!routeChanges && current.card !== null) handleDetailCloseRef.current();
  }, [navigate, openDetailBlock]);

  useEffect(() => {
    if (!tabPage || !viewRestored) return;
    let disposed = false;
    let cancelSettle: (() => void) | null = null;
    // Steps come one after another, a quick second click before the first
    // has landed included: the latest step's place is the one gone to.
    let steps = 0;
    const subscription = listenPage<TabHistoryStep>(TAB_HISTORY_GO_EVENT, (event) => {
      const step = stepPlace(placeHistoryRef.current, event.payload.forward);
      if (step === null) return;
      const seq = ++steps;
      const latest = () => !disposed && seq === steps;
      placeHistoryRef.current = step.history;
      stepTargetRef.current = step.target;
      reportPlaceHistory();
      cancelSettle?.();
      void goToPlace(step.target, latest).finally(() => {
        if (!latest()) return;
        // Whatever the step reached is on screen two frames later.
        cancelSettle = afterTwoFrames(() => {
          if (!latest() || stepTargetRef.current === null) return;
          stepTargetRef.current = null;
          placeHistoryRef.current = settlePlace(placeHistoryRef.current, placeRef.current);
          reportPlaceHistory();
        });
      });
    });
    return () => {
      disposed = true;
      cancelSettle?.();
      void subscription.then((stop) => stop());
    };
  }, [goToPlace, reportPlaceHistory, tabPage, viewRestored]);

  // The scroll comes back once its card is in the feed: pages are read on
  // until it is, and a card that is gone leaves the feed at its top (В18).
  // Another place or Graph before that drops it.
  const [pendingScroll, setPendingScroll] = useState<{ anchor: ScrollAnchor; routeKey: string } | null>(() => (
    restoreView?.scroll_anchor && restoreView.mode === "grid"
      ? {
          anchor: restoreView.scroll_anchor,
          routeKey: restoreView.location.kind === "collection" ? restoreView.location.tag : "__all__",
        }
      : null
  ));
  const pendingScrollRef = useRef(pendingScroll);
  pendingScrollRef.current = pendingScroll;
  // Pages asked for on the scroll's behalf: bounded, so a feed that never
  // brings the card back cannot be read forever.
  const scrollRestorePagesRef = useRef(0);
  const scrollRestoreAnchor = useMemo(() => (
    pendingScroll && blocks.some((item) => item.slug === pendingScroll.anchor.slug)
      ? pendingScroll.anchor
      : null
  ), [blocks, pendingScroll]);
  useEffect(() => {
    if (!pendingScroll || !initialLoadsDone) return;
    if (mainViewMode !== "grid" || routeKeyFor(currentTag) !== pendingScroll.routeKey || gridLoadError !== null) {
      setPendingScroll(null);
      return;
    }
    if (!gridRouteSnapshotReady || scrollRestoreAnchor || loadingMoreBlocks) return;
    if (hasMoreBlocks && scrollRestorePagesRef.current < SCROLL_RESTORE_PAGE_LIMIT) {
      scrollRestorePagesRef.current += 1;
      void loadMoreBlocks();
      return;
    }
    setPendingScroll(null);
  }, [
    appliedRouteLoadId,
    currentTag,
    gridLoadError,
    gridRouteSnapshotReady,
    hasMoreBlocks,
    initialLoadsDone,
    loadMoreBlocks,
    loadingMoreBlocks,
    mainViewMode,
    pendingScroll,
    routeKeyFor,
    scrollRestoreAnchor,
  ]);
  const handleScrollAnchorRestored = useCallback(() => setPendingScroll(null), []);

  // Where the feed stands, read when a report goes out.
  const readScrollPositionRef = useRef<(() => ScrollAnchor | null) | null>(null);
  const reporterRef = useRef<TabViewReporter | null>(null);
  const handleScrollPositionChange = useCallback((read: () => ScrollAnchor | null) => {
    readScrollPositionRef.current = read;
    reporterRef.current?.schedule();
  }, []);
  const tabViewInputRef = useRef({ currentTag, mainViewMode, selectedBlock, sidebarSearchQuery });
  tabViewInputRef.current = { currentTag, mainViewMode, selectedBlock, sidebarSearchQuery };
  const readTabView = useCallback((): TabView => {
    const input = tabViewInputRef.current;
    return {
      location: tabLocationOf(input.currentTag),
      mode: input.mainViewMode,
      open_card: input.selectedBlock
        ? {
          slug: input.selectedBlock.slug,
          // The card's visible title, else its label without folder or
          // extension (SPEC_DISPLAY_TITLE.md; SPEC_TABS.md, В47).
          title: getNavigationLabel(input.selectedBlock),
        }
        : null,
      // A scroll still on its way back is what the tab remembers.
      scroll_anchor: pendingScrollRef.current?.anchor ?? readScrollPositionRef.current?.() ?? null,
      collection_filter: input.sidebarSearchQuery,
    };
  }, []);

  // The tab reports its memory once restored: at most every
  // TAB_VIEW_REPORT_DEBOUNCE_MS, and at once when hidden or closed (В31,
  // В40). Menus, dialogs, search, editors, selection and history are not
  // part of it (В30).
  useEffect(() => {
    if (!tabPage || !viewRestored) return;
    const reporter = createTabViewReporter({
      read: readTabView,
      send: reportTabView,
      lastReported: savedViewRef.current,
    });
    reporterRef.current = reporter;
    reporter.schedule();
    const onPageHide = () => reporter.flush();
    window.addEventListener("pagehide", onPageHide);
    const visibility = listenPage<TabVisibility>(TAB_VISIBILITY_CHANGED_EVENT, (event) => {
      if (!event.payload.visible) reporter.flush();
    });
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void visibility.then((stop) => stop());
      reporter.dispose();
      reporterRef.current = null;
    };
  }, [readTabView, tabPage, viewRestored]);
  useEffect(() => {
    reporterRef.current?.schedule();
  }, [currentTag, mainViewMode, pendingScroll, selectedBlock?.slug, sidebarSearchQuery]);

  // The space was opened from outside and this tab shows it (В72).
  useEffect(() => {
    if (!tabPage) return;
    const subscription = listenPage(TAB_GO_EVERYTHING_EVENT, () => {
      setPendingScroll(null);
      setSelectedBlock(null);
      setSelectedBlockAnchor(null);
      navigateRef.current("/");
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, [tabPage]);

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

    unlistenFns.push(listenPage<BlockAddedEvent>("block:added", (event) => {
      // The very first card this space ever saved gets its one sentence about
      // being a file (О19): the feed was empty, the marker was never shown.
      // The lead tab alone marks it (SPEC_TABS.md, В19).
      if (leadRef.current && firstCardPendingRef.current && blocksRef.current.length === 0) {
        firstCardPendingRef.current = false;
        setFirstCardSlug(event.payload.slug);
        void completeFirstCardMarker().catch(() => {});
      }
      invalidateRoutesForTags(event.payload.tags);
      scheduleRefresh({
        grid: currentTagRef.current === undefined || event.payload.tags.includes(currentTagRef.current),
        taxonomy: true,
        previews: true,
      });
    }));

    unlistenFns.push(listenPage<BlockRemovedEvent>("block:removed", (event) => {
      invalidateRoutesForTags(event.payload.tags);
      scheduleRefresh({
        grid: currentTagRef.current === undefined || event.payload.tags.includes(currentTagRef.current),
        taxonomy: true,
        previews: true,
      });
    }));

    unlistenFns.push(listenPage<BlockRenamedEvent>("block:renamed", (event) => {
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

    unlistenFns.push(listenPage<ThumbUpdatedEvent>("thumb:updated", (event) => {
      if (event.payload.path && event.payload.path !== vaultPathRef.current) return;
      invalidateRouteSnapshots();
      if (blocksRef.current.some((block) => block.slug === event.payload.slug)) {
        previewRowsRef.current?.add(event.payload.slug);
      } else {
        rememberUnseenPreview(unseenPreviewSlugsRef.current, event.payload.slug, Date.now());
      }
      // Sidebar preview cache-buster (its own version ref, applied on the next
      // previews refresh below).
      bumpThumbVersion(event.payload.slug);
      // Also refresh pixels when the file was replaced at the same path.
      bumpFeedThumbVersion(event.payload.slug);
      scheduleRefresh({ previews: true });
    }));

    unlistenFns.push(listenPage<VaultChangedEvent>("vault-changed", (event) => {
      if (event.payload.path !== vaultPathRef.current) {
        return;
      }
      // Preview producers already invalidated individual rows above. Other
      // surfaces still receive the legacy vault notification.
      if (event.payload.preview_only) return;
      // Another tab of this space, or the world outside, changed it: this
      // tab's place and open card follow renames and leave what is gone
      // (SPEC_TABS.md, В15, В18).
      followSpaceChangeRef.current(event.payload.renames ?? []);
      invalidateRouteSnapshots();
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      });
    }));

    unlistenFns.push(listenPage<VaultStats>("vault:stats-updated", (event) => {
      const currentCollection = currentTagRef.current ?? null;
      if (event.payload.currentCollection === currentCollection) {
        setVaultStats(event.payload);
        return;
      }
      requestVaultStatsRefresh();
    }));

    unlistenFns.push(listenPage<VaultSyncStartedEvent>("vault-sync-started", (event) => {
      if (event.payload.path === vaultPathRef.current) {
        setIsSyncing(true);
      }
    }));

    unlistenFns.push(listenPage<VaultSyncProgressEvent>("vault-sync-progress", (event) => {
      if (event.payload.path !== vaultPathRef.current) return;
      setSyncProgress({ processed: event.payload.processed, total: event.payload.total });
    }));

    // Queued arrives before the index pass's `vault-sync-finished`, so the
    // opening notice passes from notes to previews without a gap.
    unlistenFns.push(listenPage<DerivedPreviewQueuedEvent>("derived-preview-queued", (event) => {
      if (event.payload.path !== vaultPathRef.current) return;
      setPreviewPass((pass) => pass ?? { count: null });
    }));

    unlistenFns.push(listenPage<DerivedPreviewProgressEvent>("derived-preview-progress", (event) => {
      if (event.payload.path !== vaultPathRef.current) return;
      setPreviewPass({ count: { processed: event.payload.processed, total: event.payload.total } });
    }));

    unlistenFns.push(listenPage<DerivedPreviewFinishedEvent>("derived-preview-finished", (event) => {
      if (event.payload.path !== vaultPathRef.current) return;
      setPreviewPass(null);
    }));

    unlistenFns.push(listenPage<VaultSyncFinishedEvent>("vault-sync-finished", (event) => {
      if (event.payload.path !== vaultPathRef.current) {
        return;
      }
      setIsSyncing(false);
      setSyncProgress(null);
      setCloudAdviceToken((token) => token + 1);
      if (event.payload.error) {
        setIndexingError(event.payload.error);
        return;
      }
      // The only answer to a failed index pass is one that finishes (Д2.4).
      setIndexingError(null);
      invalidateRouteSnapshots();
      setIndexRereadAfterLoadId(loadRequestIdRef.current);
      if (migrationRequired) {
        void reloadAllSnapshots().finally(() => {
          setMigrationRequired(false);
        });
        return;
      }
      // Read what the pass found at once rather than after the refresh
      // debounce: until then the feed shows the snapshot from before it.
      scheduleRefresh({
        grid: true,
        taxonomy: true,
        previews: true,
      }, 0, { force: true });
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
      if (gridRetryTimerRef.current !== null) {
        window.clearTimeout(gridRetryTimerRef.current);
        gridRetryTimerRef.current = null;
      }
      if (pageRetryTimerRef.current !== null) {
        window.clearTimeout(pageRetryTimerRef.current);
        pageRetryTimerRef.current = null;
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

  // A space chosen with ⌘ in the switcher opens in a new tab of this window;
  // this tab keeps its own (SPEC_TABS.md, В52).
  const openSpaceInNewTab = useCallback((vaultId: string) => {
    void newTab(vaultId).catch((error: unknown) => {
      console.error("Could not open the space in a new tab:", error);
    });
  }, []);

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
    // Cmd+F closes the overlay (SPEC_SEARCH_OVERLAY.md). An open card is a
    // surface the overlay opens over, not an overlay of its own (user's report
    // of 07.10.2026: Cmd+F did nothing over an open card); a dialog, menu or
    // preview above it keeps owning the keyboard.
    const insideSearchOverlay =
      active instanceof Element && active.closest("[data-search-overlay]") !== null;
    if (!insideSearchOverlay && isDetailShortcutBlockedTarget(active)) return;
    if (target === "sidebar") {
      focusSidebarSearch();
      return;
    }
    toggleSearchOverlay();
  }, [focusSidebarSearch, toggleSearchOverlay]);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listenPage<SurfaceSearchShortcutTarget>(
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

  // The View menu's Hide Sidebar (⌃⌘S), the two-finger swipe and the tab
  // bar's button change the window's sidebar in the backend; the change
  // arrives here as `window-sidebar-changed` (SPEC_TABS.md, В56).

  /// ⌘-click and ⇧⌘-click: the place in a new tab or a new window of this
  /// space, in this tab's mode (SPEC_TABS.md, В82).
  const openPlaceElsewhere = useCallback((
    tag: string | undefined,
    card: LightBlock | null,
    newWindow: boolean,
  ) => {
    const view: TabView = {
      location: tabLocationOf(tag),
      mode: mainViewMode,
      open_card: card ? { slug: card.slug, title: getNavigationLabel(card) } : null,
      scroll_anchor: null,
      collection_filter: "",
    };
    void openPlace(view, newWindow).catch((error: unknown) => {
      console.error("Could not open the place elsewhere:", error);
    });
  }, [mainViewMode]);
  const handleOpenBlockElsewhere = useCallback(
    (block: LightBlock, newWindow: boolean) => openPlaceElsewhere(currentTag, block, newWindow),
    [currentTag, openPlaceElsewhere],
  );
  const handleOpenRouteElsewhere = useCallback((to: string, newWindow: boolean) => {
    const tag = to.startsWith("/channel/") ? decodeURIComponent(to.slice("/channel/".length)) : undefined;
    openPlaceElsewhere(tag, null, newWindow);
  }, [openPlaceElsewhere]);

  const handleOpenSettings = useCallback((section?: SettingsSection) => {
    void openSettingsWindow(section).catch((error) => {
      console.error("Failed to open settings window:", error);
    });
  }, []);

  const handleMainViewModeChange = useCallback((next: MainViewMode) => {
    setMainViewMode(next);
  }, []);

  // The settings window writes localStorage (shared per origin) and emits
  // this event; re-read the changed key and update the affected state.
  useEffect(() => {
    let cancelled = false;
    const unlisten = listenPage<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
      if (cancelled) return;
      adoptSettingsChange(event.payload);
      const { key } = event.payload;
      if (key === THEME_STORAGE_KEY) {
        applyTheme(getStoredTheme());
      } else if (key === DESIGN_STORAGE_KEY) {
        applyDesign(getStoredDesignMode());
      } else if (key === BOTTOM_ACTION_BAR_HIDDEN_STORAGE_KEY) {
        setBottomActionBarHidden(getStoredBottomActionBarHidden());
      } else if (key === GRAPH_PREFERENCES_STORAGE_KEY) {
        setGraphPreferences(getStoredGraphPreferences());
      } else if (key === SCROLL_EDGE_FADE_STORAGE_KEY) {
        setScrollEdgeFade(getStoredScrollEdgeFade());
      } else if (key === CARD_RADIUS_STORAGE_KEY) {
        applyCardRadius(getStoredCardRadius());
      } else if (key === DENSITY_STORAGE_KEY) {
        applyDensity(getStoredDensity());
      } else if (key === CONTENT_FONT_STORAGE_KEY) {
        applyContentFont(getStoredContentFont());
      } else if (key === INTERFACE_FONT_STORAGE_KEY) {
        // Card metrics are measured with the interface font and resolved at
        // module load — a reload re-derives them and drops stale caches.
        applyInterfaceFont(getStoredInterfaceFont());
        window.location.reload();
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
      // Dev button styles (src/lib/buttonStyle.ts): step the buttons of
      // this window.
      if (commandPressed("flip-buttons", e)) {
        e.preventDefault();
        flipWindowButtonStyleHere();
        return;
      }
      if (commandPressed("toggle-sidebar", e)) {
        // The native View menu owns this accelerator in packaged Mine. Letting
        // WKWebView handle the same keydown would toggle the sidebar twice.
        if (isTauri()) return;
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      const searchSurface = commandPressed("find-collections", e)
        ? "sidebar"
        : commandPressed("find-elements", e)
          ? "main"
          : null;
      if (searchSurface) {
        // Opens over an open card too; only a layer above the card holds it.
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        handleSurfaceSearchShortcut(searchSurface);
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
      if (commandPressed("element-menu-open", e) && renderedDetailBlock) {
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        setCompactDetailTopMenuRequestSequence((current) => current + 1);
        return;
      }
      if (commandPressed("copy-path", e) && selectedBlock) {
        if (isDetailShortcutBlockedTarget(e.target)) return;
        e.preventDefault();
        copyTextToClipboard(blockMarkdownPath(vaultPath, selectedBlock.slug));
        return;
      }
      if (isOverlayKeyboardTarget(e.target)) return;
      if (commandPressed("switch-space", e)) {
        e.preventDefault();
        handleSwitchVault();
      } else if (commandPressed("new-collection", e)) {
        e.preventDefault();
        beginCreateCollection();
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
  handleDetailCloseRef.current = handleDetailClose;

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

  // A refused rename rejects: the sidebar keeps the name's field and shows
  // the reason under it (05.10.2026). What follows a rename that was taken
  // does not make it refused.
  const handleRenameTag = useCallback(
    async (oldTag: string, newTag: string) => {
      suppressRedirectRef.current = true;
      try {
        const result = await renameChannel(oldTag, newTag);
        try {
          await reloadAllSnapshots();
          if (window.location.pathname === `/channel/${encodeURIComponent(oldTag)}`) {
            navigate(`/channel/${encodeURIComponent(result.tag)}`);
          }
        } catch (err) {
          console.error("Failed to refresh after renaming a collection:", err);
        }
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
    await reloadAllSnapshots();
    navigate(`/channel/${encodeURIComponent(channel.tag)}`);
  }, [navigate, reloadAllSnapshots]);

  // ── Tab — the mode of the current surface ─────────────────────────────
  //
  // One rule instead of three shortcuts: Tab cycles the mode of whatever the
  // window is showing. Over the feed and the graph it toggles Grid ↔ Graph;
  // inside an open element it toggles the connections filter. Inside inputs,
  // dialogs, menus and overlays Tab stays native — those surfaces keep the
  // system's focus traversal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!commandPressed("toggle-view", e)) return;
      if (
        e.defaultPrevented
        || isEditableKeyboardTarget(e.target)
        || isOverlayKeyboardTarget(e.target)
        || isDetailShortcutBlockedTarget(e.target)
      ) {
        return;
      }
      e.preventDefault();
      // With a card open the key did switch All / Connected, gone now.
      if (renderedDetailBlock) return;
      handleMainViewModeChange(mainViewMode === "grid" ? "graph" : "grid");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleMainViewModeChange, mainViewMode, renderedDetailBlock]);

  // ── ⌘V — paste into the feed ──────────────────────────────────────────
  //
  // Files import like drops, a bitmap becomes an image element, a lone URL a
  // link element, other text a markdown element titled by its first line. In
  // inputs, dialogs and over an open element ⌘V stays native.
  const pasteBusyRef = useRef(false);
  useEffect(() => {
    // The chord is read at the keypress: a rebind in Settings changes the
    // registry without re-rendering this window (SPEC_AUDIT_FIXES.md, Ф11).
    const handler = (e: KeyboardEvent) => {
      if (!commandPressed("paste", e)) return;
      if (
        e.defaultPrevented
        || isEditableKeyboardTarget(e.target)
        || isOverlayKeyboardTarget(e.target)
        || isDetailShortcutBlockedTarget(e.target)
        || renderedDetailBlock
      ) {
        return;
      }
      if (pasteBusyRef.current) return;
      pasteBusyRef.current = true;
      void (async () => {
        try {
          const payload = await readClipboardPayload();
          const paramsList = createParamsForClipboardPayload(payload, currentTag);
          if (paramsList.length === 0) return;
          for (const params of paramsList) {
            await createBlock(params);
          }
          await reloadAllSnapshots();
        } catch (err) {
          console.error("Paste into feed failed:", err);
        } finally {
          pasteBusyRef.current = false;
        }
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentTag, reloadAllSnapshots, renderedDetailBlock]);

  // ── ⌘/ — the full command table, in Settings ──────────────────────────
  //
  // The list lives in the Shortcuts section, where it can also be changed;
  // a second copy of it as an overlay would be one more place to keep true.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!commandPressed("commands-overlay", e)) return;
      if (e.defaultPrevented || isEditableKeyboardTarget(e.target)) return;
      e.preventDefault();
      void openSettingsWindow("shortcuts");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Opt+Cmd+Up/Down — switch channels ─────────────────────────────────
  //
  // Works with a card open: the card belongs to the channel being left, so it
  // closes and the feed moves on. Detail is a full-screen viewer inside the same
  // route, not a modal that owns the keyboard — it does not even intercept the
  // arrows — so `isDetailShortcutBlockedTarget` lets it through while still
  // blocking menus, listboxes, the image preview and other dialogs.
  //
  // A collapsed sidebar takes the command away: stepping through a list nobody
  // can see moves the feed with no way to tell where it landed in the order.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (sidebarCollapsed) return;
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
  }, [
    currentTag,
    orderedTags,
    navigate,
    selectedBlock,
    sidebarCollapsed,
    handleDetailClose,
  ]);


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

  // A refused name rejects: the sidebar keeps the name's field and shows the
  // reason under it (05.10.2026). What follows a creation that was taken does
  // not make it refused.
  const createCollection = useCallback(
    // `drop` names what the new collection takes at once when the caller
    // knows it (Enter in the filter); otherwise the pending one applies.
    async (tag: string, drop?: PendingCreateChannelDrop | null) => {
      const pendingDrop = drop !== undefined ? drop : pendingCreateChannelDrop;
      const channel = await createChannel(tag);
      // Only now: a refused name keeps what the collection was to take for
      // the name that follows.
      setPendingCreateChannelDrop(null);
      try {
        // Named at the top of the list, it takes the first place there
        // instead of the last: the others move down by one.
        const order = [channel.tag, ...orderedTags.map((t) => t.tag).filter((t) => t !== channel.tag)];
        await reorderChannels(order.map((name, position) => ({ tag: name, position })));

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
      orderedTags,
      pendingCreateChannelDrop,
      reloadAllSnapshots,
      scheduleRefresh,
    ],
  );

  // Every other way to create one (Enter in the filter, the dialog): it has
  // no field to keep, so a refusal is logged.
  const handleCreateChannel = useCallback(
    async (tag: string, drop?: PendingCreateChannelDrop | null) => {
      try {
        await createCollection(tag, drop);
      } catch (err) {
        console.error("Failed to create collection:", err);
      }
    },
    [createCollection],
  );

  const handleSetCreatingChannel = useCallback((creating: boolean) => {
    setPendingCreateChannelDrop(null);
    setIsCreatingChannel(creating);
  }, []);

  /// Where a new collection is named depends on whether its future row is
  /// visible. Open sidebar: in the list, in the row it will occupy. Closed: in
  /// a dialog, because that row has nowhere to appear and the command used to
  /// do nothing at all.
  const beginCreateCollection = useCallback(() => {
    setPendingCreateChannelDrop(null);
    if (sidebarCollapsed) {
      setIsNamingCollection(true);
      return;
    }
    setIsCreatingChannel(true);
  }, [sidebarCollapsed]);

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
    const route = sidebarRowKeyToRoute(rowKey);
    if (!route) return;
    navigate(route);
  }, [navigate]);

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
    if (activeRowKey) {
      event.preventDefault();
      event.stopPropagation();
      activateSidebarSearchNavigationRow(activeRowKey);
      return;
    }
    // No row chosen with the arrows: Enter acts on the typed name. A
    // collection already called that opens; otherwise one is made with it,
    // taking the open card when its collections show Connected, and the
    // filter clears so the list shows the new collection on top.
    const name = sidebarSearchQuery.trim();
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    const lowered = name.toLowerCase();
    const existing = orderedTags.find(
      (tc) => tc.tag.toLowerCase() === lowered || collectionRefLabel(tc.tag).toLowerCase() === lowered,
    );
    if (existing) {
      activateSidebarSearchNavigationRow(`tag:${existing.tag}`);
      return;
    }
    void handleCreateChannel(name, null);
    handleClearSidebarSearch();
  }, [
    activateSidebarSearchNavigationRow,
    handleClearSidebarSearch,
    handleCreateChannel,
    moveSidebarSearchNavigationRow,
    orderedTags,
    selectedBlock,
    setSidebarSearchNavigationRow,
    sidebarSearchHasValue,
    sidebarSearchKeyboardNavigationFocus,
    sidebarSearchQuery,
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
      const trace = (event: StartupMilestone) => {
        if (isTauri()) void recordStartupMilestone(event).catch(() => {});
      };
      trace("tag_reorder_dropped");
      // Show the result of the gesture at once. Waiting for the write and a
      // full snapshot reload leaves the row in its old place for the whole
      // round trip, which reads as the drop snapping back and then jumping.
      setPendingTagOrder(newOrder);
      try {
        const items = newOrder.map((tag, i) => ({ tag, position: i }));
        await reorderChannels(items);
        trace("tag_reorder_written");
        // The order of collections changes the collection list only. Reloading
        // the feed as well rebuilt hundreds of cards right after the drop.
        await loadTaxonomySnapshotState();
        trace("tag_reorder_reloaded");
        scheduleAfterNextPaint(() => trace("tag_reorder_painted"));
      } catch (err) {
        // Dropping the optimistic order restores whatever the vault says, so a
        // failed write never leaves the sidebar claiming an order it does not
        // have.
        console.error("Failed to reorder channels:", err);
      } finally {
        setPendingTagOrder(null);
      }
    },
    [loadTaxonomySnapshotState, orderedTags],
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

  const handleSourceVideoDelete = useCallback(
    async (slug: string) => {
      await deleteSourceVideo(slug);
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

  // The shell already wrote the file and the card; the views only reload.
  const handleSourceVideoDownloaded = useCallback(async () => {
    invalidateRouteSnapshots();
    scheduleRefresh({
      grid: true,
      taxonomy: true,
      previews: true,
    }, 0, { force: true });
    window.dispatchEvent(new Event("vault-refreshed"));
  }, [invalidateRouteSnapshots, scheduleRefresh]);

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
        throw err;
      }
    },
    [invalidateRoutesForTags, scheduleRefresh],
  );

  const handleTextSelectionCreateChannelAndCard = useCallback(
    async (payload: MineTextSelectionDragPayload, tag: string) => {
      const channel = await createChannel(tag);
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
        throw err;
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
          void handleTextSelectionDrop(textSelectionPayload, overId.slice(4)).catch((error) => {
            setSelectionCardError(error instanceof Error ? error.message : "Could not create an element from this selection.");
          });
        }
        clearActiveMineTextSelectionDragPayload();
        return;
      }
      const activeIsTag = activeId.startsWith("tag:");
      const activeSlug = activeData?.type === "block" && activeData.slug
        ? activeData.slug
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

  useStaleDragRecovery(
    activeDragBlocks.length > 0
      || activeDragTag !== null
      || activeDragMediaAsset !== null
      || activeDragTextSelection !== null,
    handleDndCancel,
  );

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
        await deleteBlocks(slugs);
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

  const handleCheckFileName = useCallback(
    (block: LightBlock | IndexedBlock, newStem: string) => checkBlockRename(block.slug, newStem),
    [],
  );

  if (!vaultReady && !loadError) {
    return (
      // Under the tab bar, whose own separator is this page's top line (В43).
      <ChromeShell topEdge={!tabPage}>
        <ChromeRow as="header" separator="bottom"
          data-tauri-drag-region
          className={topChromeSurfaceClass}
        >
          {/* No traffic-light reserve: the window's buttons live in the tab
              bar above this page (SPEC_TABS.md, В43). */}
          <div data-tauri-drag-region className="flex flex-1 items-center px-3" />
          {/* A tab's settings menu lives in its window's tab bar (В43). */}
          {!tabPage && <AppSettingsMenu onSelectSection={handleOpenSettings} />}
        </ChromeRow>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Opening vault…</p>
        </div>
      </ChromeShell>
    );
  }

  const showPreparingLibrary =
    migrationRequired
    && !loadError
    && (isSyncing || (blocks.length === 0 && tags.length === 0 && channels.length === 0));

  // An error takes the feed's place only when the feed has nothing to show:
  // with this route's cards on screen it is a notice over them and the cards
  // stay (SPEC_AUDIT_FIXES.md, Д2.2). A space that did not open has nothing
  // of its own to show, whatever an earlier space left in memory.
  const feedShowsCards = gridRouteSnapshotReady && activeBlocks.length > 0;
  const feedErrors = [
    { key: "indexing", title: "Indexing failed", message: indexingError, notice: indexingNotice },
    { key: "feed", title: "Could not read the feed", message: gridLoadError, notice: gridLoadNotice },
    { key: "collections", title: "Could not read collections", message: taxonomyLoadError, notice: taxonomyLoadNotice },
  ].flatMap(({ message, ...source }) => (message === null ? [] : [{ ...source, message }]));
  const blockingError = openError ?? (feedShowsCards ? null : feedErrors[0]?.message ?? null);
  const feedErrorNotices = openError !== null
    ? []
    : feedErrors.slice(feedShowsCards ? 0 : 1).filter(({ notice }) => notice.open);
  // The space's own notices show in its lead tab only (SPEC_TABS.md, В19);
  // a tab's errors are its own and show wherever they happened.
  const showIndexingNotice = lead && indexingCountNotice.visible && indexingStep !== null;
  const showFirstCardMarker = lead && firstCardSlug !== null;
  const showNotifications = feedErrorNotices.length > 0
    || selectionCardError !== null
    || showFirstCardMarker
    || showIndexingNotice;

  const metadataRowOf = (part: "both" | "content") => mainSecondaryTopBarVisible ? (
    <MainSecondaryTopBar
          part={part}
          sidebarCollapsed={sidebarCollapsed}
          sidebarResizing={sidebarResizing}
          onCreateCollection={beginCreateCollection}
          collectionCount={sidebarSearchQuery.trim()
            ? filterSidebarTags(orderedTags, sidebarSearchQuery).length
            : orderedTags.length}
          stats={vaultStats}
          cloudPending={blocks.filter((item) => item.content_in_cloud).length}
          indexing={isSyncing}
          onRevealSpace={() => void revealItemInDir(vaultPath)}
          detailBlock={renderedDetailBlock}
          detailEntered={compactDetailChromeEntered}
          viewMode={mainViewMode}
          onViewModeChange={handleMainViewModeChange}
          vaultPath={vaultPath}
          tags={orderedTags}
          currentTag={currentTag}
          onToggleTag={handleToggleTag}
          onCreateAndAssign={handleCreateTagFromMenu}
          onRequestRename={setRenamingBlock}
          onRenameFile={handleRenameBlock}
          onCheckFileName={handleCheckFileName}
          onRequestDelete={requestDeleteBlock}
          onDetailClose={handleDetailClose}
          detailMenuOpenRequestSequence={compactDetailTopMenuRequestSequence}
          placement={metadataRowAtBottom ? "bottom" : "top"}
          selectionActive={hasSelection}
          selectionHostRef={setSelectionCommandsHost}
        />
  ) : null;
  const metadataRow = metadataRowOf("both");

  return (
    // Cards tell a preview still being built from a lost file (SPEC_CARD_MEDIA_GEOMETRY.md).
    <PreviewsPendingContext.Provider value={previewsPending}>
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarPointerWithin}
      autoScroll={{ canScroll: (el) => el.hasAttribute("data-sidebar-scroll") }}
      onDragStart={handleDndStart}
      onDragEnd={handleDndEnd}
      onDragCancel={handleDndCancel}
    >
    <ChromeShell
      // Under the tab bar, whose own separator is this page's top line (В43).
      topEdge={!tabPage}
      style={{ minWidth: APP_MIN_WIDTH_PX }}
    >
      {/* Top toolbar */}
      <ChromeRow as="header" separator="bottom"
        ref={setTopRowHost}
        data-tauri-drag-region
        className={topChromeSurfaceClass}
      >
        <div
          data-tauri-drag-region
          data-app-top-sidebar-segment=""
          className={cn(
            "flex h-full shrink-0 items-center overflow-hidden",
            !sidebarCollapsed && "border-r border-sidebar-border",
            sidebarCollapsed && "w-auto max-w-[240px]",
            !sidebarResizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
          )}
          style={sidebarCollapsed ? undefined : { width: "var(--sidebar-width)" }}
        >
          {/* The row starts with the space switcher: the traffic lights and
              the sidebar button live in the window's tab bar above this page
              (SPEC_TABS.md, В43, РП6). */}
          <div
            ref={sidebarRowRef}
            className={cn(
              "flex h-full min-w-0",
              sidebarCollapsed ? "flex-none" : "flex-1",
            )}
            data-top-chrome-space-search-group=""
            data-row-fit={sidebarCollapsed ? undefined : sidebarRowFit}
          >
            <VaultSwitcher
              currentPath={vaultPath}
              onVaultSelected={(path) => {
                navigate("/", { replace: true });
                onVaultSelected(path);
              }}
              onOpenInNewTab={tabPage ? openSpaceInNewTab : undefined}
              surface="topChrome"
              topChromeCollapsed={sidebarCollapsed}
              joinsNext={sidebarCollapsed}
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
                    // Empty, the field is chrome like the rest of the row; a
                    // query gives it the table's surface (05.10.2026).
                    "flex h-full min-w-0 flex-1 items-center",
                    sidebarSearchHasValue ? "bg-sidebar" : "bg-chrome",
                  ].filter(Boolean).join(" ")}
                  data-sidebar-top-search-surface=""
                >
                  <Input
                    ref={sidebarSearchInputRef}
                    {...SEARCH_INPUT_SUPPRESSION_PROPS}
                    aria-label="Find or create collection"
                    aria-activedescendant={
                      sidebarSearchKeyboardNavigationFocus
                        ? sidebarRowDomId(sidebarSearchKeyboardNavigationFocus.rowKey)
                        : undefined
                    }
                    placeholder="Find or create..."
                    // Overflowing text at the field's right edge dissolves, it
                    // is not cut: a narrow panel used to slice the placeholder
                    // through the middle of a letter. The field alone takes the
                    // fade, so the clear button beside it stays whole. Same
                    // curve the sidebar rows use (DESIGN_SYSTEM.md, «Растворение
                    // кромок»).
                    style={SIDEBAR_SEARCH_MASK_STYLE}
                    variant="ghost"
                    value={sidebarSearchQuery}
                    onChange={(event) => handleSidebarSearchChange(event.target.value)}
                    onKeyDown={handleSidebarSearchKeyDown}
                    className="h-full min-w-0 flex-1 rounded-0 bg-transparent px-3 py-0 font-mono text-sm text-muted-foreground placeholder:text-muted-foreground"
                    data-sidebar-top-search=""
                  />
                  {sidebarSearchHasValue && (
                    // A chrome icon button like its neighbours: the plate on
                    // hover (05.10.2026, instead of the glyph-only exception).
                    <Button
                      type="button"
                      variant="chrome"
                      size="chrome-icon"
                      aria-label="Clear collection search"
                      // The filter's actions follow it; at the foot-row
                      // layout the clear button ends the row, 8px in.
                      className={metadataRowAtBottom ? "mr-2" : "mr-1"}
                      onClick={handleClearSidebarSearch}
                      data-sidebar-top-search-clear=""
                    >
                      <X aria-hidden="true" />
                    </Button>
                  )}
                  {/* The sidebar column has no third row (03.10.2026): what lived
                      over the table lives here, at the filter's right. At the
                      foot of the window the metadata row still carries it. */}
                  {!metadataRowAtBottom && (
                    // Icon buttons 4px apart, 8px from the column's line.
                    <div className="mr-2 flex shrink-0 items-center gap-1" data-sidebar-top-search-actions="">
                      <ActivityIndicators
                        cloudPending={blocks.filter((item) => item.content_in_cloud).length}
                        indexing={isSyncing}
                        onRevealSpace={() => void revealItemInDir(vaultPath)}
                      />
                      <Button
                        type="button"
                        variant="chrome"
                        size="chrome-icon"
                        plate="raised"
                        aria-label="New Collection"
                        shortcut={commandById("new-collection").combo}
                        onClick={beginCreateCollection}
                        data-sidebar-new-collection=""
                      >
                        <Plus />
                      </Button>
                    </div>
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
            onNavigate={handleTopCollectionNavigate}
            onCreateCollection={handleTopCollectionCreate}
            joinsPrevious={sidebarCollapsed}
            joinsNext={foldedMetadataRow}
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
          ) : foldedMetadataRow ? (
            metadataRowOf("content")
          ) : (
            <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
          )}
          {/* A tab's settings menu lives in its window's tab bar (В43). */}
          {!tabPage && <AppSettingsMenu onSelectSection={handleOpenSettings} />}
        </div>
      </ChromeRow>



      {/* Body: sidebar + main. Positioned for the resize handle's catch, which
          takes the body's height and so stops above the bottom bar. */}
      <div className="relative flex min-h-0 flex-1">
      <Sidebar
        onOpenElsewhere={tabPage ? handleOpenRouteElsewhere : undefined}
        width={sidebarWidth}
        previewsPending={previewsPending}
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
        onCreateChannel={createCollection}
        onCheckCollectionName={checkCollectionName}
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
          <VaultConflictsBanner vaultReady={vaultReady} />
        }
        linkedBlockSlug={renderedLinkedBlockSlug}
        linkedTags={renderedLinkedTags}
        onToggleLinkedTag={handleToggleTag}
        onBatchSetTag={handleBatchSetTag}
        detailChromeClosing={detailChromeClosing}
        scrollEdgeFade={scrollEdgeFade}
      />

      {/* A collapsed panel has no line to grab: the sidebar button opens it. */}
      {!sidebarCollapsed && (
        <SidebarResizeHandle
          isResizing={sidebarResizing}
          topRowHost={topRowHost}
          width={sidebarWidth}
          minWidth={sidebarMinWidthPx}
          maxWidth={sidebarMaxWidthPx}
          disabled={
            activeDragBlock !== null
            || activeDragMediaAsset !== null
            || activeDragTag !== null
            || activeDragTextSelection !== null
          }
          onResizeStart={startResize}
          onResizeUpdate={updateResize}
          onResizeEnd={endResize}
          onResizeTo={resizeSidebarTo}
        />
      )}

      <main
        ref={mainRef}
        className="relative isolate min-h-0 flex-1 overflow-hidden"
        style={{ minWidth: APP_MAIN_MIN_WIDTH_PX }}
      >
        {blockingError !== null && (
          <div className="flex h-full items-center justify-center p-8" data-feed-error-block="">
            <p className="text-sm text-destructive">{blockingError}</p>
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
                onKeyboardFocusChange={reportKeyboardFocus}
                onCardMenuShortcutChange={reportCardMenuCommand}
                onSelectionCommandChange={reportSelectionCommand}
                selectionCommandsHost={selectionCommandsHost}
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
                onOpenBlockElsewhere={tabPage ? handleOpenBlockElsewhere : undefined}
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
                onInstallClipper={revealClipperExtensionFolder}
                spaceOnboardingOwed={spaceOnboardingOwed}
                firstIndexProgress={isSyncing ? syncProgress : null}
                vaultIndexing={isSyncing || indexRereadAfterLoadId !== null}
                onScrollPositionChange={handleScrollPositionChange}
                restoreScrollAnchor={scrollRestoreAnchor}
                onScrollAnchorRestored={handleScrollAnchorRestored}
              />
            }
          >
            <Route index element={<AllBlocksPage />} />
            <Route path="channel/:tag" element={<ChannelPage />} />
          </Route>
        </Routes>

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
              onDeleteSourceVideo={handleSourceVideoDelete}
              onSourceVideoDownloaded={handleSourceVideoDownloaded}
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

      {/* Dev button styles: which style a switch turned on. */}
      <ButtonStyleNotice />

      {/* Keep Downloaded is advice about the space: its lead tab gives it (В19). */}
      {lead && <CloudRecommendation vaultPath={vaultPath} refreshToken={cloudAdviceToken} />}

      {showNotifications && (
        <NotificationAnchor>
          <div className="grid justify-items-end gap-2">
            {feedErrorNotices.map(({ key, title, message, notice }) => (
              <NotificationCard key={key} title={title} onClose={notice.dismiss}>
                <p className="text-sm text-destructive" data-feed-error-notice={key}>{message}</p>
              </NotificationCard>
            ))}
            {selectionCardError !== null && (
              // An action's failure, never the feed's state: a notice whether
              // or not the feed shows cards.
              <NotificationCard title="Could not create an element" onClose={() => setSelectionCardError(null)}>
                <p className="text-sm text-destructive" data-feed-error-notice="selection-card">
                  {selectionCardError}
                </p>
              </NotificationCard>
            )}
            {showIndexingNotice && indexingStep !== null && (
              // The opening counts out loud in the corner (О13): one card,
              // notes and then previews. A folder whose feed is still empty
              // may be the wrong one: it opened without a confirmation, so
              // the way out sits next to its count (О12).
              <IndexingProgress
                spaceName={vaultPath.replace(/\/+$/, "").split("/").pop() ?? vaultPath}
                step={indexingStep}
                onClose={closeIndexingNotice}
                onChooseAnother={blocks.length === 0 ? () => void handleSwitchVault() : undefined}
              />
            )}
            {showFirstCardMarker && firstCardSlug !== null && (
              <FirstCardMarkerCard
                fileName={`${firstCardSlug.split("/").pop() ?? firstCardSlug}.md`}
                onReveal={() => {
                  void revealItemInDir(`${vaultPath}/${firstCardSlug}.md`);
                  setFirstCardSlug(null);
                }}
                onClose={() => setFirstCardSlug(null)}
              />
            )}
          </div>
        </NotificationAnchor>
      )}

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

      {/* Alt 2: the metadata row lands here, directly under the content it
          describes, and takes the place of the button bar rather than sitting
          above it. */}
      {metadataRowAtBottom && metadataRow}

      {!bottomActionBarHidden && !metadataRowAtBottom && (
        <ChromeRow separator="top"
          // Stands under the sidebar column, so it follows the chrome edge pad:
          // the app-wide rhythm in the primary design, 16px in alt, where the
          // sidebar rows are already on 16 and these buttons must line up under
          // them. Symmetric on both sides — a bar whose two ends obey different
          // rules reads as a layout mistake.
          ref={bottomBarRef}
          className="gap-2 bg-accent px-[var(--chrome-edge-pad)]"
          data-bottom-action-bar=""
        >
          {/* Same command as the View menu item and the two-finger swipe. It
              leads because it changes the shape of the window itself. */}
          <span
            data-bar-entry="toggle-sidebar"
            className="inline-flex shrink-0 items-center"
            style={hiddenBarEntries.has("toggle-sidebar") ? { display: "none" } : undefined}
          >
            <ActionButton chrome hotkey={commandById("toggle-sidebar").combo} onClick={toggleCollapsed}>
              {sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar"}
            </ActionButton>
          </span>
          {/* The new collection is named in the sidebar list: with the sidebar
              hidden there is nowhere to name it, so the command leaves the bar. */}
          {!sidebarCollapsed && (
            <span
              data-bar-entry="new-collection"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("new-collection") ? { display: "none" } : undefined}
            >
              <ActionButton chrome hotkey={commandById("new-collection").combo} onClick={beginCreateCollection}>
                {commandById("new-collection").name}
              </ActionButton>
            </span>
          )}
          {/* A command appears only while it can be used, and contextual
              entries only append at the end of the group — what the user has
              already seen never shifts. During a selection the bar narrows to
              the selection's own commands: navigation and Focus leave, esc
              arrives. */}
          {orderedTags.length > 0 && !sidebarCollapsed && !hasSelection && (
            <span
              data-bar-entry="switch-collection"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("switch-collection") ? { display: "none" } : undefined}
            >
              <ActionButton chrome hotkey={commandById("switch-collection").combo} readOnly>
                {commandById("switch-collection").name}
              </ActionButton>
            </span>
          )}
          {activeBlocks.length > 0 && renderedDetailBlock === null && !hasSelection && (
            <span
              data-bar-entry="navigate"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("navigate") ? { display: "none" } : undefined}
            >
              <ActionButton chrome hotkey={commandById("navigate").combo} readOnly>
                {commandById("navigate").name}
              </ActionButton>
            </span>
          )}
          {hasFocusedItem && !hasSelection && (
            <span
              data-bar-entry="open-focused"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("open-focused") ? { display: "none" } : undefined}
            >
              <ActionButton
                chrome
                hotkey={commandById("open-focused").combo}
                onClick={() => activateFocusedRef.current?.()}
              >
                {commandById("open-focused").name}
              </ActionButton>
            </span>
          )}
          {/* Pressable: the menu opens at the focused element — in the feed at
              its card, over an open element in its top menu. The chord shown
              is the one that opens this menu here: each surface's command
              has its own binding (Ф11). */}
          {(renderedDetailBlock !== null || feedCardMenuAvailable) && (
            <span
              data-bar-entry="element-menu"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("element-menu") ? { display: "none" } : undefined}
            >
              <ActionButton
                chrome
                hotkey={barMenuCommand.combo}
                onClick={() => {
                  if (renderedDetailBlock) {
                    setCompactDetailTopMenuRequestSequence((current) => current + 1);
                    return;
                  }
                  cardMenuActivateRef.current?.();
                }}
              >
                {barMenuCommand.name}
              </ActionButton>
            </span>
          )}
          {renderedDetailBlock !== null && (
            <span
              data-bar-entry="close-element"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("close-element") ? { display: "none" } : undefined}
            >
              <ActionButton
                chrome
                hotkey={commandById("close-element").combo}
                onClick={handleDetailClose}
              >
                {commandById("close-element").name}
              </ActionButton>
            </span>
          )}
          {hasSelection && renderedDetailBlock === null && (
            <span
              data-bar-entry="clear-selection"
              className="inline-flex shrink-0 items-center"
              style={hiddenBarEntries.has("clear-selection") ? { display: "none" } : undefined}
            >
              <ActionButton
                chrome
                hotkey={commandById("clear-selection").combo}
                onClick={() => selectionClearRef.current?.()}
              >
                {commandById("clear-selection").name}
              </ActionButton>
            </span>
          )}
          <div className="flex-1" data-bar-spacer="" />
          <span
            data-bar-entry="find-elements"
            className="inline-flex shrink-0 items-center"
            style={hiddenBarEntries.has("find-elements") ? { display: "none" } : undefined}
          >
            <ActionButton
              chrome
              hotkey={commandById("find-elements").combo}
              onClick={toggleSearchOverlay}
            >
              {commandById("find-elements").name}
            </ActionButton>
          </span>
          {/* Settings sits at the far edge: the rarest command must not spend
              the bar's best real estate. */}
          <span
            data-bar-entry="settings"
            className="inline-flex shrink-0 items-center"
            style={hiddenBarEntries.has("settings") ? { display: "none" } : undefined}
          >
            <ActionButton chrome hotkey={commandById("settings").combo} onClick={() => handleOpenSettings()}>
              {commandById("settings").name}
            </ActionButton>
          </span>
        </ChromeRow>
      )}

      <CreateCollectionDialog
        open={isNamingCollection}
        onOpenChange={setIsNamingCollection}
        onCreate={handleCreateChannel}
      />

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
    </ChromeShell>

    <DragOverlay
      dropAnimation={overlayDressing === "row" ? tagRowDropAnimation() : null}
      modifiers={overlayDressing === "row" ? TAG_ROW_OVERLAY_MODIFIERS : POINT_OVERLAY_MODIFIERS}
      style={{ pointerEvents: "none" }}
    >
      {activeDragBlocks.length > 0 && (
        <DragCardStackPreview
          blocks={renderedDragBlocks}
          thumbVersions={feedThumbVersions}
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
          previewsPending={previewsPending}
        />
      )}
    </DragOverlay>
    </DndContext>
    </PreviewsPendingContext.Provider>
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
  onOpenBlockElsewhere?: (block: LightBlock, newWindow: boolean) => void;
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
  /// How to open what the active view has focused, or null when nothing is.
  onKeyboardFocusChange: (activate: (() => void) | null) => void;
  onCardMenuShortcutChange: (activate: (() => void) | null) => void;
  onSelectionCommandChange: (clear: (() => void) | null) => void;
  selectionCommandsHost: HTMLElement | null;
  /// Offered by the empty-space onboarding, which is the only place in the app
  /// that can introduce the clipper to someone who has never seen it.
  onInstallClipper: () => void;
  spaceOnboardingOwed: boolean | null;
  firstIndexProgress: { processed: number; total: number } | null;
  vaultIndexing: boolean;
  /// The tab's memory of the feed's scroll (SPEC_TABS.md, В31, В40).
  onScrollPositionChange: (read: () => ScrollAnchor | null) => void;
  restoreScrollAnchor: ScrollAnchor | null;
  onScrollAnchorRestored: () => void;
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
