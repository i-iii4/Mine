import type { ReactNode } from "react";
import { forwardRef, useImperativeHandle } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { ChannelDto, DeleteBlockPlan, GridSnapshot, IndexedBlock, LightBlock, TaxonomySnapshot, VaultOpenResult, VaultStats } from "@/types";
import { AppWithVault } from "./App";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";

const commandMocks = vi.hoisted(() => ({
  openVault: vi.fn<(path: string) => Promise<VaultOpenResult>>(),
  startVaultSync: vi.fn<() => Promise<boolean>>(),
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
}));

const sidebarResizeState = vi.hoisted(() => ({
  width: 300,
  collapsed: false,
  isResizing: false,
}));

const clipboardWriteText = vi.fn<(text: string) => Promise<void>>();

vi.mock("@/lib/commands", () => ({
  getVaultPath: vi.fn(),
  openVault: commandMocks.openVault,
  selectVault: vi.fn(),
  startVaultSync: commandMocks.startVaultSync,
  listGridBlocks: commandMocks.listGridBlocks,
  listTaxonomySnapshot: commandMocks.listTaxonomySnapshot,
  getVaultStats: commandMocks.getVaultStats,
  createChannel: commandMocks.createChannel,
  deleteChannel: vi.fn(),
  reorderChannels: vi.fn(),
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
    toggleCollapsed: vi.fn(),
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
    onBlockClick: (block: LightBlock) => void;
    onGroupSelectionStart?: () => void;
  }) => (
    <div>
      <div data-testid="grid">{`${currentTag ?? "__all__"}:${blocks.length}`}</div>
      <div data-testid="grid-route-ready">{String(Boolean(routeSnapshotReady))}</div>
      <div data-testid="grid-detail-open">{String(Boolean(detailOpen))}</div>
      <div data-testid="grid-keyboard-disabled">{String(Boolean(keyboardNavigationDisabled))}</div>
      <div data-testid="grid-restore">{`${restoreFocusSlug ?? "none"}:${restoreFocusSequence ?? 0}`}</div>
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

vi.mock("@/components/ThemeMenuButton", () => ({
  ThemeMenuButton: forwardRef(function ThemeMenuButton({
    bottomActionBarHidden = false,
    onBottomActionBarHiddenChange,
  }: {
    bottomActionBarHidden?: boolean;
    onBottomActionBarHiddenChange?: (hidden: boolean) => void;
  }, ref) {
    useImperativeHandle(ref, () => ({ toggle: vi.fn() }), []);
    return (
      <>
        <button type="button">Settings</button>
        <button
          type="button"
          onClick={() => onBottomActionBarHiddenChange?.(!bottomActionBarHidden)}
        >
          Hide bottom menu
        </button>
      </>
    );
  }),
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
      ["__all__", { blocks: allBlocks, total_blocks: 2, has_more: false }],
      ["alpha", { blocks: alphaBlocks, total_blocks: 2, has_more: false }],
      ["beta", { blocks: betaBlocks, total_blocks: 2, has_more: false }],
    ]);

    commandMocks.openVault.mockResolvedValue(vaultOpenResult());
    commandMocks.startVaultSync.mockResolvedValue(true);
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
      expect(offset).toBe(0);
      expect(limit).toBe(200);
      expect(query).toBeUndefined();
      return snapshots.get(tag ?? "__all__") ?? snapshots.get("__all__")!;
    });
    commandMocks.listTaxonomySnapshot.mockResolvedValue({
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
      totalFileCount: 1466,
      markdownFileCount: 260,
      mediaFileCount: 1204,
      sourceBytes: 4_800_000_000,
      currentCollectionCardCount: currentCollection ? 1 : 2,
      currentCollection,
      updatedAtMs: 1,
    }));
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
        "1 card in channel",
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
        "2 cards",
      );
    });
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(4, undefined, 0, 200);
  });

  it("does not treat a pending uncached route as an authoritative empty grid", async () => {
    const alphaDeferred = deferred<GridSnapshot>();
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit, query) => {
      expect(offset).toBe(0);
      expect(limit).toBe(200);
      expect(query).toBeUndefined();
      if ((tag ?? "__all__") === "__all__") {
        return { blocks: [], total_blocks: 0, has_more: false };
      }
      if (tag === "alpha") {
        return alphaDeferred.promise;
      }
      return { blocks: [], total_blocks: 0, has_more: false };
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:0");
    });
    expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("true");

    fireEvent.click(await screen.findByRole("link", { name: "alpha" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:0");
    });
    expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("false");

    alphaDeferred.resolve({
      blocks: [block(1, "alpha-block")],
      total_blocks: 1,
      has_more: false,
    });

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
    });
    expect(screen.getByTestId("grid-route-ready")).toHaveTextContent("true");
  });

  it("loads the current route when navigation happens before the initial grid resolves", async () => {
    const allSnapshot: GridSnapshot = {
      blocks: [block(1, "alpha-block"), block(2, "beta-block")],
      total_blocks: 2,
      has_more: false,
    };
    const alphaSnapshot: GridSnapshot = {
      blocks: [block(1, "alpha-block")],
      total_blocks: 1,
      has_more: false,
    };
    const allDeferred = deferred<GridSnapshot>();

    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit) => {
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

  it("does not switch channels with keyboard shortcut while Detail is open", async () => {
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
    const gridCallsBeforeShortcut = commandMocks.listGridBlocks.mock.calls.length;

    fireEvent.keyDown(window, { key: "ArrowDown", metaKey: true, altKey: true });

    expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(gridCallsBeforeShortcut);
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
    expect(screen.queryByRole("textbox", { name: "Search cards" })).not.toBeInTheDocument();
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
    expect(sidebarSegment).toHaveTextContent("1 466 files260 .md1 204 media4,8 GB");
    expect(contentSegment).toHaveTextContent("2 cards");
    expect(sidebarSegment?.querySelector("[data-main-secondary-stats-left] > div")).toHaveClass(
      "gap-5",
    );
    expect(sidebarSegment?.querySelector("[data-main-secondary-stat-atom='files']")).toHaveTextContent(
      "1 466 files",
    );
    expect(sidebarSegment?.querySelector("[data-main-secondary-stat-atom='markdown']")).toHaveTextContent(
      "260 .md",
    );
    expect(sidebarSegment?.querySelector("[data-main-secondary-stats-left]")).toHaveClass(
      "text-tertiary-foreground",
    );
    expect(contentSegment?.querySelector("[data-main-secondary-stats-right]")).toHaveClass(
      "justify-start",
      "text-tertiary-foreground",
    );
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
    const input = screen.getByRole("textbox", { name: "Search channels" });
    fireEvent.change(input, { target: { value: "alp" } });
    expect(input.closest("[data-sidebar-top-search-surface]")).toHaveClass("bg-accent");

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });
  });

  it("hides the bottom action bar without losing Settings access", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Hide bottom menu" }));

    await waitFor(() => {
      expect(document.querySelector("[data-bottom-action-bar]")).not.toBeInTheDocument();
    });
    expect(localStorage.getItem("mine.bottomActionBarHidden")).toBe("true");

    const topSettingsFallback = document.querySelector(
      "[data-top-chrome-settings-fallback]",
    ) as HTMLElement | null;
    expect(topSettingsFallback).toBeInTheDocument();
    expect(
      within(topSettingsFallback!).getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
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
    expect(secondarySidebarBar).toHaveTextContent("Channels:");
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
    expect(within(secondaryContentSegment!).getByText("2 cards")).toBeInTheDocument();
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
    expect(screen.queryByRole("textbox", { name: "Search channels" })).not.toBeInTheDocument();
    const collectionSwitcher = screen.getByRole("button", { name: "Switch collection: Everything" });
    expect(collectionSwitcher).toHaveClass("px-3");
    expect(collectionSwitcher).not.toHaveClass("px-6");
  });

  it("keeps Command-F and the bottom action wired without rendering the hidden main search component", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const gridCallsBeforeSearchToggle = commandMocks.listGridBlocks.mock.calls.length;
    const searchButton = screen.getByRole("button", { name: /Search cards/ });

    fireEvent.click(searchButton);
    expect(searchButton).not.toHaveAttribute("data-action-selected");
    fireEvent.keyDown(window, { key: "f", code: "KeyF", metaKey: true });

    expect(screen.queryByRole("textbox", { name: "Search cards" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-main-search-top-bar]")).toBeNull();
    expect(commandMocks.listGridBlocks).toHaveBeenCalledTimes(gridCallsBeforeSearchToggle);
  });

  it("keeps the native main-search accelerator event wired without rendering the hidden component", async () => {
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

    expect(screen.queryByRole("textbox", { name: "Search cards" })).not.toBeInTheDocument();
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
    const input = screen.getByRole("textbox", { name: "Search channels" });
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
    expect(screen.queryByRole("button", { name: "Clear channel search" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "alp" } });

    expect(searchSurface).toHaveClass("bg-accent");
    fireEvent.click(screen.getByRole("button", { name: "Clear channel search" }));
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
    expect(searchSurface).not.toHaveClass("bg-accent");
    expect(screen.queryByRole("button", { name: "Clear channel search" })).not.toBeInTheDocument();

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
    const input = screen.getByRole("textbox", { name: "Search channels" });
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
    expect(collectionSwitcher).toHaveClass("px-6");
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
    expect(screen.getByRole("menuitem", { name: "Create channel" })).toBeInTheDocument();
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
    expect(screen.getByRole("menuitem", { name: "Create channel" })).toBeInTheDocument();

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Create channel" }));
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

    const input = screen.getByRole("textbox", { name: "Search channels" });
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
    expect(await screen.findByText("Delete card?")).toBeInTheDocument();
    expect(screen.getByText(/1 media file is only used by this card/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep media" }));

    await waitFor(() => {
      expect(commandMocks.deleteBlock).toHaveBeenCalledWith("alpha-block", false);
    });
  });

  it("updates the open detail when block:renamed arrives", async () => {
    let renamed = false;
    commandMocks.listGridBlocks.mockImplementation(async () => ({
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
});
