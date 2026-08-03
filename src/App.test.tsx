import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { ChannelDto, DeleteBlockPlan, GridSnapshot, IndexedBlock, LightBlock, TaxonomySnapshot, VaultOpenResult, VaultStats } from "@/types";
import { App, AppWithVault } from "./App";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";
import { SEARCH_OVERLAY_RECENT_LIMIT, SEARCH_OVERLAY_RESULT_LIMIT } from "@/components/SearchOverlay";

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
  return (
    (query !== undefined && limit === SEARCH_OVERLAY_RESULT_LIMIT) ||
    (query === undefined && limit === SEARCH_OVERLAY_RECENT_LIMIT)
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
  getVaultPath: vi.fn<() => Promise<string | null>>(),
  openVault: vi.fn<(path: string) => Promise<VaultOpenResult>>(),
  startVaultSync: vi.fn<() => Promise<boolean>>(),
  sweepVaultThumbnails: vi.fn<() => Promise<number>>(),
  listGridBlocks: vi.fn<(tag?: string, offset?: number, limit?: number, query?: string) => Promise<GridSnapshot>>(),
  listTaxonomySnapshot: vi.fn<() => Promise<TaxonomySnapshot>>(),
  getVaultStats: vi.fn<(currentCollection?: string | null) => Promise<VaultStats>>(),
  createChannel: vi.fn<(tag: string) => Promise<ChannelDto>>(),
  renameBlockFile: vi.fn(),
  prepareDeleteBlock: vi.fn<(slug: string) => Promise<DeleteBlockPlan>>(),
  deleteBlock: vi.fn<(slug: string, deleteUnusedMedia?: boolean) => Promise<boolean>>(),
  mergeBlocks: vi.fn<(orderedSlugs: string[]) => Promise<unknown>>(),
  getBlock: vi.fn(),
  extractInlineMedia: vi.fn(),
  extractTextSelection: vi.fn(),
  deleteTextSelection: vi.fn(),
  openSettingsWindow: vi.fn<() => Promise<void>>(async () => {}),
  setSidebarMenuCollapsed: vi.fn<(collapsed: boolean) => Promise<void>>(async () => {}),
}));

const sidebarResizeState = vi.hoisted(() => ({
  width: 300,
  collapsed: false,
  isResizing: false,
  toggleCollapsed: vi.fn(),
}));

const clipboardWriteText = vi.fn<(text: string) => Promise<void>>();

vi.mock("@/lib/commands", () => ({
  getVaultPath: commandMocks.getVaultPath,
  openVault: commandMocks.openVault,
  selectVault: vi.fn(),
  startVaultSync: commandMocks.startVaultSync,
  sweepVaultThumbnails: commandMocks.sweepVaultThumbnails,
  listGridBlocks: commandMocks.listGridBlocks,
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
  deleteChannel: vi.fn(),
  reorderCollections: vi.fn(),
  renameChannel: vi.fn(),
  renameBlockFile: commandMocks.renameBlockFile,
  deleteTagFromAll: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  prepareDeleteBlock: commandMocks.prepareDeleteBlock,
  deleteBlock: commandMocks.deleteBlock,
  mergeBlocks: commandMocks.mergeBlocks,
  getBlock: commandMocks.getBlock,
  extractInlineMedia: commandMocks.extractInlineMedia,
  extractTextSelection: commandMocks.extractTextSelection,
  deleteTextSelection: commandMocks.deleteTextSelection,
  openSettingsWindow: commandMocks.openSettingsWindow,
  setSidebarMenuCollapsed: commandMocks.setSidebarMenuCollapsed,
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
  useSidebarResize: () => ({
    width: sidebarResizeState.width,
    collapsed: sidebarResizeState.collapsed,
    isResizing: sidebarResizeState.isResizing,
    startResize: vi.fn(),
    updateResize: vi.fn(),
    endResize: vi.fn(),
    toggleCollapsed: sidebarResizeState.toggleCollapsed,
  }),
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
  }: {
    currentPath: string;
    surface?: string;
    topChromeCollapsed?: boolean;
  }) => (
    <button
      type="button"
      data-vault-switcher=""
      data-vault-switcher-surface={surface}
      data-vault-switcher-top-chrome-collapsed={String(topChromeCollapsed)}
    >
      {currentPath.split("/").pop() ?? currentPath}
    </button>
  ),
}));

vi.mock("@/components/SidebarResizeHandle", () => ({
  SidebarResizeHandle: () => null,
}));

vi.mock("@/components/Grid", () => ({
  Grid: ({
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
  }: {
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
  }) => (
    <div>
      <div data-testid="grid">{`${currentTag ?? "__all__"}:${blocks.length}`}</div>
      <div data-testid="grid-route-ready">{String(Boolean(routeSnapshotReady))}</div>
      <div data-testid="grid-detail-open">{String(Boolean(detailOpen))}</div>
      <div data-testid="grid-keyboard-disabled">{String(Boolean(keyboardNavigationDisabled))}</div>
      <div data-testid="grid-restore">{`${restoreFocusSlug ?? "none"}:${restoreFocusSequence ?? 0}`}</div>
      <div data-testid="grid-thumb-versions">
        {blocks.map((item) => `${item.slug}=${thumbVersions?.get(item.slug) ?? 0}`).join(",")}
      </div>
      <button type="button" onClick={() => onGroupSelectionStart?.()}>
        Start group selection
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
  ),
}));

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
          Close detail
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
    }: {
      orderedTags: Array<{ tag: string; count: number }>;
      totalBlocks: number;
      searchQuery?: string;
    }) => {
      const normalizedSearchQuery = searchQuery.trim().toLowerCase();
      const showEverything = !normalizedSearchQuery
        || "everything".includes(normalizedSearchQuery)
        || "__all__".includes(normalizedSearchQuery);

      return (
        <nav>
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

function dragPastChromeThreshold(element: HTMLElement, pointerId = 1) {
  fireEvent.pointerDown(element, {
    button: 0,
    pointerId,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(window, {
    pointerId,
    clientX: 18,
    clientY: 10,
  });
  fireEvent.pointerUp(window, {
    pointerId,
    clientX: 18,
    clientY: 10,
  });
  fireEvent.click(element);
}

describe("AppWithVault", () => {
  const startDragging = vi.fn(async () => {});
  const setBackgroundColor = vi.fn(async (_color: string) => {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(getCurrentWindow).mockReturnValue({
      startDragging,
      setBackgroundColor,
    } as never);
    localStorage.clear();
    sidebarResizeState.width = 300;
    sidebarResizeState.collapsed = false;
    sidebarResizeState.isResizing = false;
    clipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
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
    commandMocks.mergeBlocks.mockResolvedValue({});
    commandMocks.getBlock.mockImplementation(async (slug: string) => indexedBlock(1, slug, slug));
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      if (isSearchOverlayQuery(limit, query)) {
        return snapshots.get(tag ?? "__all__") ?? snapshots.get("__all__")!;
      }
      expect(offset).toBe(0);
      expect(limit).toBe(200);
      expect(query).toBeUndefined();
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
      expect(commandMocks.listGridBlocks).toHaveBeenCalledWith(undefined, 1, 200);
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
      expect(commandMocks.listGridBlocks).toHaveBeenCalledWith(undefined, 1, 200);
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
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(1, undefined, 0, 200);

    fireEvent.click(screen.getByRole("link", { name: "alpha" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
    await waitFor(() => {
      expect(document.querySelector("[data-main-secondary-stats-right]")).toHaveTextContent(
        "1 element in collection",
      );
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(2, "alpha", 0, 200);

    fireEvent.click(screen.getByRole("link", { name: "beta" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("beta:1");
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(3, "beta", 0, 200);

    fireEvent.click(screen.getByRole("link", { name: /Everything 2/ }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    await waitFor(() => {
      expect(document.querySelector("[data-main-secondary-stats-right]")).toHaveTextContent(
        "2 elements",
      );
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(4, undefined, 0, 200);
  });

  it("does not start a focus thumbnail sweep while startup sync is running", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    });
    fireEvent.focus(window);
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
    fireEvent.focus(window);
    await waitFor(() => {
      expect(commandMocks.sweepVaultThumbnails).toHaveBeenCalledTimes(1);
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
      expect(query).toBeUndefined();
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
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(1, undefined, 0, 200);
    expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith("alpha", 0, 200);
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
      expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith("alpha", 0, 200);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("detail-title")).not.toBeInTheDocument();
    });
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
    expect(topSidebarSegment?.querySelector("[data-top-chrome-space-separator]")).toBeInTheDocument();
    expect(topSidebarSegment?.querySelector("[data-top-chrome-search-separator]")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search elements" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-main-search-top-bar]")).toBeNull();
  });

  it("renders the main secondary top bar as a real shell row split across sidebar and content", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const secondaryBar = document.querySelector("[data-main-secondary-top-bar]") as HTMLElement | null;
    const sidebarSegment = document.querySelector(
      "[data-main-secondary-top-bar-sidebar-segment]",
    ) as HTMLElement | null;
    const contentSegment = document.querySelector(
      "[data-main-secondary-top-bar-content-segment]",
    ) as HTMLElement | null;
    expect(secondaryBar).toHaveClass("h-8", "border-b", "border-border", "bg-background");
    expect(sidebarSegment).toHaveStyle({ width: "var(--sidebar-width)" });
    expect(sidebarSegment).toHaveClass("border-r", "border-sidebar-border");
    expect(contentSegment).toHaveClass("flex-1");
    expect(sidebarSegment).toHaveTextContent("1 464 files260 .md1 204 media4,8 GB");
    expect(contentSegment).toHaveTextContent("2 elements");
    expect(sidebarSegment?.querySelector("[data-main-secondary-stats-left] > div")).toHaveClass(
      "gap-5",
    );
    expect(sidebarSegment?.querySelector("[data-main-secondary-stat-atom='files']")).toHaveTextContent(
      "1 464 files",
    );
    expect(sidebarSegment?.querySelector("[data-main-secondary-stat-atom='markdown']")).toHaveTextContent(
      "260 .md",
    );
    expect(sidebarSegment?.querySelector("[data-main-secondary-stats-left]")).toHaveClass(
      "text-tertiary-foreground",
    );
    expect(contentSegment?.querySelector("[data-main-secondary-stats-right]")).toHaveClass(
      "gap-5",
      "justify-start",
      "text-tertiary-foreground",
    );
    const viewSwitcher = contentSegment?.querySelector("[data-main-view-mode-switcher]") as HTMLElement | null;
    expect(viewSwitcher).not.toHaveClass("ml-auto");
    expect(viewSwitcher).toHaveClass("gap-2");
    expect(viewSwitcher).toHaveTextContent("View:GridGraph");
    expect(viewSwitcher?.firstElementChild).toHaveClass("text-tertiary-foreground");
    expect(within(viewSwitcher!).getByRole("button", { name: "Grid" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(viewSwitcher!).getByRole("button", { name: "Graph" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(viewSwitcher?.querySelector("[data-main-view-mode-control]")).toHaveClass(
      "text-muted-foreground",
    );
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
    fireEvent.click(within(viewSwitcher).getByRole("button", { name: "Graph" }));

    expect(localStorage.getItem("mine.mainViewMode")).toBe("graph");
    expect(await screen.findByTestId("graph-view")).toHaveTextContent("__all__");
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    expect(within(viewSwitcher).getByRole("button", { name: "Graph" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(within(viewSwitcher).getByRole("button", { name: "Grid" }));

    expect(localStorage.getItem("mine.mainViewMode")).toBe("grid");
    expect(await screen.findByTestId("grid")).toHaveTextContent("__all__:2");
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
    const secondaryBar = document.querySelector("[data-main-secondary-top-bar]") as HTMLElement;
    const trafficLightReserve = document.querySelector("[data-traffic-light-reserve]") as HTMLElement;
    expect(topSidebarSegment.parentElement).toHaveClass("bg-chrome");
    expect(trafficLightReserve).toHaveClass("bg-chrome");
    expect(secondaryBar).toHaveClass("bg-background");
    await waitFor(() => {
      expect(setBackgroundColor).toHaveBeenCalledWith("#fcfcfc");
    });

    fireEvent.keyDown(window, { key: "А", code: "KeyF", metaKey: true, shiftKey: true });
    const input = screen.getByRole("textbox", { name: "Filter collections" });
    fireEvent.change(input, { target: { value: "alp" } });
    expect(input.closest("[data-sidebar-top-search-surface]")).toHaveClass("bg-accent");

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });
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
    expect(document.querySelector("[data-top-chrome-settings-fallback]")).not.toBeInTheDocument();

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

    const topSettingsFallback = document.querySelector(
      "[data-top-chrome-settings-fallback]",
    ) as HTMLElement | null;
    expect(topSettingsFallback).toBeInTheDocument();
    expect(within(topSettingsFallback!).queryByRole("button", { name: "Graph" })).not.toBeInTheDocument();
    expect(within(topSettingsFallback!).queryByRole("button", { name: "Grid" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-main-view-mode-switcher]")).toBeInTheDocument();
    fireEvent.click(
      within(topSettingsFallback!).getByRole("button", { name: /Settings/ }),
    );
    expect(commandMocks.openSettingsWindow).toHaveBeenCalledTimes(1);
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

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    const secondarySidebarBar = document.querySelector(
      "[data-secondary-sidebar-link-mode-bar]",
    ) as HTMLElement | null;
    const secondaryDetailMenu = document.querySelector(
      "[data-secondary-detail-top-menu]",
    ) as HTMLElement | null;
    const secondaryContentSegment = document.querySelector(
      "[data-main-secondary-top-bar-content-segment]",
    ) as HTMLElement | null;
    expect(screen.getByRole("dialog")).toHaveAttribute("data-detail-top-chrome-mode", "external");
    expect(secondarySidebarBar).toBeInTheDocument();
    expect(secondaryDetailMenu).toBeInTheDocument();
    expect(secondaryContentSegment).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector("[data-main-secondary-top-bar]")).toHaveClass("bg-accent");
      expect(secondaryDetailMenu).toHaveAttribute("data-entered", "true");
      expect(secondarySidebarBar).toHaveAttribute("data-entered", "true");
    });
    expect(secondarySidebarBar).toHaveTextContent("Collections:");
    expect(within(secondarySidebarBar!).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(secondaryDetailMenu!).getByText("alpha-block")).toBeInTheDocument();
    expect(document.querySelector("[data-sidebar-link-mode-bar]")).not.toBeInTheDocument();
    expect(document.querySelector('[data-detail-top-menu="classic"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));

    expect(document.querySelector("[data-main-secondary-top-bar]")).toHaveClass("bg-background");
    expect(secondaryDetailMenu).toHaveAttribute("data-entered", "false");
    expect(secondarySidebarBar).toHaveAttribute("data-entered", "false");
    expect(document.querySelectorAll("[data-main-secondary-main-layer]")[0]).toHaveAttribute(
      "data-entered",
      "true",
    );
    expect(document.querySelectorAll("[data-main-secondary-main-layer]")[1]).toHaveAttribute(
      "data-entered",
      "true",
    );
    expect(within(secondaryContentSegment!).getByText("2 elements")).toBeInTheDocument();
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
    expect(topSidebarSegment?.querySelector("[data-top-chrome-space-separator]")).toBeInTheDocument();
    expect(topSidebarSegment?.querySelector("[data-top-chrome-search-separator]")).not.toBeInTheDocument();
    expect(document.querySelector("[data-top-chrome-space-measure]")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Filter collections" })).not.toBeInTheDocument();
    const collectionSwitcher = screen.getByRole("button", { name: "Switch collection: Everything" });
    expect(collectionSwitcher).toHaveClass("px-3");
    expect(collectionSwitcher).not.toHaveClass("px-6");
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
    const searchButton = screen.getByRole("button", { name: /Search elements/ });

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

  it("uses the native sidebar shortcut in Tauri and the keydown fallback in browsers", async () => {
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
      new CustomEvent("sidebar-toggle-shortcut", {
        detail: { payload: null },
      }),
    );
    expect(sidebarResizeState.toggleCollapsed).toHaveBeenCalledTimes(1);

    vi.mocked(isTauri).mockReturnValue(true);
    fireEvent.keyDown(window, {
      key: "ы",
      code: "KeyS",
      metaKey: true,
      ctrlKey: true,
    });
    expect(sidebarResizeState.toggleCollapsed).toHaveBeenCalledTimes(1);

    vi.mocked(isTauri).mockReturnValue(false);
    fireEvent.keyDown(window, {
      key: "ы",
      code: "KeyS",
      metaKey: true,
      ctrlKey: true,
    });
    expect(sidebarResizeState.toggleCollapsed).toHaveBeenCalledTimes(2);
  });

  it("projects the current sidebar state into the native View menu", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    sidebarResizeState.collapsed = true;

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(commandMocks.setSidebarMenuCollapsed).toHaveBeenCalledWith(true);
    });
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
      if (query) {
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
    const input = screen.getByRole("textbox", { name: "Filter collections" });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    const searchSurface = input.closest("[data-sidebar-top-search-surface]") as HTMLElement;
    expect(searchSurface).not.toHaveClass("bg-accent");
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

    expect(searchSurface).toHaveClass("bg-accent");
    fireEvent.click(screen.getByRole("button", { name: "Clear collection search" }));
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
    expect(searchSurface).not.toHaveClass("bg-accent");
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
    const input = screen.getByRole("textbox", { name: "Filter collections" });
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
    expect(collectionSwitcher).toHaveClass("px-[var(--top-collection-pad-x)]");
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

    expect(document.querySelector("[data-top-collection-menu]")).toHaveAttribute(
      "data-top-collection-menu-align-offset",
      "24",
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

    const input = screen.getByRole("textbox", { name: "Filter collections" });
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

    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid-restore")).toHaveTextContent("alpha-block:1");
    });
  });

  it("uses the compact global top menu for Detail when the setting is enabled", async () => {
    localStorage.setItem("mine.compactDetailTopMenu", "true");

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const collectionSwitcherBeforeOpen = screen.getByRole("button", {
      name: "Switch collection: Everything",
    });
    expect(collectionSwitcherBeforeOpen).toHaveClass("px-3");
    expect(document.querySelector("[data-compact-detail-top-menu]")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    const compactMenu = document.querySelector("[data-compact-detail-top-menu]") as HTMLElement;
    const sidebarSearchSurface = document.querySelector("[data-sidebar-top-search-surface]") as HTMLElement;
    const topSidebarSegment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement;
    expect(compactMenu).toBeInTheDocument();
    expect(topSidebarSegment.parentElement).toHaveClass("bg-chrome");
    expect(topSidebarSegment.parentElement).not.toHaveClass("bg-accent");
    expect(document.querySelector("[data-main-secondary-top-bar]")).not.toBeInTheDocument();
    expect(sidebarSearchSurface).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-detail-top-chrome-mode", "external");
    expect(within(sidebarSearchSurface).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(within(sidebarSearchSurface).getByRole("button", { name: "Connected" })).toHaveAttribute("aria-pressed", "false");
    expect(within(compactMenu).queryByRole("button", { name: "All" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(compactMenu).toHaveAttribute("data-entered", "true");
    });
    const compactCollectionSwitcher = screen.getByRole("button", {
      name: "Switch collection: Everything",
    });
    expect(compactCollectionSwitcher).toBe(collectionSwitcherBeforeOpen);
    expect(compactCollectionSwitcher).toHaveClass("px-3");
    const compactTitle = within(compactMenu).getByText("alpha-block");
    expect(compactTitle).toHaveAttribute(
      "data-compact-detail-card-title",
      "",
    );
    expect(compactTitle).toHaveClass("pl-0");
    fireEvent.click(compactCollectionSwitcher);
    const collectionSearch = await screen.findByRole("textbox", { name: "Search collections" });
    await waitFor(() => {
      expect(collectionSearch).toHaveFocus();
    });
    fireEvent.keyDown(collectionSearch, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Search collections" })).not.toBeInTheDocument();
    });

    fireEvent.click(within(compactMenu).getByLabelText("Close detail"));
    await waitFor(() => {
      expect(compactMenu).toHaveAttribute("data-entered", "false");
    });
    await waitFor(() => {
      expect(screen.getByTestId("grid-restore")).toHaveTextContent("alpha-block:1");
    });
  });

  it("keeps compact Detail top-chrome controls draggable without firing their click actions", async () => {
    localStorage.setItem("mine.compactDetailTopMenu", "true");

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

    const compactMenu = document.querySelector("[data-compact-detail-top-menu]") as HTMLElement;
    const sidebarSearchSurface = document.querySelector("[data-sidebar-top-search-surface]") as HTMLElement;
    const closeButton = within(compactMenu).getByLabelText("Close detail");
    dragPastChromeThreshold(closeButton, 1);

    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    expect(screen.getByTestId("grid-restore")).toHaveTextContent("none:0");

    const connectedButton = within(sidebarSearchSurface).getByRole("button", { name: "Connected" });
    dragPastChromeThreshold(connectedButton, 2);

    expect(startDragging).toHaveBeenCalledTimes(2);
    expect(connectedButton).toHaveAttribute("aria-pressed", "false");
    expect(within(sidebarSearchSurface).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const overflowButton = within(compactMenu)
      .getAllByRole("button")
      .find((button) => (
        button.getAttribute("aria-haspopup") === "menu"
        && !button.hasAttribute("data-top-collection-switcher")
      ));
    expect(overflowButton).toBeTruthy();
    dragPastChromeThreshold(overflowButton!, 3);

    expect(startDragging).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
  });

  it("omits the compact Detail link-mode control when the sidebar is collapsed", async () => {
    localStorage.setItem("mine.compactDetailTopMenu", "true");
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
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });

    expect(document.querySelector("[data-sidebar-top-link-mode-surface]")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connected" })).not.toBeInTheDocument();
    expect(startDragging).not.toHaveBeenCalled();
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
      expect(commandMocks.listGridBlocks.mock.calls.length).toBeGreaterThan(
        gridCallsBefore,
      );
      expect(screen.getByTestId("grid-thumb-versions")).toHaveTextContent(
        "new-image=1",
      );
    });
  });
});
