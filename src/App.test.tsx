import { commandById, setCommandOverrides } from "@/lib/commandRegistry";
import { reloadFeedDisplay, setFeedSort } from "@/lib/feedDisplay";
import { reportCardsRendered } from "@/lib/startup";
import { isTabVisible, setTabVisible } from "@/lib/tabVisibility";
import { TAB_VIEW_REPORT_DEBOUNCE_MS } from "@/lib/tabPage";
import { useThumbnailUpgrade } from "@/hooks/useThumbnailUpgrade";
import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { isTauri } from "@tauri-apps/api/core";

import type { ChannelDto, DeleteBlockPlan, GridSnapshot, IndexedBlock, LightBlock, SidebarLayout, TabBootstrap, TabView, TaxonomySnapshot, VaultOpenResult, VaultStats } from "@/types";
import { App, AppWithVault } from "./App";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";
import { SEARCH_OVERLAY_RECENT_LIMIT, SEARCH_OVERLAY_RESULT_LIMIT } from "@/components/SearchOverlay";
import { INDEXING_NOTICE_DELAY_MS } from "@/components/IndexingProgress";

// The search overlay shares the list_grid_blocks command: recent mode passes
// SEARCH_OVERLAY_RECENT_LIMIT without a query, query mode passes a query string
// with SEARCH_OVERLAY_RESULT_LIMIT. Grid-load mocks must serve those calls
// without asserting the grid-load contract (offset 0 / limit multiple of 200 /
// no query) — a thrown assertion inside the mock surfaces as an unhandled
// rejection in whatever test is running when the overlay's async query lands,
// which is a flake. The signature is matched exactly on both fields so a grid
// regression that starts passing a query is NOT silently absorbed here
// (SEARCH_OVERLAY_RESULT_LIMIT equals GRID_PAGE_SIZE): a query-mode call must
// also carry the overlay's result limit, and a recent-mode call its recent
// limit, otherwise it falls through to the strict grid assertions.
function isSearchOverlayQuery(limit: number, query?: string): boolean {
  // The feed passes its order in the same position the search mock uses for
  // its text; an order is not a search.
  const searchText = query === "newest" || query === "oldest" ? undefined : query;
  return (
    (searchText !== undefined && limit === SEARCH_OVERLAY_RESULT_LIMIT) ||
    (searchText === undefined && limit === SEARCH_OVERLAY_RECENT_LIMIT)
  );
}

function gridSnapshot(
  blocks: LightBlock[],
  total = blocks.length,
  hasMore = false,
  generation = 1,
): GridSnapshot {
  return { generation, blocks, total_blocks: total, has_more: hasMore };
}

const commandMocks = vi.hoisted(() => ({
  getGridRows: vi.fn(),
  getVaultPath: vi.fn<() => Promise<string | null>>(),
  openVault: vi.fn<(path: string) => Promise<VaultOpenResult>>(),
  startVaultSync: vi.fn<() => Promise<boolean>>(),
  recordStartupMilestone: vi.fn<(event: string) => Promise<void>>(),
  startStartupMaintenance: vi.fn<() => Promise<boolean>>(),
  sweepVaultThumbnails: vi.fn<() => Promise<number>>(),
  listGridBlocks: vi.fn<(tag?: string, offset?: number, limit?: number, query?: string) => Promise<GridSnapshot>>(),
  createBlock: vi.fn(async () => ({}) as IndexedBlock),
  readClipboardPayload: vi.fn(async () => ({ kind: "empty" }) as const),
  listTaxonomySnapshot: vi.fn<() => Promise<TaxonomySnapshot>>(),
  getVaultStats: vi.fn<(currentCollection?: string | null) => Promise<VaultStats>>(),
  createChannel: vi.fn<(tag: string) => Promise<ChannelDto>>(),
  reorderChannels: vi.fn(async (_items: { tag: string; position: number }[]) => undefined),
  renameBlockFile: vi.fn(),
  prepareDeleteBlock: vi.fn<(slug: string) => Promise<DeleteBlockPlan>>(),
  deleteBlock: vi.fn<(slug: string, deleteUnusedMedia?: boolean) => Promise<boolean>>(),
  deleteBlocks: vi.fn<(slugs: string[]) => Promise<number>>(),
  mergeBlocks: vi.fn<(orderedSlugs: string[]) => Promise<unknown>>(),
  getBlock: vi.fn(),
  extractInlineMedia: vi.fn(),
  extractTextSelection: vi.fn(),
  deleteTextSelection: vi.fn(),
  openSettingsWindow: vi.fn<() => Promise<void>>(async () => {}),
  // The page as a tab (SPEC_TABS.md, «Команды»).
  getTabBootstrap: vi.fn<() => Promise<TabBootstrap | null>>(async () => null),
  reportTabView: vi.fn<(view: TabView) => Promise<void>>(async () => {}),
  reportTabHistory: vi.fn<(back: boolean, forward: boolean) => Promise<void>>(async () => {}),
  tabPainted: vi.fn<() => Promise<void>>(async () => {}),
  setWindowSidebar: vi.fn<(sidebar: SidebarLayout) => Promise<void>>(async () => {}),
  startWindowDrag: vi.fn<() => Promise<void>>(async () => {}),
  reportWindowSurface: vi.fn<(color: string) => Promise<void>>(async () => {}),
  dismissSpaceNotice: vi.fn<(notice: string) => Promise<void>>(async () => {}),
  spaceNoticeDismissed: vi.fn<(notice: string) => Promise<boolean>>(async () => false),
  newTab: vi.fn<(vaultId?: string) => Promise<void>>(async () => {}),
  activateAdjacentTab: vi.fn<(forward: boolean) => Promise<void>>(async () => {}),
}));

const sidebarResizeState = vi.hoisted(() => ({
  width: 300,
  collapsed: false,
  isResizing: false,
  toggleCollapsed: vi.fn(),
  // The window's sidebar the app handed the hook last (SPEC_TABS.md, В56).
  windowSidebar: undefined as { width_px: number; collapsed: boolean } | null | undefined,
}));

const clipboardWriteText = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: clipboardWriteText }));
const webClipboardWriteText = vi.fn<(text: string) => Promise<void>>();

vi.mock("@/lib/commands", () => ({
  cloudRecommendationState: vi.fn(async () => ({ due: false })),
  dismissCloudRecommendation: vi.fn(async () => null),
  firstCardMarkerPending: vi.fn(async () => false),
  spaceOnboardingPending: vi.fn(async () => true),
  completeFirstCardMarker: vi.fn(async () => null),
  getVaultPath: commandMocks.getVaultPath,
  getUnavailableVault: vi.fn(async () => null),
  listSpaces: vi.fn(async () => []),
  forgetUnavailableVault: vi.fn(async () => null),
  createBlock: commandMocks.createBlock,
  readClipboardPayload: commandMocks.readClipboardPayload,
  openVault: commandMocks.openVault,
  selectVault: vi.fn(),
  startVaultSync: commandMocks.startVaultSync,
  recordStartupMilestone: commandMocks.recordStartupMilestone,
  startStartupMaintenance: commandMocks.startStartupMaintenance,
  sweepVaultThumbnails: commandMocks.sweepVaultThumbnails,
  listGridBlocks: commandMocks.listGridBlocks,
  getGridRows: commandMocks.getGridRows,
  searchGridBlocks: async (tag: string | undefined, query: string, limit: number) => {
    const grid = await commandMocks.listGridBlocks(tag, 0, limit, query);
    return {
      generation: grid.generation,
      search_generation: 1,
      blocks: grid.blocks,
      has_more: grid.has_more,
      next_cursor: null,
      cursor_reset: false,
    };
  },
  listTaxonomySnapshot: commandMocks.listTaxonomySnapshot,
  getVaultStats: commandMocks.getVaultStats,
  createChannel: commandMocks.createChannel,
  reorderChannels: commandMocks.reorderChannels,
  deleteChannel: vi.fn(),
  reorderCollections: vi.fn(),
  renameChannel: vi.fn(),
  checkCollectionName: vi.fn(async () => null),
  renameBlockFile: commandMocks.renameBlockFile,
  deleteTagFromAll: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  prepareDeleteBlock: commandMocks.prepareDeleteBlock,
  deleteBlock: commandMocks.deleteBlock,
  deleteBlocks: commandMocks.deleteBlocks,
  mergeBlocks: commandMocks.mergeBlocks,
  getBlock: commandMocks.getBlock,
  extractInlineMedia: commandMocks.extractInlineMedia,
  extractTextSelection: commandMocks.extractTextSelection,
  deleteTextSelection: commandMocks.deleteTextSelection,
  openSettingsWindow: commandMocks.openSettingsWindow,
  getTabBootstrap: commandMocks.getTabBootstrap,
  reportTabView: commandMocks.reportTabView,
  reportTabHistory: commandMocks.reportTabHistory,
  tabPainted: commandMocks.tabPainted,
  setWindowSidebar: commandMocks.setWindowSidebar,
  startWindowDrag: commandMocks.startWindowDrag,
  reportWindowSurface: commandMocks.reportWindowSurface,
  dismissSpaceNotice: commandMocks.dismissSpaceNotice,
  spaceNoticeDismissed: commandMocks.spaceNoticeDismissed,
  newTab: commandMocks.newTab,
  activateAdjacentTab: commandMocks.activateAdjacentTab,
}));

vi.mock("@/lib/articleAudioDesktopGateway", () => ({
  desktopArticleAudioGateway: {
    getState: vi.fn(),
    generate: vi.fn(),
    remove: vi.fn(),
    setPosition: vi.fn(),
    resolvePlaybackSource: vi.fn(() => null),
    subscribe: vi.fn(async () => vi.fn()),
  },
}));

vi.mock("@/hooks/useSidebarResize", () => ({
  useSidebarResize: (windowSidebar: { width_px: number; collapsed: boolean } | null = null) => {
    sidebarResizeState.windowSidebar = windowSidebar;
    return {
      width: sidebarResizeState.width,
      collapsed: sidebarResizeState.collapsed,
      isResizing: sidebarResizeState.isResizing,
      startResize: vi.fn(),
      updateResize: vi.fn(),
      endResize: vi.fn(),
      toggleCollapsed: sidebarResizeState.toggleCollapsed,
    };
  },
}));

vi.mock("@/hooks/useThumbnailUpgrade", () => ({
  useThumbnailUpgrade: vi.fn(),
}));

vi.mock("@/hooks/useChannelPreviewsEvents", () => ({
  useChannelPreviewsEvents: () => ({
    channelPreviews: new Map(),
    refresh: vi.fn().mockResolvedValue(undefined),
    bumpThumbVersion: vi.fn(),
  }),
}));

vi.mock("@/components/VaultPicker", () => ({
  VaultPicker: () => <div>Vault Picker</div>,
}));

vi.mock("@/components/VaultSwitcher", () => ({
  VaultSwitcher: ({
    currentPath,
    surface = "actionBar",
    topChromeCollapsed = false,
    joinsNext = false,
    onOpenInNewTab,
  }: {
    currentPath: string;
    surface?: string;
    topChromeCollapsed?: boolean;
    joinsNext?: boolean;
    onOpenInNewTab?: (vaultId: string) => void;
  }) => (
    <>
      <button
        type="button"
        data-vault-switcher=""
        data-vault-switcher-surface={surface}
        data-vault-switcher-top-chrome-collapsed={String(topChromeCollapsed)}
        data-vault-switcher-joins-next={String(joinsNext)}
      >
        {currentPath.split("/").pop() ?? currentPath}
      </button>
      {onOpenInNewTab && (
        <button type="button" onClick={() => onOpenInNewTab("other-space-id")}>
          Open other space in a new tab
        </button>
      )}
    </>
  ),
}));

vi.mock("@/components/SidebarResizeHandle", () => ({
  SidebarResizeHandle: () => null,
}));

// The feed scrolled to its end: like the real Grid there, the mock asks for the
// next page whenever there is more and nothing is loading.
const gridScroll = vi.hoisted(() => ({ atEnd: false }));

vi.mock("@/components/Grid", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  function MockGrid({
    blocks,
    currentTag,
    routeSnapshotReady,
    detailOpen,
    keyboardNavigationDisabled,
    restoreFocusSlug,
    restoreFocusSequence,
    thumbVersions,
    onBlockClick,
    onGroupSelectionStart,
    onSelectionCommandChange,
    onCardMenuShortcutChange,
    hasMoreBlocks,
    loadingMoreBlocks,
    onLoadMoreBlocks,
    vaultIndexing,
    restoreScrollAnchor,
    onScrollAnchorRestored,
    onScrollPositionChange,
  }: {
    restoreScrollAnchor?: { slug: string; offset_px: number } | null;
    onScrollAnchorRestored?: () => void;
    onScrollPositionChange?: (read: () => { slug: string; offset_px: number } | null) => void;
    blocks: LightBlock[];
    currentTag?: string;
    routeSnapshotReady?: boolean;
    detailOpen?: boolean;
    keyboardNavigationDisabled?: boolean;
    restoreFocusSlug?: string | null;
    restoreFocusSequence?: number;
    thumbVersions?: ReadonlyMap<string, number>;
    onBlockClick: (block: LightBlock) => void;
    onGroupSelectionStart?: () => void;
    onSelectionCommandChange?: (clear: (() => void) | null) => void;
    onCardMenuShortcutChange?: (activate: (() => void) | null) => void;
    hasMoreBlocks?: boolean;
    loadingMoreBlocks?: boolean;
    onLoadMoreBlocks?: () => void;
    vaultIndexing?: boolean;
  }) {
    useEffect(() => {
      if (!gridScroll.atEnd || !hasMoreBlocks || loadingMoreBlocks || !onLoadMoreBlocks) return;
      onLoadMoreBlocks();
    }, [blocks.length, hasMoreBlocks, loadingMoreBlocks, onLoadMoreBlocks]);
    return (
      <div>
        <div data-testid="grid">{`${currentTag ?? "__all__"}:${blocks.length}`}</div>
        <div data-testid="grid-indexing">{String(Boolean(vaultIndexing))}</div>
        <div data-testid="grid-scroll-restore">
          {restoreScrollAnchor ? `${restoreScrollAnchor.slug}:${restoreScrollAnchor.offset_px}` : "none"}
        </div>
        <button type="button" onClick={() => onScrollAnchorRestored?.()}>
          Finish scroll restore
        </button>
        <button
          type="button"
          onClick={() => onScrollPositionChange?.(() => ({ slug: "beta-block", offset_px: 12 }))}
        >
          Scroll feed
        </button>
        <div data-testid="grid-slugs">{blocks.map((item) => item.slug).join(",")}</div>
        <button type="button" onClick={() => onLoadMoreBlocks?.()}>
          Load more blocks
        </button>
        <div data-testid="grid-route-ready">{String(Boolean(routeSnapshotReady))}</div>
        <div data-testid="grid-detail-open">{String(Boolean(detailOpen))}</div>
        <div data-testid="grid-keyboard-disabled">{String(Boolean(keyboardNavigationDisabled))}</div>
        <div data-testid="grid-restore">{`${restoreFocusSlug ?? "none"}:${restoreFocusSequence ?? 0}`}</div>
        <div data-testid="grid-thumb-versions">
          {blocks.map((item) => `${item.slug}=${thumbVersions?.get(item.slug) ?? 0}`).join(",")}
        </div>
        <div data-testid="grid-previews">{blocks.map((item) => `${item.slug}:${item.preview_manifest ?? "none"}:${item.width ?? 0}`).join(",")}</div>
        <button type="button" onClick={() => onGroupSelectionStart?.()}>
          Start group selection
        </button>
        <button
          type="button"
          onClick={() => onSelectionCommandChange?.(() => onSelectionCommandChange?.(null))}
        >
          Report selection
        </button>
        <button type="button" onClick={() => onCardMenuShortcutChange?.(() => {})}>
          Report card menu
        </button>
        {blocks.map((item) => (
          <div key={`${item.slug}-title`} data-testid={`grid-title-${item.slug}`}>
            {item.title ?? item.slug}
          </div>
        ))}
        {blocks.map((item) => (
          <button key={item.slug} type="button" onClick={() => onBlockClick(item)}>
            {`Open ${item.slug}`}
          </button>
        ))}
      </div>
    );
  }
  return { Grid: MockGrid };
});

vi.mock("@/components/GraphView", () => ({
  GraphView: ({ currentCollection }: { currentCollection?: string }) => (
    <div data-testid="graph-view">{currentCollection ?? "__all__"}</div>
  ),
}));

vi.mock("@/components/Detail", () => ({
  Detail: ({
    block,
    topChromeMode,
    onClose,
    onRequestDelete,
  }: {
    block: LightBlock | IndexedBlock;
    topChromeMode?: "classic" | "external";
    onClose: () => void;
    onRequestDelete: (slug: string) => void;
  }) => (
    <div
      role="dialog"
      aria-label={`${block.slug}.md`}
      data-detail-root
      data-detail-top-chrome-mode={topChromeMode ?? "classic"}
    >
      <div data-testid="detail-title">{block.title ?? block.slug}</div>
      {topChromeMode !== "external" && (
        <button type="button" onClick={onClose}>
          Close
        </button>
      )}
      <button type="button" onClick={() => onRequestDelete(block.slug)}>
        Delete detail
      </button>
    </div>
  ),
}));

vi.mock("@/components/ImportDialog", () => ({
  ImportDialog: () => null,
}));

vi.mock("@/components/DropZone", () => ({
  DropZone: () => null,
}));

vi.mock("@/components/ActionButton", () => ({
  ActionButton: ({
    children,
    onClick,
    hotkey,
    isSelected,
  }: {
    children: ReactNode;
    onClick?: () => void;
    hotkey?: string;
    isSelected?: boolean;
  }) => (
    <button
      type="button"
      data-action-selected={isSelected ? "true" : undefined}
      onClick={onClick}
    >
      {hotkey ? `${hotkey} ` : null}
      {children}
    </button>
  ),
}));

vi.mock("@/components/Sidebar", async () => {
  const { Link } = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    Sidebar: ({
      orderedTags,
      totalBlocks,
      searchQuery = "",
      topRow = null,
    }: {
      orderedTags: Array<{ tag: string; count: number }>;
      totalBlocks: number;
      searchQuery?: string;
      topRow?: ReactNode;
    }) => {
      const normalizedSearchQuery = searchQuery.trim().toLowerCase();
      const showEverything = !normalizedSearchQuery
        || "everything".includes(normalizedSearchQuery)
        || "__all__".includes(normalizedSearchQuery);

      return (
        <nav data-sidebar-mock="">
          {topRow}
          {showEverything && <Link to="/">Everything {totalBlocks}</Link>}
          {orderedTags
            .filter((tag) => !normalizedSearchQuery || tag.tag.toLowerCase().includes(normalizedSearchQuery))
            .map((tag) => (
              <Link key={tag.tag} to={`/channel/${encodeURIComponent(tag.tag)}`}>
                {tag.tag}
              </Link>
            ))}
        </nav>
      );
    },
  };
});

function block(id: number, slug: string): LightBlock {
  return {
    id,
    slug,
    card_kind: "article",
    block_type: "article",
    title: slug,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-04-17T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `${slug} body`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: [],
    feed_playback: null,
  };
}

function indexedBlock(id: number, slug: string, title = slug): IndexedBlock {
  return {
    ...block(id, slug),
    title,
    description: null,
    source: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
  };
}

function vaultOpenResult(overrides: Partial<VaultOpenResult> = {}): VaultOpenResult {
  return {
    indexed: 2,
    sync_in_progress: false,
    derived_store_ready: true,
    bootstrapped_from_legacy: false,
    migration_required: false,
    thumbs_root: "/derived/thumbs",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Bottom-bar entries put the keystroke and the label in separate nodes, so a
// text query does not resolve them; the entry is matched on its full text.
function bottomBarEntry(label: string): HTMLElement | null {
  const bar = document.querySelector("[data-bottom-action-bar]");
  if (!bar) return null;
  return Array.from(bar.querySelectorAll<HTMLElement>("button"))
    .find((entry) => entry.textContent?.includes(label)) ?? null;
}

describe("AppWithVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gridScroll.atEnd = false;
    commandMocks.getGridRows.mockResolvedValue({ path: "/vault", generation: 1, blocks: [] });
    vi.mocked(isTauri).mockReturnValue(false);
    commandMocks.getTabBootstrap.mockResolvedValue(null);
    commandMocks.spaceNoticeDismissed.mockResolvedValue(false);
    setTabVisible(true);
    localStorage.clear();
    sidebarResizeState.width = 300;
    sidebarResizeState.collapsed = false;
    sidebarResizeState.isResizing = false;
    sidebarResizeState.windowSidebar = undefined;
    clipboardWriteText.mockResolvedValue(undefined);
    webClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: webClipboardWriteText },
    });

    const allBlocks = [block(1, "alpha-block"), block(2, "beta-block")];
    const alphaBlocks = [allBlocks[0]!];
    const betaBlocks = [allBlocks[1]!];

    const snapshots = new Map<string, GridSnapshot>([
      ["__all__", gridSnapshot(allBlocks, 2)],
      ["alpha", gridSnapshot(alphaBlocks, 2)],
      ["beta", gridSnapshot(betaBlocks, 2)],
    ]);

    commandMocks.openVault.mockResolvedValue(vaultOpenResult());
    commandMocks.getVaultPath.mockResolvedValue(null);
    commandMocks.startVaultSync.mockResolvedValue(true);
    commandMocks.recordStartupMilestone.mockResolvedValue(undefined);
    commandMocks.startStartupMaintenance.mockResolvedValue(true);
    commandMocks.sweepVaultThumbnails.mockResolvedValue(0);
    commandMocks.createChannel.mockImplementation(async (tag: string) => ({
      tag,
      description: null,
      color: null,
      icon: null,
      position: 2,
      created_at: "2026-04-17T00:00:00Z",
      block_count: 0,
    }));
    commandMocks.renameBlockFile.mockReset();
    commandMocks.prepareDeleteBlock.mockResolvedValue({
      slug: "alpha-block",
      markdown_file: "alpha-block.md",
      unused_media: [],
      shared_media: [],
    });
    commandMocks.deleteBlock.mockResolvedValue(true);
    commandMocks.deleteBlocks.mockResolvedValue(1);
    commandMocks.mergeBlocks.mockResolvedValue({});
    commandMocks.getBlock.mockImplementation(async (slug: string) => indexedBlock(1, slug, slug));
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      if (isSearchOverlayQuery(limit, query)) {
        return snapshots.get(tag ?? "__all__") ?? snapshots.get("__all__")!;
      }
      expect(offset).toBe(0);
      expect(limit).toBe(200);
      // The feed reads in its default order; it never sends a search text.
      expect(query).toBe("newest");
      return snapshots.get(tag ?? "__all__") ?? snapshots.get("__all__")!;
    });
    commandMocks.listTaxonomySnapshot.mockResolvedValue({
      generation: 1,
      tags: [
        { tag: "alpha", count: 1 },
        { tag: "beta", count: 1 },
      ],
      channels: [
        {
          tag: "alpha",
          title: "Alpha",
          description: null,
          color: null,
          icon: null,
          position: 0,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        },
        {
          tag: "beta",
          title: "Beta",
          description: null,
          color: null,
          icon: null,
          position: 1,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        },
      ],
      total_blocks: 2,
    });
    commandMocks.getVaultStats.mockImplementation(async (currentCollection = null) => ({
      totalFileCount: 1464,
      markdownFileCount: 260,
      mediaFileCount: 1204,
      sourceBytes: 4_800_000_000,
      currentCollectionCardCount: currentCollection ? 1 : 2,
      currentCollection,
      updatedAtMs: 1,
    }));
  });

  it("keeps only the latest vault mounted during rapid A to B switching", async () => {
    const firstA = deferred<VaultOpenResult>();
    const firstB = deferred<VaultOpenResult>();
    const secondA = deferred<VaultOpenResult>();
    const secondB = deferred<VaultOpenResult>();
    const pendingOpens = [firstA, firstB, secondA, secondB];
    commandMocks.getVaultPath.mockResolvedValue("/spaces/A");
    commandMocks.openVault.mockImplementation(async () => {
      const pending = pendingOpens.shift();
      if (!pending) throw new Error("unexpected openVault call");
      return pending.promise;
    });
    const latest = block(90, "latest-space-b");
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([latest]));
    commandMocks.listTaxonomySnapshot.mockResolvedValue({
      generation: 1,
      tags: [],
      channels: [],
      total_blocks: 1,
    });

    render(<App />);
    await waitFor(() => {
      expect(commandMocks.openVault).toHaveBeenNthCalledWith(1, "/spaces/A");
    });

    fireEvent(
      window,
      new CustomEvent("vault-selected", {
        detail: { payload: { path: "/spaces/B" } },
      }),
    );
    await waitFor(() => {
      expect(commandMocks.openVault).toHaveBeenNthCalledWith(2, "/spaces/B");
    });
    fireEvent(
      window,
      new CustomEvent("vault-selected", {
        detail: { payload: { path: "/spaces/A" } },
      }),
    );
    await waitFor(() => {
      expect(commandMocks.openVault).toHaveBeenNthCalledWith(3, "/spaces/A");
    });
    fireEvent(
      window,
      new CustomEvent("vault-selected", {
        detail: { payload: { path: "/spaces/B" } },
      }),
    );
    await waitFor(() => {
      expect(commandMocks.openVault).toHaveBeenNthCalledWith(4, "/spaces/B");
    });

    await act(async () => {
      secondB.resolve(vaultOpenResult({ indexed: 1 }));
      await secondB.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("grid-title-latest-space-b")).toHaveTextContent(
        "latest-space-b",
      );
    });

    await act(async () => {
      firstA.resolve(vaultOpenResult());
      firstB.resolve(vaultOpenResult());
      secondA.resolve(vaultOpenResult());
      await Promise.all([firstA.promise, firstB.promise, secondA.promise]);
    });

    expect(screen.getByTestId("grid-title-latest-space-b")).toBeInTheDocument();
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
  });

  it("shows a lost space as unavailable only while it is the open one (В2.1)", async () => {
    commandMocks.getVaultPath.mockResolvedValue("/spaces/A");
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([block(90, "space-card")]));
    commandMocks.listTaxonomySnapshot.mockResolvedValue({
      generation: 1,
      tags: [],
      channels: [],
      total_blocks: 1,
    });

    render(<App />);
    await waitFor(() => expect(commandMocks.openVault).toHaveBeenCalledWith("/spaces/A"));
    fireEvent(window, new CustomEvent("vault-selected", {
      detail: { payload: { path: "/spaces/B" } },
    }));
    await waitFor(() => expect(commandMocks.openVault).toHaveBeenCalledWith("/spaces/B"));
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1"));

    // A's folder watch reports its loss after the switch to B.
    fireEvent(window, new CustomEvent("space-unavailable", {
      detail: { payload: { path: "/spaces/A", reason: "missing" } },
    }));
    expect(document.querySelector("[data-space-unavailable]")).toBeNull();
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
    expect(commandMocks.openVault).toHaveBeenLastCalledWith("/spaces/B");

    fireEvent(window, new CustomEvent("space-unavailable", {
      detail: { payload: { path: "/spaces/B", reason: "missing" } },
    }));
    await waitFor(() => expect(document.querySelector("[data-space-unavailable]")).not.toBeNull());
    expect(document.querySelector("[data-space-unavailable-path]")).toHaveTextContent("/spaces/B");
  });

  it("reserves the app minimum from max sidebar plus right pane minimum", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    expect(container.firstElementChild).toHaveStyle({
      minWidth: `${APP_MIN_WIDTH_PX}px`,
    });
    expect(screen.getByRole("main")).toHaveStyle({
      minWidth: `${APP_MAIN_MIN_WIDTH_PX}px`,
    });
  });

  it("paints the first grid page before warming one background page", async () => {
    const first = block(10, "first-page");
    const second = block(11, "warm-page");
    const warmPage = deferred<GridSnapshot>();
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      if (isSearchOverlayQuery(limit, query)) {
        return gridSnapshot([]);
      }
      expect(tag).toBeUndefined();
      expect(limit).toBe(200);
      if (offset === 0) {
        return gridSnapshot([first], 2, true);
      }
      expect(offset).toBe(1);
      return warmPage.promise;
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
    });
    await waitFor(() => {
      expect(commandMocks.listGridBlocks).toHaveBeenCalledWith(undefined, 1, 200, "newest");
    });

    warmPage.resolve(gridSnapshot([second], 2));
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
  });

  it("restarts from offset zero instead of mixing pagination generations", async () => {
    const first = block(20, "generation-one");
    const second = block(21, "generation-two");
    const newerPage = deferred<GridSnapshot>();
    let firstPageReads = 0;
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      if (isSearchOverlayQuery(limit, query)) return gridSnapshot([]);
      expect(tag).toBeUndefined();
      expect(limit).toBe(200);
      if (offset === 1) return newerPage.promise;
      expect(offset).toBe(0);
      firstPageReads += 1;
      return firstPageReads === 1
        ? gridSnapshot([first], 2, true, 1)
        : gridSnapshot([first, second], 2, false, 2);
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(commandMocks.listGridBlocks).toHaveBeenCalledWith(undefined, 1, 200, "newest");
    });

    newerPage.resolve(gridSnapshot([second], 2, false, 2));

    await waitFor(() => {
      expect(firstPageReads).toBe(2);
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
  });

  it("does not restart vault sync or taxonomy fetch on route change", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(commandMocks.openVault).toHaveBeenCalledWith("/vault");
    });
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    await waitFor(() => {
      expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    });
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(1, undefined, 0, 200, "newest");

    fireEvent.click(screen.getByRole("link", { name: "alpha" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch collection: alpha" })).toBeInTheDocument();
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(2, "alpha", 0, 200, "newest");

    fireEvent.click(screen.getByRole("link", { name: "beta" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("beta:1");
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(3, "beta", 0, 200, "newest");

    fireEvent.click(screen.getByRole("link", { name: /Everything 2/ }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch collection: Everything" })).toBeInTheDocument();
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(4, undefined, 0, 200, "newest");
  });

  it("starts process maintenance only after the first route is committed", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    await waitFor(() => {
      expect(commandMocks.startStartupMaintenance).toHaveBeenCalledTimes(1);
    });
    expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("first_route_committed");
    // The mocked grid paints no cards: the milestone waits for the real
    // grid's report (SPEC_AUDIT_FIXES.md, А8.2).
    expect(commandMocks.recordStartupMilestone).not.toHaveBeenCalledWith("first_cards_painted");
    reportCardsRendered();
    await waitFor(() => {
      expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("first_cards_painted");
    });
    expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("interactive");
    expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("update_ready");
  });

  it("never accepts a failed space load as a healthy updated app", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    commandMocks.openVault.mockRejectedValue(new Error("database schema is newer than supported"));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByText("database schema is newer than supported");
    await waitFor(() => expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("interactive"));
    expect(commandMocks.recordStartupMilestone).not.toHaveBeenCalledWith("update_ready");
  });

  it("never accepts a failed initial selection read as a healthy updated app", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    commandMocks.getVaultPath.mockRejectedValue(new Error("selection unreadable"));
    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("interactive"));
    expect(commandMocks.recordStartupMilestone).not.toHaveBeenCalledWith("update_ready");
  });

  it("accepts a healthy app with no configured space", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    commandMocks.getVaultPath.mockResolvedValue(null);
    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("update_ready"));
  });

  it("keeps the first route usable while startup maintenance is still pending", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    commandMocks.startStartupMaintenance.mockReturnValue(new Promise(() => {}));

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    await waitFor(() => {
      expect(commandMocks.startStartupMaintenance).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    expect(commandMocks.recordStartupMilestone).toHaveBeenCalledWith("interactive");
  });

  it("catches up with the disk when the backend asks, not while startup sync runs (В42)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    });
    fireEvent(window, new CustomEvent("tab-refresh-requested", { detail: { payload: null } }));
    expect(commandMocks.sweepVaultThumbnails).not.toHaveBeenCalled();

    fireEvent(
      window,
      new CustomEvent("vault-sync-finished", {
        detail: {
          payload: {
            path: "/vault",
            indexed: 0,
            errors: 0,
            error: null,
          },
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("true");
    });
    // Focus and a shown page no longer start it: switching tabs would (В42).
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(commandMocks.sweepVaultThumbnails).not.toHaveBeenCalled();

    const listCallsBefore = commandMocks.listGridBlocks.mock.calls.length;
    fireEvent(window, new CustomEvent("tab-refresh-requested", { detail: { payload: null } }));
    await waitFor(() => {
      expect(commandMocks.sweepVaultThumbnails).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(commandMocks.listGridBlocks.mock.calls.length).toBeGreaterThan(listCallsBefore);
    });
  });

  it("does not treat a pending uncached route as an authoritative empty grid", async () => {
    const alphaDeferred = deferred<GridSnapshot>();
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      if (isSearchOverlayQuery(limit, query)) {
        return gridSnapshot([]);
      }
      expect(offset).toBe(0);
      expect(limit).toBe(200);
      // The feed reads in its default order; it never sends a search text.
      expect(query).toBe("newest");
      if ((tag ?? "__all__") === "__all__") {
        return gridSnapshot([]);
      }
      if (tag === "alpha") {
        return alphaDeferred.promise;
      }
      return gridSnapshot([]);
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:0");
      expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("true");
    });

    fireEvent.click(await screen.findByRole("link", { name: "alpha" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:0");
    });
    expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("false");

    alphaDeferred.resolve(gridSnapshot([block(1, "alpha-block")]));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
    expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("true");
  });

  it("loads the current route when navigation happens before the initial grid resolves", async () => {
    const allSnapshot: GridSnapshot = {
      generation: 1,
      blocks: [block(1, "alpha-block"), block(2, "beta-block")],
      total_blocks: 2,
      has_more: false,
    };
    const alphaSnapshot: GridSnapshot = {
      generation: 1,
      blocks: [block(1, "alpha-block")],
      total_blocks: 1,
      has_more: false,
    };
    const allDeferred = deferred<GridSnapshot>();

    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      if (isSearchOverlayQuery(limit, query)) {
        return gridSnapshot([]);
      }
      expect(offset).toBe(0);
      expect(limit).toBe(200);
      if ((tag ?? "__all__") === "__all__") {
        return allDeferred.promise;
      }
      if (tag === "alpha") {
        return alphaSnapshot;
      }
      return allSnapshot;
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("link", { name: "alpha" }));
    allDeferred.resolve(allSnapshot);

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(1, undefined, 0, 200, "newest");
    expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith("alpha", 0, 200, "newest");
  });

  it("closes Detail and switches channel with the keyboard shortcut", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    // The open card belongs to the channel being left, so it goes with it.
    // Detail is a full-screen viewer inside the same route, not a modal that
    // owns the keyboard.
    fireEvent.keyDown(window, { key: "ArrowDown", metaKey: true, altKey: true });

    await waitFor(() => {
      expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith("alpha", 0, 200, "newest");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("detail-title")).not.toBeInTheDocument();
    });
  });

  it("stops switching channels while the sidebar is collapsed", async () => {
    sidebarResizeState.collapsed = true;
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    // Stepping through a list nobody can see moves the feed with no way to tell
    // where it landed in the order.
    fireEvent.keyDown(window, { key: "ArrowDown", metaKey: true, altKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(commandMocks.listGridBlocks).not.toHaveBeenCalledWith("alpha", 0, 200);
    expect(bottomBarEntry("Switch collection")).toBeNull();
  });

  it("offers New Collection in the bottom bar only with the sidebar shown", async () => {
    sidebarResizeState.collapsed = true;
    const { unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(bottomBarEntry("New Collection")).toBeNull();
    unmount();

    sidebarResizeState.collapsed = false;
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(bottomBarEntry("New Collection")).not.toBeNull();
  });

  it("withdraws Navigate while a card is open, where arrows do nothing", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(bottomBarEntry("Navigate")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    expect(bottomBarEntry("Navigate")).toBeNull();
  });

  it("does not expose or open the removed global Search command", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("false");

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("false");
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("keeps the top chrome search component unrendered while preserving the chrome divider", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const topSidebarSegment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement | null;
    expect(topSidebarSegment?.parentElement).toHaveClass("bg-chrome");
    expect(topSidebarSegment).toHaveStyle({ width: "var(--sidebar-width)" });
    expect(topSidebarSegment).toHaveClass("border-r", "border-sidebar-border");
    const spaceSwitcher = topSidebarSegment?.querySelector("[data-vault-switcher]") as HTMLElement | null;
    expect(spaceSwitcher).toHaveAttribute("data-vault-switcher-surface", "topChrome");
    expect(spaceSwitcher).toHaveTextContent("vault");
    // The space switcher opens the row; one separator parts it from the filter.
    expect(topSidebarSegment?.querySelector("[data-top-chrome-space-separator]")).toBeNull();
    expect(topSidebarSegment?.querySelector("[data-top-chrome-search-separator]")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Find elements" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-main-search-top-bar]")).toBeNull();
  });

  it("starts the tab page's row with the space switcher: the traffic lights and the sidebar button live in the tab bar (В43)", async () => {
    for (const collapsed of [false, true]) {
      sidebarResizeState.collapsed = collapsed;
      const { unmount } = render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
      });

      const header = document.querySelector("header") as HTMLElement;
      expect(header.querySelector("[data-traffic-light-reserve]")).toBeNull();
      expect(header.querySelector("[data-top-chrome-sidebar-toggle]")).toBeNull();
      expect(header.querySelector("[data-top-chrome-space-separator]")).toBeNull();
      const segment = header.querySelector("[data-app-top-sidebar-segment]") as HTMLElement;
      const switcher = segment.querySelector("[data-vault-switcher]") as HTMLElement;
      expect(switcher).not.toBeNull();
      // Nothing of the window's own stands before it in the row.
      expect(segment.firstElementChild?.contains(switcher)).toBe(true);
      expect(header.firstElementChild).toBe(segment);
      unmount();
    }
    sidebarResizeState.collapsed = false;
  });

  it("switches the main view through the secondary segmented control", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const viewSwitcher = document.querySelector("[data-main-view-mode-switcher]") as HTMLElement;
    fireEvent.mouseDown(within(viewSwitcher).getByRole("tab", { name: "Graph" }), { button: 0 });

    // The tab remembers its mode; nothing app-wide does (SPEC_TABS.md, В78).
    expect(localStorage.getItem("mine.mainViewMode")).toBeNull();
    expect(await screen.findByTestId("graph-view")).toHaveTextContent("__all__");
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    const graphSwitcher = document.querySelector("[data-main-view-mode-switcher]") as HTMLElement;
    expect(within(graphSwitcher).getByRole("tab", { name: "Graph" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.mouseDown(within(graphSwitcher).getByRole("tab", { name: "Grid" }), { button: 0 });

    expect(localStorage.getItem("mine.mainViewMode")).toBeNull();
    expect(await screen.findByTestId("grid")).toHaveTextContent("__all__:2");
  });

  it("narrows the bar to selection commands while a selection exists", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(bottomBarEntry("Navigate")).not.toBeNull();

    fireEvent.click(screen.getByText("Report selection"));

    // Navigation leaves, the selection's own command arrives.
    expect(bottomBarEntry("Navigate")).toBeNull();
    expect(bottomBarEntry("Switch collection")).toBeNull();
    const clearEntry = bottomBarEntry("Clear selection");
    expect(clearEntry).not.toBeNull();

    // Pressing it clears the selection, and the bar returns to navigation.
    fireEvent.click(clearEntry!);
    expect(bottomBarEntry("Clear selection")).toBeNull();
    expect(bottomBarEntry("Navigate")).not.toBeNull();
  });

  it("hides bar entries by worth when the window is too narrow", async () => {
    // jsdom lays nothing out, so the bar's own measurement is fed real numbers:
    // clientWidth is the 320px window, scrollWidth is what the still-visible
    // entries add up to. This drives the production path — show all, then hide
    // by priority while the bar still overflows.
    const widths = new Map<string, number>([
      ["toggle-sidebar", 150],
      ["new-collection", 150],
      ["switch-collection", 170],
      ["navigate", 110],
      ["find-elements", 150],
      ["commands-overlay", 120],
      ["settings", 100],
    ]);
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-bottom-action-bar") ? 320 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.hasAttribute("data-bottom-action-bar")) return 0;
        return Array.from(this.querySelectorAll<HTMLElement>("[data-bar-entry]"))
          .filter((slot) => slot.style.display !== "none")
          .reduce((sum, slot) => sum + (widths.get(slot.dataset.barEntry!) ?? 100), 0);
      },
    });

    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
      });

      const bar = () => document.querySelector("[data-bottom-action-bar]") as HTMLElement;
      const shown = () => Array.from(bar().querySelectorAll<HTMLElement>("[data-bar-entry]"))
        .filter((node) => node.style.display !== "none")
        .map((node) => node.dataset.barEntry!);

      await waitFor(() => {
        expect(shown()).not.toContain("navigate");
      });
      const visible = shown();
      // Reference entries go first, then the learned commands.
      expect(visible).not.toContain("switch-collection");
      expect(visible).not.toContain("settings");
      // And what is left actually fits — the whole point of the rule.
      expect(bar().scrollWidth).toBeLessThanOrEqual(bar().clientWidth);
    } finally {
      // jsdom may not define these at all; leaving a stub behind would make
      // every later test think the bar overflows.
      if (client) Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
      if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
  });

  it("never squeezes an entry: it is whole or it is gone", async () => {
    // Narrowing must not shrink a control into a clipped stub. Every entry
    // holds its natural width (shrink-0) and leaves the bar entirely when it
    // no longer fits.
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const bar = document.querySelector("[data-bottom-action-bar]") as HTMLElement;
    const slots = Array.from(bar.querySelectorAll<HTMLElement>("[data-bar-entry]"));
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.className, `${slot.dataset.barEntry} may be squeezed`).toContain("shrink-0");
      // Hiding is all-or-nothing: the only style the overflow rule applies is
      // display, never a width or a clip.
      expect(slot.getAttribute("style") ?? "").not.toMatch(/width|max-width|overflow|clip/);
    }
    expect(bar.className).not.toContain("overflow-x-auto");
  });

  it("marks every hideable bar entry with a decided hide priority", async () => {
    const { BAR_HIDE_PRIORITIES } = await import("@/lib/bottomBarOverflow");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const bar = document.querySelector("[data-bottom-action-bar]") as HTMLElement;
    const hideable = Array.from(bar.querySelectorAll<HTMLElement>("[data-bar-entry]"))
      .map((node) => node.dataset.barEntry!);
    expect(hideable.length).toBeGreaterThan(0);
    for (const id of hideable) {
      expect(BAR_HIDE_PRIORITIES[id], `${id} has no hide priority`).toBeTypeOf("number");
    }
    // Escape is known everywhere, so its entries hide like any other — before
    // the commands that can only be learned from this bar.
    expect(BAR_HIDE_PRIORITIES["close-element"]!)
      .toBeLessThan(BAR_HIDE_PRIORITIES["open-focused"]!);
    expect(BAR_HIDE_PRIORITIES["clear-selection"]!)
      .toBeLessThan(BAR_HIDE_PRIORITIES["element-menu"]!);
  });

  it("hands the chrome row to the selection while one exists", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const selectionLayer = () =>
      document.querySelector("[data-secondary-selection-bar]") as HTMLElement;
    expect(selectionLayer()).toHaveAttribute("data-entered", "false");

    fireEvent.click(screen.getByText("Report selection"));
    expect(selectionLayer()).toHaveAttribute("data-entered", "true");
    // The selection lives in the row over the feed and replaces only its
    // ordinary content.
    expect(selectionLayer().closest("[data-main-secondary-top-bar-content-segment]"))
      .not.toBeNull();
    const layers = document.querySelectorAll("[data-main-secondary-main-layer]");
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveAttribute("data-entered", "false");

    // The ground does not move: a selection swaps the half's content, not the
    // row's surface — fills compute from the surface, so they stay consistent.
    const bar = document.querySelector("header.chrome-row");
    expect(bar).toHaveClass("bg-chrome");
    expect(bar).not.toHaveClass("bg-accent");

    fireEvent.click(bottomBarEntry("Clear selection")!);
    expect(selectionLayer()).toHaveAttribute("data-entered", "false");
  });

  it("keeps Settings at the far right edge of the bar", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const bar = document.querySelector("[data-bottom-action-bar]") as HTMLElement;
    const labels = Array.from(bar.querySelectorAll("button")).map((b) => b.textContent ?? "");
    const findIndex = labels.findIndex((label) => label.includes("Find elements"));
    const settingsIndex = labels.findIndex((label) => label.includes("Settings"));
    expect(findIndex).toBeGreaterThan(-1);
    expect(settingsIndex).toBeGreaterThan(findIndex);
    expect(settingsIndex).toBe(labels.length - 1);
  });

  it("sends Command-slash to the Shortcuts settings instead of an overlay", async () => {
    // The list lives where it can also be changed; a second copy as an overlay
    // would be one more place to keep true.
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.keyDown(window, { key: "/", metaKey: true });

    await waitFor(() => {
      expect(commandMocks.openSettingsWindow).toHaveBeenCalledWith("shortcuts");
    });
    expect(document.querySelector("[data-commands-overlay]")).not.toBeInTheDocument();
    expect(bottomBarEntry("Commands")).toBeNull();
  });

  it("cycles Grid and Graph with plain Tab", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.keyDown(window, { key: "Tab" });
    expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
    // The tab remembers its mode; nothing app-wide does (SPEC_TABS.md, В78).
    expect(localStorage.getItem("mine.mainViewMode")).toBeNull();

    fireEvent.keyDown(window, { key: "Tab" });
    expect(await screen.findByTestId("grid")).toBeInTheDocument();
    expect(localStorage.getItem("mine.mainViewMode")).toBeNull();
  });

  it("leaves Tab native inside an editable target", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "Tab" });
    input.remove();

    expect(screen.getByTestId("grid")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-view")).not.toBeInTheDocument();
  });

  it("toggles the connections filter with Tab while an element is open", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    fireEvent.keyDown(window, { key: "Tab" });

    // The view must not flip underneath the open element.
    expect(screen.queryByTestId("graph-view")).not.toBeInTheDocument();
    expect(screen.queryByTestId("graph-view")).not.toBeInTheDocument();
  });

  it("renders default chrome surfaces", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const topSidebarSegment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement;
    expect(topSidebarSegment.parentElement).toHaveClass("bg-chrome");
    // The backend paints every window with the chrome colour this page
    // reports; the page paints no window itself (SPEC_TABS.md, В25).
    await waitFor(() => {
      expect(commandMocks.reportWindowSurface).toHaveBeenCalledWith("#fafafa");
    });

    fireEvent.keyDown(window, { key: "А", code: "KeyF", metaKey: true, shiftKey: true });
    const input = screen.getByRole("textbox", { name: "Find or create collection" });
    fireEvent.change(input, { target: { value: "alp" } });
    // Over the table the field keeps the table's surface, a query too.
    expect(input.closest("[data-sidebar-top-search-surface]")).toHaveClass("bg-sidebar");
    expect(input.closest("[data-sidebar-top-search-surface]")).not.toHaveClass("bg-accent");

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });
  });

  it("answers a rebound search chord and no longer the old one (Ф11)", async () => {
    setCommandOverrides({ "find-collections": { key: "j", meta: true, shift: true } });
    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
      });

      const before = screen.queryByRole("textbox", { name: "Find or create collection" });
      const old = fireEvent.keyDown(window, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
      // The old chord is no longer claimed: the event is not prevented and
      // the collection filter does not take focus.
      expect(old).toBe(true);
      expect(document.activeElement).not.toBe(screen.queryByRole("textbox", { name: "Find or create collection" }) ?? before);

      const rebound = fireEvent.keyDown(window, { key: "J", code: "KeyJ", metaKey: true, shiftKey: true });
      expect(rebound).toBe(false);
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Find or create collection" }));
      });
    } finally {
      setCommandOverrides({});
    }
  });

  it("answers Paste and Commands rebound after the window rendered (Б5.3, Ф11)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    // Settings rebinds both while this window is on screen; the registry
    // changes without re-rendering anything here.
    setCommandOverrides({
      paste: { key: "b", meta: true, shift: true },
      "commands-overlay": { key: "y", meta: true },
    });
    try {
      const oldPaste = fireEvent.keyDown(window, { key: "v", code: "KeyV", metaKey: true });
      const oldCommands = fireEvent.keyDown(window, { key: "/", code: "Slash", metaKey: true });
      expect(oldPaste).toBe(true);
      expect(oldCommands).toBe(true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(commandMocks.readClipboardPayload).not.toHaveBeenCalled();
      expect(commandMocks.openSettingsWindow).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "B", code: "KeyB", metaKey: true, shiftKey: true });
      const commands = fireEvent.keyDown(window, { key: "y", code: "KeyY", metaKey: true });
      expect(commands).toBe(false);
      await waitFor(() => {
        expect(commandMocks.readClipboardPayload).toHaveBeenCalledTimes(1);
        expect(commandMocks.openSettingsWindow).toHaveBeenCalledExactlyOnceWith("shortcuts");
      });
    } finally {
      setCommandOverrides({});
    }
  });

  it("relabels the bottom bar the moment a command is rebound (Ф11)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const findEntry = () => document.querySelector("[data-bar-entry='find-elements']");
    const before = findEntry()?.textContent ?? "";

    act(() => setCommandOverrides({ "find-elements": { key: "g", meta: true } }));
    try {
      expect(findEntry()).toHaveTextContent(commandById("find-elements").combo);
      expect(findEntry()?.textContent).not.toBe(before);
    } finally {
      act(() => setCommandOverrides({}));
    }
    expect(findEntry()?.textContent).toBe(before);
  });

  it("opens the settings window from the bottom action bar", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const bottomBar = document.querySelector("[data-bottom-action-bar]") as HTMLElement;
    expect(bottomBar).toBeInTheDocument();
    fireEvent.click(within(bottomBar).getByRole("button", { name: /Settings/ }));
    expect(commandMocks.openSettingsWindow).toHaveBeenCalledTimes(1);
  });

  it("hides the bottom action bar via settings-changed without losing Settings access", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    expect(document.querySelector("[data-bottom-action-bar]")).toBeInTheDocument();
    const settingsMenu = screen.getByRole("button", { name: "Mine settings" });
    expect(settingsMenu.closest("header")).toBeInTheDocument();

    // The settings window writes localStorage and emits settings-changed;
    // the main window re-reads the key (test setup bridges Tauri events
    // onto window CustomEvents, detail carries the Tauri event envelope).
    localStorage.setItem("mine.bottomActionBarHidden", "true");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("settings-changed", {
          detail: { payload: { key: "mine.bottomActionBarHidden" } },
        }),
      );
    });

    await waitFor(() => {
      expect(document.querySelector("[data-bottom-action-bar]")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Mine settings" })).toBe(settingsMenu);
    const menuSlot = settingsMenu.closest("[data-top-chrome-settings-menu]");
    expect(menuSlot?.nextElementSibling).toBeNull();
    expect(document.querySelector("[data-main-view-mode-switcher]")).toBeInTheDocument();
    fireEvent.keyDown(settingsMenu, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New files" }));
    expect(commandMocks.openSettingsWindow).toHaveBeenCalledExactlyOnceWith("layout");
  });

  it("uses the secondary top bar for non-compact Detail chrome instead of body overlays", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const settingsMenu = screen.getByRole("button", { name: "Mine settings" });

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });
    expect(screen.getByRole("button", { name: "Mine settings" })).toBe(settingsMenu);
    expect(settingsMenu.closest("[data-top-chrome-settings-menu]")?.nextElementSibling).toBeNull();

    // The All / Connected switch left every mode (03.10.2026): an open card
    // brings no collection filter anywhere.
    const linkModeControl = () => document.querySelector("[data-detail-link-mode-tabs]");
    const secondaryDetailMenu = document.querySelector(
      "[data-secondary-detail-top-menu]",
    ) as HTMLElement | null;
    const secondaryContentSegment = document.querySelector(
      "[data-main-secondary-top-bar-content-segment]",
    ) as HTMLElement | null;
    expect(screen.getByRole("dialog")).toHaveAttribute("data-detail-top-chrome-mode", "external");
    expect(linkModeControl()).toBeNull();
    expect(secondaryDetailMenu).toBeInTheDocument();
    expect(secondaryContentSegment).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector("header.chrome-row")).toHaveClass("bg-chrome");
      expect(secondaryDetailMenu).toHaveAttribute("data-entered", "true");
    });
    expect(document.querySelector("[data-secondary-sidebar-link-mode-bar]")).not.toBeInTheDocument();
    expect(within(secondaryDetailMenu!).getByText("alpha-block")).toBeInTheDocument();
    expect(document.querySelector("[data-sidebar-link-mode-bar]")).not.toBeInTheDocument();
    expect(document.querySelector('[data-detail-top-menu="classic"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(document.querySelector("header.chrome-row")).toHaveClass("bg-chrome");
    expect(secondaryDetailMenu).toHaveAttribute("data-entered", "false");
    expect(document.querySelectorAll("[data-main-secondary-main-layer]")[0]).toHaveAttribute(
      "data-entered",
      "true",
    );
    // The row's own content comes back: Grid and Graph, no count.
    expect(within(secondaryContentSegment!).getByRole("tablist", { name: "View mode" })).toBeInTheDocument();
  });

  describe("the top rows (DESIGN_SYSTEM.md, «Верхние ряды»)", () => {

    it("folds the row over the feed into the second row; no row heads the table", async () => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      const header = document.querySelector("header.chrome-row") as HTMLElement;
      expect(header.querySelector("[data-main-secondary-top-bar-content-segment]")).not.toBeNull();
      expect(document.querySelector("[data-main-secondary-top-bar-sidebar-segment]")).toBeNull();
      // No row of its own between the second row and the body, over the feed
      // or over the table.
      expect(document.querySelectorAll("[data-main-secondary-top-bar]")).toHaveLength(0);
      expect(header).toHaveAttribute("data-chrome-separator", "bottom");
      expect(document.querySelector("[data-bottom-action-bar]")).toHaveAttribute("data-chrome-separator", "top");
      // No count of collections; the command that adds one stands at the
      // filter's right.
      expect(document.querySelector("[data-main-secondary-collection-count]")).toBeNull();
      const filterActions = document.querySelector("[data-sidebar-top-search-actions]") as HTMLElement;
      expect(within(filterActions).getByRole("button", { name: "New Collection" })).toHaveAttribute(
        "data-sidebar-new-collection",
        "",
      );
      // No count of elements and no View: prefix; Grid and Graph at the right.
      expect(header).not.toHaveTextContent("elements");
      expect(header).not.toHaveTextContent("View:");
      expect(within(header).getByRole("tablist", { name: "View mode" })).toBeInTheDocument();
    });

    it("joins space and collection into one path with the sidebar collapsed: no line, no padding between", async () => {
      sidebarResizeState.width = 0;
      sidebarResizeState.collapsed = true;
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      const segment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement;
      expect(segment).not.toHaveClass("border-r");
      // The space switcher's own padding is VaultSwitcher.test.tsx's to check.
      expect(document.querySelector("[data-vault-switcher]")).toHaveAttribute("data-vault-switcher-joins-next", "true");
      const collection = screen.getByRole("button", { name: "Switch collection: Everything" });
      expect(collection).toHaveClass("pl-0", "pr-0");
    });

    it("keeps outer padding toward the column line with the sidebar open", async () => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      expect(document.querySelector("[data-vault-switcher]")).toHaveAttribute("data-vault-switcher-joins-next", "false");
      const collection = screen.getByRole("button", { name: "Switch collection: Everything" });
      // A line before it, the path going on after it.
      expect(collection).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-0");
    });
  });

  it("keeps space and collection controls while hiding channel search when the sidebar is collapsed", async () => {
    sidebarResizeState.width = 0;
    sidebarResizeState.collapsed = true;

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const topSidebarSegment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement | null;
    expect(topSidebarSegment).toHaveClass("w-auto", "max-w-[240px]");
    expect(topSidebarSegment).not.toHaveStyle({ width: "var(--sidebar-width)" });
    expect(topSidebarSegment).toHaveClass("transition-[width]", "duration-200", "ease-out");
    const spaceSwitcher = topSidebarSegment?.querySelector("[data-vault-switcher]") as HTMLElement | null;
    expect(spaceSwitcher).toHaveAttribute("data-vault-switcher-surface", "topChrome");
    expect(spaceSwitcher).toHaveAttribute("data-vault-switcher-top-chrome-collapsed", "true");
    expect(spaceSwitcher).toHaveTextContent("vault");
    // The collapsed segment holds the space switcher alone: no traffic-light
    // reserve, no sidebar button and no separator before it (В43).
    expect(topSidebarSegment?.querySelector("[data-traffic-light-reserve]")).toBeNull();
    expect(topSidebarSegment?.querySelector("[data-top-chrome-space-separator]")).toBeNull();
    expect(topSidebarSegment?.querySelector("[data-top-chrome-search-separator]")).not.toBeInTheDocument();
    expect(document.querySelector("[data-top-chrome-space-measure]")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Find or create collection" })).not.toBeInTheDocument();
    const collectionSwitcher = screen.getByRole("button", { name: "Switch collection: Everything" });
    // Collapsed, space and collection are one path: no inset between them,
    // none before the content that follows.
    expect(collectionSwitcher).toHaveClass("pl-0", "pr-0");
    expect(collectionSwitcher).not.toHaveClass("px-3");
  });

  it("opens the search overlay from the bottom action without refetching the grid", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const gridCallsBeforeSearchToggle = commandMocks.listGridBlocks.mock.calls.length;
    const searchButton = screen.getByRole("button", { name: /Find elements/ });

    fireEvent.click(searchButton);
    expect(searchButton).not.toHaveAttribute("data-action-selected");
    expect(document.querySelector("[data-search-overlay]")).not.toBeNull();
    expect(screen.getByRole("combobox")).toHaveFocus();
    // Opening with an empty query issues exactly one recent-mode request
    // (limit 20, no query) and leaves the grid itself alone.
    await waitFor(() => {
      expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(
        gridCallsBeforeSearchToggle + 1,
      );
      expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith(
        undefined,
        0,
        20,
      );
    });
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
  });

  it("takes the feed keyboard away while the search overlay is open (Г4.2)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("false");

    fireEvent(window, new CustomEvent("surface-search-shortcut", { detail: { payload: "main" } }));
    expect(document.querySelector("[data-search-overlay]")).not.toBeNull();
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("true");

    fireEvent(window, new CustomEvent("surface-search-shortcut", { detail: { payload: "main" } }));
    await waitFor(() => expect(document.querySelector("[data-search-overlay]")).toBeNull());
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("false");
  });

  it("toggles the search overlay with the native main accelerator event", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent(
      window,
      new CustomEvent("surface-search-shortcut", {
        detail: { payload: "main" },
      }),
    );
    expect(document.querySelector("[data-search-overlay]")).not.toBeNull();

    fireEvent(
      window,
      new CustomEvent("surface-search-shortcut", {
        detail: { payload: "main" },
      }),
    );
    await waitFor(() => {
      expect(document.querySelector("[data-search-overlay]")).toBeNull();
    });
  });

  it("opens the search overlay over an open card, from the menu and the keyboard (07.10.2026)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));

    // Focus inside the open card: the card is a surface, not an overlay.
    const insideCard = screen.getByRole("button", { name: "Delete detail" });
    insideCard.focus();
    fireEvent(window, new CustomEvent("surface-search-shortcut", { detail: { payload: "main" } }));
    expect(document.querySelector("[data-search-overlay]")).not.toBeNull();
    expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");

    fireEvent(window, new CustomEvent("surface-search-shortcut", { detail: { payload: "main" } }));
    await waitFor(() => expect(document.querySelector("[data-search-overlay]")).toBeNull());

    const stillInsideCard = screen.getByRole("button", { name: "Delete detail" });
    stillInsideCard.focus();
    fireEvent.keyDown(stillInsideCard, { key: "f", code: "KeyF", metaKey: true });
    expect(document.querySelector("[data-search-overlay]")).not.toBeNull();
  });

  it("uses the native sidebar shortcut in Tauri and the keydown fallback in browsers", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    // The menu, the swipe and the tab bar's button toggle the window's
    // sidebar in the backend; the old page events toggle nothing (В56).
    for (const retired of ["sidebar-toggle-shortcut", "sidebar-swipe"]) {
      fireEvent(window, new CustomEvent(retired, { detail: { payload: "left" } }));
    }
    expect(sidebarResizeState.toggleCollapsed).not.toHaveBeenCalled();

    vi.mocked(isTauri).mockReturnValue(true);
    fireEvent.keyDown(window, {
      key: "ы",
      code: "KeyS",
      metaKey: true,
      ctrlKey: true,
    });
    expect(sidebarResizeState.toggleCollapsed).not.toHaveBeenCalled();

    vi.mocked(isTauri).mockReturnValue(false);
    fireEvent.keyDown(window, {
      key: "ы",
      code: "KeyS",
      metaKey: true,
      ctrlKey: true,
    });
    expect(sidebarResizeState.toggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("opens a search result in Detail and closes the overlay", async () => {
    const matched = {
      ...block(7, "found-card"),
      title: "Found card",
      search_match: {
        field: "body" as const,
        kind: "exact" as const,
        excerpt: "…text around the match…",
        ranges: [{ start: 17, end: 22 }],
        score: 100,
      },
    };
    const gridBlocks = [block(1, "alpha-block"), block(2, "beta-block")];
    commandMocks.listGridBlocks.mockImplementation(async (tag, _offset, _limit, query) => {
      // The feed's order is not a search text.
      if (query && query !== "newest" && query !== "oldest") {
        expect(tag).toBeUndefined();
        return gridSnapshot([matched]);
      }
      return gridSnapshot(gridBlocks, 2);
    });
    commandMocks.getBlock.mockImplementation(async (slug: string) =>
      indexedBlock(7, slug, "Found card"),
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent(
      window,
      new CustomEvent("surface-search-shortcut", { detail: { payload: "main" } }),
    );
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "match" } });

    const option = await screen.findByRole("option", {}, { timeout: 2000 });
    expect(option.querySelector("mark")).not.toBeNull();

    fireEvent.click(option);
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("Found card");
    });
    expect(document.querySelector("[data-search-overlay]")).toBeNull();
    // The grid dataset stayed untouched by the overlay search.
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
  });

  it("opens sidebar search with Shift-Command-F without touching grid query", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const gridCallsBeforeSearch = commandMocks.listGridBlocks.mock.calls.length;

    fireEvent.keyDown(window, { key: "А", code: "KeyF", metaKey: true, shiftKey: true });
    const input = screen.getByRole("textbox", { name: "Find or create collection" });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    const searchSurface = input.closest("[data-sidebar-top-search-surface]") as HTMLElement;
    // Empty, the field is chrome like the rest of the row (05.10.2026).
    expect(searchSurface).toHaveClass("bg-chrome");
    expect(searchSurface).not.toHaveClass("bg-sidebar");
    // No hover answer: the placeholder stays muted.
    expect(input.className).not.toMatch(/hover:placeholder:text-foreground/);
    expect(input).toHaveClass("font-mono");
    expect(input).toHaveClass("text-sm");
    expect(input).toHaveClass("text-muted-foreground");
    expect(input).not.toHaveClass("text-base");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(screen.queryByRole("button", { name: "Clear collection search" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "alp" } });

    // A query leaves the field on the table's surface.
    expect(searchSurface).toHaveClass("bg-sidebar");
    expect(searchSurface).not.toHaveClass("bg-accent");
    const clearSearch = screen.getByRole("button", { name: "Clear collection search" });
    expect(clearSearch).toHaveAttribute("data-chrome-control");
    expect(clearSearch.querySelector("[data-chrome-plate]")).not.toBeNull();
    // A chrome icon button like its neighbours (05.10.2026): the 13px glyph
    // and the plate on hover come from the chrome-icon size.
    expect(clearSearch).toHaveAttribute("data-size", "chrome-icon");
    expect(clearSearch.querySelector("[data-chrome-plate]")).toHaveClass("group-hover/chrome:state-active");
    fireEvent.click(clearSearch);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
    expect(searchSurface).toHaveClass("bg-chrome");
    expect(screen.queryByRole("button", { name: "Clear collection search" })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "alp" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "alp" } });
    expect(screen.queryByRole("link", { name: /Everything/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /beta/ })).not.toBeInTheDocument();
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(gridCallsBeforeSearch);
  });

  it("navigates sidebar search results with arrows while keeping the search input focused", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.keyDown(window, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
    const input = screen.getByRole("textbox", { name: "Find or create collection" });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    fireEvent.change(input, { target: { value: "alp" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(input).toHaveFocus();
    expect(input).toHaveValue("alp");
    expect(input).toHaveAttribute("aria-activedescendant", "sidebar-row-tag%3Aalpha");

    fireEvent.change(input, { target: { value: "alph" } });
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
  });

  it("shows a right top-chrome collection switcher without duplicating the current collection", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const collectionSwitcher = screen.getByRole("button", { name: "Switch collection: Everything" });
    // From the column's line the one inset; the content after it follows on.
    expect(collectionSwitcher).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-0");
    expect(collectionSwitcher).not.toHaveClass("px-3");
    expect(collectionSwitcher).toHaveClass("font-mono");
    expect(collectionSwitcher).toHaveClass("text-sm");
    expect(collectionSwitcher).toHaveClass("text-muted-foreground");
    expect(collectionSwitcher).not.toHaveClass("text-base");
    const collectionPill = screen.getByText("Everything").parentElement as HTMLElement;
    expect(collectionPill).toHaveClass("text-muted-foreground");
    expect(collectionPill).toHaveClass("group-hover:text-foreground");
    expect(collectionPill).toHaveClass("group-data-[state=open]:text-foreground");
    fireEvent.click(collectionSwitcher);
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Search collections" })).toHaveFocus();
    });

    // The menu is aligned to the trigger's label, so its offset must equal the
    // trigger's own horizontal padding — a restated number drifted the moment
    // the chrome inset changed. jsdom reports no padding for a class-only
    // rule, which is exactly the fallback path.
    const alignOffset = document
      .querySelector("[data-top-collection-menu]")
      ?.getAttribute("data-top-collection-menu-align-offset");
    const triggerPadding = Number.parseFloat(
      getComputedStyle(collectionSwitcher).paddingLeft,
    );
    expect(alignOffset).toBe(
      String(Number.isFinite(triggerPadding) && triggerPadding > 0 ? triggerPadding : 0),
    );
    expect(screen.getByRole("menuitem", { name: "Create collection" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Everything" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "beta" })).toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: "Search collections" });
    expect(search).toHaveAttribute("autocomplete", "off");
    expect(search).toHaveAttribute("autocorrect", "off");
    expect(search).toHaveAttribute("autocapitalize", "none");
    expect(search).toHaveAttribute("spellcheck", "false");
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "alpha" }));
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "alpha" } });
    expect(screen.getByRole("menuitem", { name: "Create collection" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "bet" } });
    expect(screen.queryByRole("menuitem", { name: "alpha" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "beta" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("beta:1");
    });
    expect(screen.getByRole("button", { name: "Switch collection: beta" })).not.toHaveFocus();
  });

  it("keeps collection search focused while arrow keys move the active descendant", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch collection: Everything" }));
    const search = await screen.findByRole("textbox", { name: "Search collections" });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    expect(search).toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("menuitem", { name: "alpha" })).toHaveAttribute(
      "data-search-menu-action-active",
      "true",
    );

    fireEvent.change(search, { target: { value: "b" } });
    expect(search).toHaveFocus();
    expect(search).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("beta:1");
    });
  });

  it("omits the active channel from the right top-chrome collection dropdown", async () => {
    render(
      <MemoryRouter initialEntries={["/channel/alpha"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch collection: alpha" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Search collections" })).toHaveFocus();
    });

    expect(screen.getByRole("menuitem", { name: "Everything" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "alpha" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "beta" })).toBeInTheDocument();
  });

  it("does not open the right top-chrome collection dropdown while starting a window drag", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const trigger = screen.getByRole("button", { name: "Switch collection: Everything" });
    fireEvent.pointerDown(trigger, {
      button: 0,
      pointerId: 1,
      clientX: 120,
      clientY: 12,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 132,
      clientY: 12,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 132,
      clientY: 12,
    });
    fireEvent.click(trigger);

    expect(screen.queryByRole("textbox", { name: "Search collections" })).not.toBeInTheDocument();
    // The backend drags the tab's window (SPEC_TABS.md, В23).
    expect(commandMocks.startWindowDrag).toHaveBeenCalledTimes(1);
  });

  it("creates a collection from the filter on Enter, first in the list, and opens one already called that", async () => {
    commandMocks.createChannel.mockClear();
    commandMocks.reorderChannels.mockClear();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const input = screen.getByRole("textbox", { name: "Find or create collection" });
    fireEvent.change(input, { target: { value: "Gamma" } });

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(commandMocks.createChannel).toHaveBeenCalledWith("Gamma");
    });
    // The new collection takes the first place; the others move down by one.
    await waitFor(() => {
      expect(commandMocks.reorderChannels).toHaveBeenCalledWith([
        { tag: "Gamma", position: 0 },
        { tag: "alpha", position: 1 },
        { tag: "beta", position: 2 },
      ]);
    });
    expect(input).toHaveValue("");

    // A name already taken, in any case, opens that collection instead.
    fireEvent.change(input, { target: { value: "ALPHA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commandMocks.createChannel).toHaveBeenCalledTimes(1);
  });

  it("creates a new channel from the pinned collection switcher action", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch collection: Everything" }));
    const search = await screen.findByRole("textbox", { name: "Search collections" });
    fireEvent.change(search, { target: { value: "gamma" } });
    fireEvent.click(screen.getByRole("menuitem", { name: "Create collection" }));
    const channelName = await screen.findByRole("textbox", { name: "Channel name" });
    expect(channelName).toHaveValue("gamma");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(commandMocks.createChannel).toHaveBeenCalledWith("gamma");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch collection: gamma" })).toBeInTheDocument();
    });
  });

  it("opens sidebar search from the native Shift-Command-F menu accelerator event", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const gridCallsBeforeSearch = commandMocks.listGridBlocks.mock.calls.length;

    fireEvent(
      window,
      new CustomEvent("surface-search-shortcut", {
        detail: { payload: "sidebar" },
      }),
    );

    const input = screen.getByRole("textbox", { name: "Find or create collection" });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(gridCallsBeforeSearch);
  });

  it("lets Grid own feed keyboard focus and sends a restore request after Detail closes", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("false");
    expect(screen.getByTestId("grid-detail-open")).toHaveTextContent("false");
    expect(screen.getByTestId("grid-restore")).toHaveTextContent("none:0");

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("true");
    expect(screen.getByTestId("grid-detail-open")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid-restore")).toHaveTextContent("alpha-block:1");
    });
  });

  it("ignores a retired compact Detail preference", async () => {
    localStorage.setItem("mine.compactDetailTopMenu", "true");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));
    expect(document.querySelector("[data-compact-detail-top-menu]")).not.toBeInTheDocument();
    expect(document.querySelector("[data-main-secondary-top-bar-content-segment]")).toBeInTheDocument();
  });

  it("copies the open card markdown path with Command-L", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    fireEvent.keyDown(screen.getByTestId("detail-title"), { key: "l", metaKey: true });

    expect(clipboardWriteText).toHaveBeenCalledWith("/vault/alpha-block.md");
    // Through the native clipboard, never the web API: WKWebView rejects the
    // latter whenever focus has moved, and the rejection is invisible.
    expect(webClipboardWriteText).not.toHaveBeenCalled();
  });

  it("does not copy a card path with Command-L when Detail is closed", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.keyDown(window, { key: "l", metaKey: true });

    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("navigates route history with Command brackets", async () => {
    render(
      <MemoryRouter
        initialEntries={["/", "/channel/alpha", "/channel/beta"]}
        initialIndex={2}
      >
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("beta:1");
    });

    fireEvent.keyDown(window, { key: "[", code: "BracketLeft", metaKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });

    fireEvent.keyDown(window, { key: "]", code: "BracketRight", metaKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("beta:1");
    });
  });

  it("allows route history shortcuts from an open Detail surface", async () => {
    render(
      <MemoryRouter initialEntries={["/", "/channel/alpha"]} initialIndex={1}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    fireEvent.keyDown(screen.getByTestId("detail-title"), {
      key: "[",
      code: "BracketLeft",
      metaKey: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    expect(screen.queryByTestId("detail-title")).not.toBeInTheDocument();
  });

  it("keeps sidebar channel order from channel positions when tag counts change", async () => {
    commandMocks.listTaxonomySnapshot.mockResolvedValue({
      generation: 1,
      tags: [
        { tag: "beta", count: 9 },
        { tag: "loose", count: 5 },
        { tag: "alpha", count: 1 },
      ],
      channels: [
        {
          tag: "alpha",
          title: "Alpha",
          description: null,
          color: null,
          icon: null,
          position: 0,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        },
        {
          tag: "beta",
          title: "Beta",
          description: null,
          color: null,
          icon: null,
          position: 1,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 9,
        },
      ],
      total_blocks: 2,
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "alpha" })).toBeInTheDocument();
    });

    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Everything 2",
      "alpha",
      "beta",
      "loose",
    ]);
  });

  it("shows migration overlay until the first sync finishes for a fresh derived store", async () => {
    commandMocks.openVault.mockResolvedValue(
      vaultOpenResult({
        derived_store_ready: false,
        migration_required: true,
      }),
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Preparing library…")).toBeInTheDocument();
    expect(screen.getByText(/Creating local index/)).toBeInTheDocument();

    fireEvent(
      window,
      new CustomEvent("vault-sync-finished", {
        detail: {
          payload: {
            path: "/vault",
            indexed: 2,
            errors: 0,
            error: null,
          },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Preparing library…")).not.toBeInTheDocument();
    });
  });

  it("routes detail deletion through the media confirmation dialog", async () => {
    commandMocks.prepareDeleteBlock.mockResolvedValue({
      slug: "alpha-block",
      markdown_file: "alpha-block.md",
      unused_media: [
        {
          path: "photo.png",
          file_name: "photo.png",
          kind: "image",
          referenced_by: [],
        },
      ],
      shared_media: [],
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete detail" }));

    await waitFor(() => {
      expect(commandMocks.prepareDeleteBlock).toHaveBeenCalledWith("alpha-block");
    });
    expect(commandMocks.deleteBlock).not.toHaveBeenCalled();
    expect(await screen.findByText("Delete element?")).toBeInTheDocument();
    expect(screen.getByText(/1 media file is only used by this element/)).toBeInTheDocument();

    const deletedSlugs: string[] = [];
    const onBlockDeleted = (event: Event) => {
      const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
      if (slug) deletedSlugs.push(slug);
    };
    window.addEventListener("block-deleted", onBlockDeleted);
    fireEvent.click(screen.getByRole("button", { name: "Keep media" }));

    await waitFor(() => {
      expect(commandMocks.deleteBlock).toHaveBeenCalledWith("alpha-block", false);
    });
    // Optimistic notice for overlay-owned result sets fires on confirm.
    expect(deletedSlugs).toEqual(["alpha-block"]);
    window.removeEventListener("block-deleted", onBlockDeleted);
  });

  it("updates the open detail when block:renamed arrives", async () => {
    let renamed = false;
    commandMocks.listGridBlocks.mockImplementation(async () => ({
      generation: 1,
      blocks: renamed
        ? [{ ...block(1, "Renamed Alpha"), title: "Renamed Alpha" }]
        : [{ ...block(1, "alpha-block"), title: "Alpha Title" }],
      total_blocks: 1,
      has_more: false,
    }));
    commandMocks.getBlock.mockImplementation(async (slug: string) =>
      slug === "Renamed Alpha"
        ? indexedBlock(1, "Renamed Alpha", "Renamed Alpha")
        : indexedBlock(1, slug, "Alpha Title"),
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));

    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("Alpha Title");
      expect(screen.getByTestId("grid-title-alpha-block")).toHaveTextContent("Alpha Title");
    });

    renamed = true;
    fireEvent(
      window,
      new CustomEvent("block:renamed", {
        detail: {
          payload: {
            old_slug: "alpha-block",
            new_slug: "Renamed Alpha",
          },
        },
      }),
    );

    await waitFor(() => {
      expect(commandMocks.getBlock).toHaveBeenCalledWith("Renamed Alpha");
      expect(screen.getByTestId("detail-title")).toHaveTextContent("Renamed Alpha");
      expect(screen.getByTestId("grid-title-Renamed Alpha")).toHaveTextContent("Renamed Alpha");
    });
  });

  it("re-reads the feed from its first card in the chosen order (SPEC_FEED_DISPLAY.md, Д8)", async () => {
    commandMocks.listGridBlocks.mockImplementation(async (_tag, _offset, limit, order) => {
      if (isSearchOverlayQuery(limit, order)) return gridSnapshot([]);
      return order === "oldest"
        ? gridSnapshot([block(1, "oldest-card"), block(2, "newest-card")])
        : gridSnapshot([block(2, "newest-card"), block(1, "oldest-card")]);
    });
    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith(undefined, 0, 200, "newest");

      act(() => setFeedSort("oldest"));

      await waitFor(() => {
        expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith(undefined, 0, 200, "oldest");
      });
      await waitFor(() => {
        expect(screen.getByTestId("grid-previews").textContent?.startsWith("oldest-card")).toBe(true);
      });
    } finally {
      window.localStorage.clear();
      reloadFeedDisplay();
    }
  });

  it("keeps the feed continuous when the order changes with pages loaded (Д8, В5.1)", async () => {
    const cards = Array.from({ length: 600 }, (_, index) => block(index + 1, `card-${index + 1}`));
    const ordered = (order?: string) => (order === "oldest" ? cards : [...cards].reverse());
    const slugsOf = (order: string, count: number) =>
      ordered(order).slice(0, count).map((item) => item.slug).join(",");
    // Pages of the new order wait until the test answers them, in the order it
    // chooses; every other page is answered at once.
    const held = new Map<number, () => void>();
    let holdOldest = true;
    commandMocks.listGridBlocks.mockImplementation(async (_tag, offset = 0, limit = 200, order) => {
      if (isSearchOverlayQuery(limit, order)) return gridSnapshot([]);
      const page = () => gridSnapshot(
        ordered(order).slice(offset, offset + limit),
        cards.length,
        offset + limit < cards.length,
      );
      if (order === "oldest" && holdOldest) {
        return new Promise<GridSnapshot>((resolve) => held.set(offset, () => resolve(page())));
      }
      return page();
    });
    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      // The first page and the one warmed behind it.
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:400"));

      act(() => setFeedSort("oldest"));
      await waitFor(() => expect(held.has(0)).toBe(true));
      // The feed asks for more while the new order's first page is on its way.
      fireEvent.click(screen.getByRole("button", { name: "Load more blocks" }));

      holdOldest = false;
      await act(async () => {
        held.get(0)?.();
        await Promise.resolve();
      });
      await act(async () => {
        held.get(400)?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:400"));
      expect(screen.getByTestId("grid-slugs").textContent).toBe(slugsOf("oldest", 400));

      // Paging goes on from where the new order's list ends.
      fireEvent.click(screen.getByRole("button", { name: "Load more blocks" }));
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:600"));
      expect(screen.getByTestId("grid-slugs").textContent).toBe(slugsOf("oldest", 600));
    } finally {
      window.localStorage.clear();
      reloadFeedDisplay();
    }
  });

  it("keeps a failed feed re-read visible, reads it again and then pages on (Г4.1, Д1.4)", async () => {
    const cards = Array.from({ length: 600 }, (_, index) => block(index + 1, `card-${index + 1}`));
    const page = (offset: number, limit: number) => gridSnapshot(
      cards.slice(offset, offset + limit),
      cards.length,
      offset + limit < cards.length,
    );
    let failReread = false;
    commandMocks.listGridBlocks.mockImplementation(async (_tag, offset = 0, limit = 200, order) => {
      if (isSearchOverlayQuery(limit, order)) return gridSnapshot([]);
      if (offset === 0 && failReread) {
        failReread = false;
        throw new Error("Feed read failed");
      }
      return page(offset, limit);
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    // The first page and the one warmed behind it.
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:400"));

    // The re-read of the feed fails while the collections read is still out.
    const taxonomy = deferred<TaxonomySnapshot>();
    commandMocks.listTaxonomySnapshot.mockReturnValueOnce(taxonomy.promise);
    failReread = true;
    const readsBefore = commandMocks.listGridBlocks.mock.calls.length;
    fireEvent(window, new CustomEvent("vault-sync-finished", {
      detail: { payload: { path: "/vault", indexed: 600, errors: 0, error: null } },
    }));
    await waitFor(() => expect(screen.getByText("Feed read failed")).toBeInTheDocument());

    // The collections answer later: the feed's error is not theirs to clear.
    await act(async () => {
      taxonomy.resolve({ generation: 2, tags: [], channels: [], total_blocks: 600 });
      await taxonomy.promise;
    });
    expect(screen.getByText("Feed read failed")).toBeInTheDocument();
    // The list on screen stays, and paging waits for the retry instead of
    // asking a failing store again (Д1.4).
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:400");
    fireEvent.click(screen.getByRole("button", { name: "Load more blocks" }));
    expect(commandMocks.listGridBlocks.mock.calls.slice(readsBefore)).not.toContainEqual(
      [undefined, 400, 200, "newest"],
    );

    // The failed read is retried on its own and its answer clears the error.
    await waitFor(
      () => expect(screen.queryByText("Feed read failed")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(commandMocks.listGridBlocks.mock.calls.slice(readsBefore)).toContainEqual(
      [undefined, 0, 400, "newest"],
    );

    // Then the list on screen pages on from where it ends.
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:600"));
    expect(commandMocks.listGridBlocks.mock.calls.slice(readsBefore)).toContainEqual(
      [undefined, 400, 200, "newest"],
    );
    expect(screen.getByTestId("grid-slugs").textContent).toBe(
      cards.map((item) => item.slug).join(","),
    );
  });

  describe("a next page that fails while the feed stands at its end (Д1.4)", () => {
    const cards = Array.from({ length: 1000 }, (_, index) => block(index + 1, `card-${index + 1}`));
    /// The feed's reads: the route's first page always answers; each next
    /// page is answered by `answerPage`, numbered from 1.
    function serveFeed(answerPage: (request: number, offset: number, limit: number) => Promise<GridSnapshot>) {
      let pageRequests = 0;
      commandMocks.listGridBlocks.mockImplementation(async (_tag, offset = 0, limit = 200, order) => {
        if (isSearchOverlayQuery(limit, order)) return gridSnapshot([]);
        if (offset === 0) return gridSnapshot(cards.slice(0, limit), cards.length, limit < cards.length);
        pageRequests += 1;
        return answerPage(pageRequests, offset, limit);
      });
      return { pageRequests: () => pageRequests };
    }
    const page = (offset: number, limit: number) => gridSnapshot(
      cards.slice(offset, offset + limit),
      cards.length,
      offset + limit < cards.length,
    );
    /// Simulated seconds, one at a time, so the feed renders between them.
    async function advanceSeconds(seconds: number) {
      for (let second = 0; second < seconds; second += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
    }

    it("asks again only on its own bounded retries, not as fast as the store answers", async () => {
      gridScroll.atEnd = true;
      // A loop that asks on every answer stops here, so the test ends either way.
      const LOOP_CAP = 50;
      const firstPage = deferred<GridSnapshot>();
      const feed = serveFeed((request) => {
        if (request === 1) return firstPage.promise;
        if (request > LOOP_CAP) return new Promise<GridSnapshot>(() => {});
        return Promise.reject(new Error("Page read failed"));
      });
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:200"));
      await waitFor(() => expect(feed.pageRequests()).toBe(1));

      vi.useFakeTimers();
      try {
        await act(async () => {
          firstPage.reject(new Error("Page read failed"));
          await vi.advanceTimersByTimeAsync(0);
        });
        await advanceSeconds(60);
        // The failed page and its three retries, 1, 4 and 15 s apart. The
        // feed's own requests at its end are refused meanwhile.
        expect(feed.pageRequests()).toBe(4);
        expect(screen.getByText("Page read failed")).toBeInTheDocument();
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:200");
      } finally {
        vi.useRealTimers();
      }
    });

    it("pages on once a retry reads the failed page", async () => {
      gridScroll.atEnd = true;
      const firstPage = deferred<GridSnapshot>();
      const feed = serveFeed((request, offset, limit) => {
        if (request === 1) return firstPage.promise;
        if (request === 2) return Promise.reject(new Error("Page read failed"));
        return Promise.resolve(page(offset, limit));
      });
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:200"));
      await waitFor(() => expect(feed.pageRequests()).toBe(1));

      vi.useFakeTimers();
      try {
        await act(async () => {
          firstPage.reject(new Error("Page read failed"));
          await vi.advanceTimersByTimeAsync(0);
        });
        // The first retry fails after 1 s, the second answers after 4 s more.
        await advanceSeconds(1);
        expect(feed.pageRequests()).toBe(2);
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:200");
        await advanceSeconds(4);
      } finally {
        vi.useRealTimers();
      }
      // The error is gone and the feed at its end pages on to the last card.
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1000"));
      expect(screen.queryByText("Page read failed")).not.toBeInTheDocument();
      expect(feed.pageRequests()).toBe(6);
    });
  });

  describe("errors over a feed that shows cards (Д2.2)", () => {
    it.each([
      ["a failed feed re-read", "Feed read failed", "feed"],
      ["a failed collections read", "Collections read failed", "collections"],
    ])("keeps the cards and shows %s as a notice", async (_case, message, source) => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      if (source === "feed") {
        commandMocks.listGridBlocks.mockImplementation(async (_tag, _offset, limit, order) => {
          if (isSearchOverlayQuery(limit ?? 0, order)) return gridSnapshot([]);
          throw new Error(message);
        });
      } else {
        commandMocks.listTaxonomySnapshot.mockRejectedValue(new Error(message));
      }
      fireEvent(window, new CustomEvent("vault-sync-finished", {
        detail: { payload: { path: "/vault", indexed: 2, errors: 0, error: null } },
      }));

      const error = await screen.findByText(message);
      expect(error.closest("[data-notification-card]")).not.toBeNull();
      expect(document.querySelector("[data-feed-error-block]")).toBeNull();
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    it("puts the error in the feed's place when the feed has nothing to show", async () => {
      commandMocks.listGridBlocks.mockImplementation(async (_tag, _offset, limit, order) => {
        if (isSearchOverlayQuery(limit ?? 0, order)) return gridSnapshot([]);
        throw new Error("Feed read failed");
      });
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );

      const error = await screen.findByText("Feed read failed");
      expect(error.closest("[data-feed-error-block]")).not.toBeNull();
      expect(document.querySelector("[data-notification-card]")).toBeNull();
    });
  });

  it("keeps a failed index pass through successful reads until a pass finishes (Д2.4)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    fireEvent(window, new CustomEvent("vault-sync-finished", {
      detail: { payload: { path: "/vault", indexed: 0, errors: 1, error: "Index pass failed" } },
    }));
    expect(await screen.findByText("Index pass failed")).toBeInTheDocument();

    // The feed and the collections are read again, and both answer.
    const gridReads = commandMocks.listGridBlocks.mock.calls.length;
    const taxonomyReads = commandMocks.listTaxonomySnapshot.mock.calls.length;
    fireEvent(window, new CustomEvent("tab-refresh-requested", { detail: { payload: null } }));
    await waitFor(() => {
      expect(commandMocks.listGridBlocks.mock.calls.length).toBeGreaterThan(gridReads);
      expect(commandMocks.listTaxonomySnapshot.mock.calls.length).toBeGreaterThan(taxonomyReads);
    });
    await act(async () => {
      await Promise.all([
        ...commandMocks.listGridBlocks.mock.results.slice(gridReads).map((result) => result.value),
        ...commandMocks.listTaxonomySnapshot.mock.results.slice(taxonomyReads).map((result) => result.value),
      ]);
    });
    // A successful read is not a repaired index.
    expect(screen.getByText("Index pass failed")).toBeInTheDocument();

    fireEvent(window, new CustomEvent("vault-sync-finished", {
      detail: { payload: { path: "/vault", indexed: 2, errors: 0, error: null } },
    }));
    await waitFor(() => expect(screen.queryByText("Index pass failed")).not.toBeInTheDocument());
  });

  it("carries one opening notice from the notes to the previews (О13)", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    const notices = () => document.querySelectorAll("[data-indexing-progress]");
    const send = (name: string, payload: object) => {
      fireEvent(window, new CustomEvent(name, { detail: { payload } }));
    };

    vi.useFakeTimers();
    try {
      send("vault-sync-progress", { path: "/vault", processed: 10, total: 643 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INDEXING_NOTICE_DELAY_MS);
      });
      expect(screen.getByText("Indexing “vault”")).toBeInTheDocument();

      // The preview pass is queued before the index pass reports its end,
      // so the card changes its title and never leaves the corner.
      send("derived-preview-queued", { path: "/vault" });
      send("vault-sync-finished", { path: "/vault", indexed: 643, errors: 0, error: null });
      expect(notices()).toHaveLength(1);
      expect(notices()[0]).toHaveAttribute("data-indexing-phase", "previews");
      expect(screen.queryByText("Indexing “vault”")).toBeNull();

      send("derived-preview-progress", { path: "/elsewhere", processed: 5, total: 9 });
      send("derived-preview-progress", { path: "/vault", processed: 120, total: 643 });
      expect(notices()).toHaveLength(1);
      expect(screen.getByText("120 / 643")).toBeInTheDocument();

      send("derived-preview-finished", { path: "/vault" });
      expect(notices()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["with cards", [block(1, "indexed-card")]],
    ["with no cards", []],
  ])("counts an empty feed as indexing until it is read again after the index, %s (В5.6)", async (_case, found) => {
    const reread = deferred<GridSnapshot>();
    let reads = 0;
    commandMocks.listGridBlocks.mockImplementation(async (_tag, _offset, limit, order) => {
      if (isSearchOverlayQuery(limit, order)) return gridSnapshot([]);
      reads += 1;
      return reads === 1 ? gridSnapshot([], 0, false, 1) : reread.promise;
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:0"));
    expect(screen.getByTestId("grid-indexing")).toHaveTextContent("true");

    fireEvent(window, new CustomEvent("vault-sync-finished", {
      detail: { payload: { path: "/vault", indexed: found.length, errors: 0, error: null } },
    }));
    // The feed is read again at once, not after the refresh debounce, and the
    // snapshot from before the index is not the final picture meanwhile.
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByTestId("grid-indexing")).toHaveTextContent("true");

    await act(async () => {
      reread.resolve(gridSnapshot(found, found.length, false, 2));
      await reread.promise;
    });
    await waitFor(() => expect(screen.getByTestId("grid-indexing")).toHaveTextContent("false"));
    expect(screen.getByTestId("grid")).toHaveTextContent(`__all__:${found.length}`);
  });

  it("marks the first saved card once, and only in a space that never had one", async () => {
    const commands = await import("@/lib/commands");
    vi.mocked(commands.firstCardMarkerPending).mockResolvedValue(true);
    commandMocks.listGridBlocks.mockImplementation(async () => ({
      generation: 1,
      blocks: [],
      total_blocks: 0,
      has_more: false,
    }));

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(vi.mocked(commands.firstCardMarkerPending)).toHaveBeenCalled();
    });

    fireEvent(
      window,
      new CustomEvent("block:added", {
        detail: { payload: { slug: "Cards/First clip", tags: [], is_text: false } },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("This card is a file")).toBeInTheDocument();
    });
    expect(screen.getByText(/First clip\.md/)).toBeInTheDocument();
    expect(vi.mocked(commands.completeFirstCardMarker)).toHaveBeenCalledTimes(1);

    // A second add never re-raises it.
    fireEvent.click(screen.getByLabelText("Dismiss"));
    fireEvent(
      window,
      new CustomEvent("block:added", {
        detail: { payload: { slug: "Cards/Second clip", tags: [], is_text: false } },
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("This card is a file")).not.toBeInTheDocument();
    });
    expect(vi.mocked(commands.completeFirstCardMarker)).toHaveBeenCalledTimes(1);
  });

  it("bumps only the affected card's thumb version on thumb:updated without reloading the feed", async () => {
    commandMocks.listGridBlocks.mockImplementation(async () => ({
      generation: 1,
      blocks: [block(1, "wide-clip")],
      total_blocks: 1,
      has_more: false,
    }));

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
    });
    expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent("wide-clip=0");

    const gridCallsBefore = commandMocks.listGridBlocks.mock.calls.length;

    // save_tile_poster / save_thumb rewrote the poster in place; the block row is
    // byte-identical, so a grid refetch would reconcile to a no-op for pixels
    // while streaming the scrolled range through IPC. Instead the affected card's
    // per-slug cache-buster is bumped so only that card refetches its thumbnail.
    fireEvent(
      window,
      new CustomEvent("thumb:updated", {
        detail: { payload: { slug: "wide-clip", is_text: false } },
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent("wide-clip=1");
    });

    // Let the coalesced refresh window (2s) elapse — the grid is never refetched
    // for a thumb-only update.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(commandMocks.listGridBlocks.mock.calls.length).toBe(gridCallsBefore);
  });

  it("does not bump the thumb version or reload the feed for a card outside the current feed", async () => {
    commandMocks.listGridBlocks.mockImplementation(async () => ({
      generation: 1,
      blocks: [block(1, "visible-card")],
      total_blocks: 1,
      has_more: false,
    }));

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
    });
    expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent("visible-card=0");

    const gridCallsBefore = commandMocks.listGridBlocks.mock.calls.length;

    fireEvent(
      window,
      new CustomEvent("thumb:updated", {
        detail: { payload: { slug: "off-screen-card", is_text: false } },
      }),
    );

    // Let the coalesced refresh window (2s) elapse — the feed must not reload
    // for a card it isn't currently showing, to keep the cold-start sweep cheap.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(commandMocks.listGridBlocks.mock.calls.length).toBe(gridCallsBefore);
    // The off-screen slug is not in the feed, so its version stays untouched.
    expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent("visible-card=0");
  });

  it("patches an article that initially had no picture without refetching the feed", async () => {
    const initial = block(1, "article");
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([initial, block(2, "unchanged")]));
    commandMocks.getGridRows.mockResolvedValue({ path: "/vault", generation: 2,
      blocks: [{ ...initial, preview_manifest: "ready-picture" }, block(3, "deleted")] });
    render(<MemoryRouter><AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    const before = commandMocks.listGridBlocks.mock.calls.length;
    for (let i = 0; i < 10; i++) fireEvent(window, new CustomEvent("thumb:updated", {
      detail: { payload: { slug: "article", is_text: false } },
    }));
    await waitFor(() => expect(screen.getByTestId("grid-previews")).toHaveTextContent("article:ready-picture"));
    expect(commandMocks.getGridRows).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(before);
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    expect(screen.queryByText("Open deleted")).not.toBeInTheDocument();
  });

  it("reads again a new card whose preview landed while the feed read was in flight", async () => {
    // The preview landed before the feed held the card, and the feed then
    // applied the card as read before the preview existed: without a second
    // read it would keep its provisional shape.
    const existing = block(1, "existing");
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([existing]));
    render(<MemoryRouter><AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1"));

    let finishRead!: (value: GridSnapshot) => void;
    commandMocks.listGridBlocks.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    fireEvent(window, new CustomEvent("vault-changed", { detail: { payload: { path: "/vault" } } }));
    await waitFor(() => expect(finishRead).toBeDefined(), { timeout: 3000 });

    const restored = block(2, "restored-video");
    fireEvent(window, new CustomEvent("thumb:updated", {
      detail: { payload: { path: "/vault", slug: "restored-video", is_text: false } },
    }));
    commandMocks.getGridRows.mockResolvedValue({ path: "/vault", generation: 3,
      blocks: [{ ...restored, preview_manifest: "square-poster", width: 1080, height: 1080 }] });
    await act(async () => finishRead(gridSnapshot([existing, restored], 2, false, 2)));

    await waitFor(() => expect(screen.getByTestId("grid-previews")).toHaveTextContent("restored-video:square-poster:1080"));
    expect(commandMocks.getGridRows).toHaveBeenCalledWith("/vault", ["restored-video"]);
  });

  it("ignores preview rows from another space or an older revision", async () => {
    const initial = block(1, "article");
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([initial], 1, false, 5));
    commandMocks.getGridRows
      .mockResolvedValueOnce({ path: "/other", generation: 9, blocks: [{ ...initial, preview_manifest: "wrong-space" }] })
      .mockResolvedValueOnce({ path: "/vault", generation: 4, blocks: [{ ...initial, preview_manifest: "old" }] });
    render(<MemoryRouter><AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1"));
    for (let i = 1; i <= 2; i++) {
      fireEvent(window, new CustomEvent("thumb:updated", { detail: { payload: { slug: "article", is_text: false } } }));
      await waitFor(() => expect(commandMocks.getGridRows).toHaveBeenCalledTimes(i));
    }
    expect(screen.getByTestId("grid-previews")).toHaveTextContent("article:none");
  });

  it("keeps a newer preview when an older full-route response completes later", async () => {
    const initial = block(1, "article");
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([initial]));
    render(<MemoryRouter><AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1"));
    let resolve!: (value: GridSnapshot) => void;
    commandMocks.listGridBlocks.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    fireEvent(window, new CustomEvent("vault-changed", { detail: { payload: { path: "/vault" } } }));
    await waitFor(() => expect(resolve).toBeDefined(), { timeout: 3000 });
    commandMocks.getGridRows.mockResolvedValue({ path: "/vault", generation: 3,
      blocks: [{ ...initial, preview_manifest: "new-preview" }] });
    fireEvent(window, new CustomEvent("thumb:updated", { detail: { payload: { path: "/vault", slug: "article", is_text: false } } }));
    await waitFor(() => expect(screen.getByTestId("grid-previews")).toHaveTextContent("new-preview"));
    await act(async () => resolve(gridSnapshot([initial, block(2, "added")], 2, false, 2)));
    expect(screen.getByTestId("grid-previews")).toHaveTextContent("new-preview");
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
  });

  it("ignores foreign preview events and avoids a full reload for preview-only reports", async () => {
    commandMocks.listGridBlocks.mockResolvedValue(gridSnapshot([block(1, "article")]));
    render(<MemoryRouter><AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1"));
    const before = commandMocks.listGridBlocks.mock.calls.length;
    fireEvent(window, new CustomEvent("thumb:updated", { detail: { payload: { path: "/other", slug: "article", is_text: false } } }));
    fireEvent(window, new CustomEvent("vault-changed", { detail: { payload: { path: "/vault", preview_only: true } } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
    expect(commandMocks.getGridRows).not.toHaveBeenCalled();
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(before);
    expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent("article=0");
  });

  it("refreshes a loaded image once when thumb readiness supplies missing geometry", async () => {
    const initial = {
      ...block(1, "new-image"),
      card_kind: "media" as const,
      block_type: "image" as const,
      media_file: "new-image.jpg",
      body: "",
    };
    const ready = {
      ...initial,
      width: 1586,
      height: 600,
      media_dimensions: "{\"new-image.jpg\":[1586,600]}",
    };
    commandMocks.getGridRows.mockResolvedValue({ path: "/vault", generation: 10, blocks: [ready] });
    let gridRequest = 0;
    commandMocks.listGridBlocks.mockImplementation(async () => {
      const current = gridRequest === 0 ? initial : ready;
      gridRequest += 1;
      return {
        generation: gridRequest,
        blocks: [current],
        total_blocks: 1,
        has_more: false,
      };
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:1");
    });
    const gridCallsBefore = commandMocks.listGridBlocks.mock.calls.length;

    fireEvent(
      window,
      new CustomEvent("thumb:updated", {
        detail: { payload: { slug: "new-image", is_text: false } },
      }),
    );

    await waitFor(() => {
      expect(commandMocks.getGridRows).toHaveBeenCalledWith("/vault", ["new-image"]);
      expect(commandMocks.listGridBlocks.mock.calls.length).toBe(gridCallsBefore);
      expect(screen.getByTestId("grid-previews")).toHaveTextContent("1586");
      expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent(
        "new-image=1",
      );
    });
  });

  describe("as one tab among many (SPEC_TABS.md)", () => {
    const send = (name: string, payload: unknown = null) => {
      fireEvent(window, new CustomEvent(name, { detail: { payload } }));
    };
    const tabView = (overrides: Partial<TabView> = {}): TabView => ({
      location: { kind: "everything" },
      mode: "grid",
      open_card: null,
      scroll_anchor: null,
      collection_filter: "",
      ...overrides,
    });
    const bootstrap = (overrides: Partial<TabBootstrap> = {}): TabBootstrap => ({
      tab_id: "a".repeat(32),
      window_id: "b".repeat(32),
      space: { kind: "space", vault_id: "vault-id" },
      view: tabView(),
      sidebar: { width_px: 360, collapsed: false },
      lead: true,
      fresh_start: false,
      chrome_rows: { tab_bar: 30, page: 30 },
      ...overrides,
    });
    const waitReportInterval = () => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TAB_VIEW_REPORT_DEBOUNCE_MS + 60));
    });
    const renderTab = (props: Partial<Parameters<typeof AppWithVault>[0]> = {}, entry = "/") => render(
      <MemoryRouter initialEntries={[entry]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} tabPage {...props} />
      </MemoryRouter>,
    );

    it("returns to its place, mode, card, link mode and filter, read first (В40, В78)", async () => {
      const view = tabView({
        location: { kind: "collection", tag: "alpha" },
        open_card: { slug: "alpha-block", title: "alpha-block" },
        collection_filter: "al",
      });
      const onRestored = vi.fn();
      renderTab({ restore: { path: "/vault", view, saved: view }, onRestored });

      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      // The restored collection is the first route read, not Everything.
      const feedReads = commandMocks.listGridBlocks.mock.calls
        .filter(([, , limit, order]) => !isSearchOverlayQuery(limit ?? 0, order));
      expect(feedReads[0]?.[0]).toBe("alpha");
      await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));
      // The saved link mode no longer filters anything: the switch left every
      // mode (03.10.2026), and the card reopens with every collection listed.
      expect(document.querySelector("[data-detail-link-mode-tabs]")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Find or create collection" })).toHaveValue("al");
      await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));

      // The backend already holds this view: nothing to report.
      await waitReportInterval();
      expect(commandMocks.reportTabView).not.toHaveBeenCalled();
    });

    it("restores Graph as the tab's mode", async () => {
      const view = tabView({ mode: "graph" });
      renderTab({ restore: { path: "/vault", view, saved: view } });
      expect(await screen.findByTestId("graph-view")).toHaveTextContent("__all__");
    });

    it("goes to Everything and leaves the card closed when they are gone, and reports it (В18)", async () => {
      commandMocks.getBlock.mockImplementation(async (slug: string) => (
        slug === "gone-card" ? null : indexedBlock(1, slug, slug)
      ));
      const view = tabView({
        location: { kind: "collection", tag: "gone" },
        open_card: { slug: "gone-card", title: "Gone card" },
        scroll_anchor: { slug: "gone-card", offset_px: 40 },
      });
      const onRestored = vi.fn();
      renderTab({ restore: { path: "/vault", view, saved: view }, onRestored });

      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      await waitFor(() => expect(onRestored).toHaveBeenCalled());
      expect(screen.queryByTestId("detail-title")).toBeNull();
      expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("none");

      await waitFor(() => {
        expect(commandMocks.reportTabView).toHaveBeenCalledWith(tabView());
      }, { timeout: 2000 });
    });

    it("hands the feed its scroll anchor once the card is loaded, and keeps it in memory until then", async () => {
      const view = tabView({ scroll_anchor: { slug: "beta-block", offset_px: 120 } });
      renderTab({ restore: { path: "/vault", view, saved: tabView() } });

      await waitFor(() => {
        expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("beta-block:120");
      });
      // Reported while still on its way back: the tab remembers the anchor.
      await waitFor(() => {
        expect(commandMocks.reportTabView).toHaveBeenLastCalledWith(view);
      }, { timeout: 2000 });

      fireEvent.click(screen.getByRole("button", { name: "Finish scroll restore" }));
      expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("none");
    });

    it("reads further pages until the scroll anchor's card is in the feed", async () => {
      const firstPage = Array.from({ length: 200 }, (_, index) => block(index + 1, `card-${index}`));
      const deep = block(500, "deep-card");
      commandMocks.listGridBlocks.mockImplementation(async (_tag, offset = 0, limit = 200, order) => {
        if (isSearchOverlayQuery(limit, order)) return gridSnapshot([]);
        return offset === 0
          ? gridSnapshot(firstPage, 201, true)
          : gridSnapshot([deep], 201, false);
      });
      const view = tabView({ scroll_anchor: { slug: "deep-card", offset_px: 8 } });
      renderTab({ restore: { path: "/vault", view, saved: view } });

      await waitFor(() => {
        expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("deep-card:8");
      });
      expect(commandMocks.listGridBlocks.mock.calls.some(([, offset]) => offset === 200)).toBe(true);
    });

    it("reports its memory at most once per interval, and at once when hidden (В31)", async () => {
      renderTab();
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      // A tab that opened a space anew tells the backend what it shows.
      await waitFor(() => expect(commandMocks.reportTabView).toHaveBeenCalledWith(tabView()));
      commandMocks.reportTabView.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Scroll feed" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Find or create collection" }), { target: { value: "be" } });
      fireEvent.keyDown(window, { key: "Tab" });
      expect(commandMocks.reportTabView).not.toHaveBeenCalled();

      await waitReportInterval();
      expect(commandMocks.reportTabView).toHaveBeenCalledTimes(1);
      expect(commandMocks.reportTabView).toHaveBeenLastCalledWith(tabView({
        mode: "graph",
        collection_filter: "be",
        scroll_anchor: { slug: "beta-block", offset_px: 12 },
      }));

      fireEvent.keyDown(window, { key: "Tab" });
      send("tab-visibility-changed", { visible: false });
      expect(commandMocks.reportTabView).toHaveBeenCalledTimes(2);
      expect(commandMocks.reportTabView).toHaveBeenLastCalledWith(tabView({
        collection_filter: "be",
        scroll_anchor: { slug: "beta-block", offset_px: 12 },
      }));
    });

    it("reports nothing on a page that is not a tab", async () => {
      renderTab({ tabPage: false });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      fireEvent.keyDown(window, { key: "Tab" });
      await waitReportInterval();
      expect(commandMocks.reportTabView).not.toHaveBeenCalled();
    });

    it("follows a collection and a card renamed in another tab, the card staying open (В18)", async () => {
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));

      send("vault-changed", {
        path: "/vault",
        renames: [
          { kind: "collection", from: "alpha", to: "alpha two" },
          { kind: "card", from: "alpha-block", to: "alpha-renamed" },
        ],
      });

      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha two:"));
      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "alpha-renamed.md" })).toBeInTheDocument();
      });
    });

    it("closes an open card another tab deleted, and leaves a collection that is gone (В18)", async () => {
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));

      commandMocks.getBlock.mockResolvedValue(null);
      send("vault-changed", { path: "/vault", renames: [] });
      await waitFor(() => expect(screen.queryByTestId("detail-title")).toBeNull());

      commandMocks.listTaxonomySnapshot.mockResolvedValue({
        generation: 2,
        tags: [{ tag: "beta", count: 1 }],
        channels: [],
        total_blocks: 2,
      });
      send("vault-changed", { path: "/vault", renames: [] });
      // The collections are read again at once when the index pass lands.
      send("vault-sync-finished", { path: "/vault", indexed: 2, errors: 0, error: null });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:"));
    });

    it("steps back and forward through its places when the tab bar asks (В81)", async () => {
      commandMocks.getBlock.mockImplementation(async (slug: string) => indexedBlock(1, slug, slug));
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(false, false));

      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, false));
      send("tab-go-everything");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      // The place is read two frames after it settles; its directions are
      // the same as before, so nothing new is reported.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, false);

      // Back to the card over its collection, not to the collection alone.
      send("tab-history-go", { forward: false });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, true));

      send("tab-history-go", { forward: false });
      await waitFor(() => expect(screen.queryByTestId("detail-title")).toBeNull());
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(false, true));

      send("tab-history-go", { forward: true });
      await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, true));
    });

    it("labels its tab with the open card's title (В47)", async () => {
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => {
        expect(commandMocks.reportTabView).toHaveBeenLastCalledWith(expect.objectContaining({
          open_card: expect.objectContaining({ slug: "alpha-block", title: "alpha-block" }),
        }));
      }, { timeout: 2000 });
    });

    it("goes to Everything with nothing open when the space is opened from outside (В72)", async () => {
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => expect(screen.getByTestId("detail-title")).toBeInTheDocument());

      send("tab-go-everything");

      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      expect(screen.queryByTestId("detail-title")).toBeNull();
    });

    it("keeps the space's notices and preview work to its lead tab (В19, В20)", async () => {
      const commands = await import("@/lib/commands");
      vi.mocked(commands.firstCardMarkerPending).mockResolvedValue(true);
      commandMocks.listGridBlocks.mockImplementation(async () => gridSnapshot([]));
      const view = (lead: boolean) => (
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} tabPage lead={lead} />
        </MemoryRouter>
      );
      const { rerender } = render(view(false));
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:0"));
      expect(vi.mocked(useThumbnailUpgrade)).toHaveBeenLastCalledWith(false);
      expect(document.querySelector("[data-cloud-recommendation]")).toBeNull();

      vi.useFakeTimers();
      try {
        send("vault-sync-progress", { path: "/vault", processed: 10, total: 643 });
        send("block:added", { slug: "Cards/First clip", tags: [], is_text: false });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(INDEXING_NOTICE_DELAY_MS);
        });
        expect(screen.queryByText("Indexing “vault”")).toBeNull();
        expect(screen.queryByText("This card is a file")).toBeNull();
        expect(vi.mocked(commands.completeFirstCardMarker)).not.toHaveBeenCalled();
        expect(commandMocks.spaceNoticeDismissed).not.toHaveBeenCalled();

        // This tab starts leading: it asks whether the notice was closed.
        rerender(view(true));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(commandMocks.spaceNoticeDismissed).toHaveBeenCalledWith("indexing");
        expect(vi.mocked(useThumbnailUpgrade)).toHaveBeenLastCalledWith(true);
        expect(screen.getByText("Indexing “vault”")).toBeInTheDocument();

        // Closed here: the backend keeps it closed for the next lead.
        fireEvent.click(screen.getByRole("button", { name: "Hide" }));
        expect(commandMocks.dismissSpaceNotice).toHaveBeenCalledWith("indexing");
        expect(screen.queryByText("Indexing “vault”")).toBeNull();
      } finally {
        vi.useRealTimers();
        vi.mocked(commands.firstCardMarkerPending).mockResolvedValue(false);
      }
    });

    it("hides the indexing notice another lead already closed (В20)", async () => {
      commandMocks.spaceNoticeDismissed.mockResolvedValue(true);
      renderTab({ lead: true });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      await waitFor(() => expect(commandMocks.spaceNoticeDismissed).toHaveBeenCalledWith("indexing"));

      vi.useFakeTimers();
      try {
        send("vault-sync-progress", { path: "/vault", processed: 10, total: 643 });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(INDEXING_NOTICE_DELAY_MS);
        });
        expect(screen.queryByText("Indexing “vault”")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("opens a space from the switcher in a new tab of this window (В52)", async () => {
      renderTab();
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      fireEvent.click(screen.getByRole("button", { name: "Open other space in a new tab" }));
      expect(commandMocks.newTab).toHaveBeenCalledWith("other-space-id");
    });

    it("offers no new tab on a page that is not a tab", async () => {
      renderTab({ tabPage: false });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      expect(screen.queryByRole("button", { name: "Open other space in a new tab" })).toBeNull();
    });

    describe("the page shell", () => {
      beforeEach(() => {
        vi.mocked(isTauri).mockReturnValue(true);
        commandMocks.getVaultPath.mockResolvedValue("/vault");
      });

      it("boots from the tab's bootstrap: the window's sidebar, then its changes (В56)", async () => {
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap({ sidebar: { width_px: 420, collapsed: true } }));
        render(<App />);
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        expect(sidebarResizeState.windowSidebar).toEqual({ width_px: 420, collapsed: true });

        send("window-sidebar-changed", { width_px: 500, collapsed: false });
        await waitFor(() => {
          expect(sidebarResizeState.windowSidebar).toEqual({ width_px: 500, collapsed: false });
        });
        expect(commandMocks.setWindowSidebar).not.toHaveBeenCalled();
      });

      it("reports its first frame, pauses its media when hidden and reports a frame when shown again (В5, В41)", async () => {
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap());
        render(<App />);
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        await waitFor(() => expect(commandMocks.tabPainted).toHaveBeenCalledTimes(1));

        const video = document.createElement("video");
        document.body.appendChild(video);
        const pause = vi.spyOn(video, "pause");
        try {
          send("tab-visibility-changed", { visible: false });
          expect(pause).toHaveBeenCalled();
          expect(isTabVisible()).toBe(false);

          send("tab-visibility-changed", { visible: true });
          expect(isTabVisible()).toBe(true);
          await waitFor(() => expect(commandMocks.tabPainted).toHaveBeenCalledTimes(2));
        } finally {
          video.remove();
        }
      });

      it("shows the space picker when its space is forgotten (В70)", async () => {
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap());
        render(<App />);
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

        send("tab-space-forgotten");

        expect(await screen.findByText("Vault Picker")).toBeInTheDocument();
      });

      it("takes the stored mode and sidebar into the first tab and window, once (В79)", async () => {
        localStorage.setItem("mine.mainViewMode", "graph");
        localStorage.setItem("mine:sidebar", JSON.stringify({ width: 420, collapsed: true }));
        localStorage.setItem("mine:recentTags", JSON.stringify(["alpha"]));
        // No saved windows were read at this launch.
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap({ fresh_start: true }));
        render(<App />);

        expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
        expect(commandMocks.setWindowSidebar).toHaveBeenCalledWith({ width_px: 420, collapsed: true });
        expect(sidebarResizeState.windowSidebar).toEqual({ width_px: 420, collapsed: true });
        expect(localStorage.getItem("mine.mainViewMode")).toBeNull();
        expect(localStorage.getItem("mine:sidebar")).toBeNull();
        expect(localStorage.getItem("mine:recentTags")).toBeNull();
        await waitFor(() => {
          expect(commandMocks.reportTabView).toHaveBeenCalledWith(tabView({ mode: "graph" }));
        }, { timeout: 2000 });
      });

      it("keeps the stored mode for the first space a tab opens from the picker (В79)", async () => {
        localStorage.setItem("mine.mainViewMode", "graph");
        commandMocks.getVaultPath.mockResolvedValue(null);
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap({ space: { kind: "picker" }, fresh_start: true }));
        render(<App />);

        expect(await screen.findByText("Vault Picker")).toBeInTheDocument();
        expect(localStorage.getItem("mine.mainViewMode")).toBeNull();

        send("vault-selected", { path: "/vault" });

        expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
      });

      it("keeps saved windows over the stored values and still deletes them (В79)", async () => {
        localStorage.setItem("mine.mainViewMode", "graph");
        localStorage.setItem("mine:sidebar", JSON.stringify({ width: 420, collapsed: true }));
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap({ fresh_start: false }));
        render(<App />);

        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        expect(screen.queryByTestId("graph-view")).toBeNull();
        expect(commandMocks.setWindowSidebar).not.toHaveBeenCalled();
        expect(sidebarResizeState.windowSidebar).toEqual({ width_px: 360, collapsed: false });
        expect(localStorage.getItem("mine.mainViewMode")).toBeNull();
        expect(localStorage.getItem("mine:sidebar")).toBeNull();
      });

      it("shows the next and the previous tab on ⌃Tab and ⌃⇧Tab, and leaves the menu's chords to the menu (В55, В57)", async () => {
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap());
        render(<App />);
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

        const input = screen.getByRole("textbox", { name: "Find or create collection" });
        fireEvent.keyDown(input, { key: "Tab", code: "Tab", ctrlKey: true });
        expect(commandMocks.activateAdjacentTab).toHaveBeenLastCalledWith(true);
        fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
        expect(commandMocks.activateAdjacentTab).toHaveBeenLastCalledWith(false);
        expect(commandMocks.activateAdjacentTab).toHaveBeenCalledTimes(2);

        // ⇧⌘] is the native menu's; a bare Tab is the view's.
        fireEvent.keyDown(window, { key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
        fireEvent.keyDown(window, { key: "Tab", code: "Tab" });
        expect(commandMocks.activateAdjacentTab).toHaveBeenCalledTimes(2);
        expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
      });

      it("draws no top line of its own under the tab bar, and keeps it on a page that is not a tab (В43)", async () => {
        commandMocks.getTabBootstrap.mockResolvedValue(bootstrap());
        const { unmount } = render(<App />);
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        expect(document.querySelector("[data-chrome-frame-edge=top]")).toBeNull();
        expect(document.querySelector("[data-chrome-frame-edge=bottom]")).not.toBeNull();
        expect(document.querySelector("[data-chrome-shell]")?.firstElementChild?.tagName).toBe("HEADER");
        unmount();

        commandMocks.getTabBootstrap.mockResolvedValue(null);
        render(<App />);
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        expect(document.querySelector("[data-chrome-frame-edge=top]")).not.toBeNull();
      });
    });
  });
});
