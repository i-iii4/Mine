import type { ReactNode } from "react";
import { forwardRef } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { DeleteBlockPlan, GridSnapshot, IndexedBlock, LightBlock, TaxonomySnapshot, VaultOpenResult } from "@/types";
import { AppWithVault } from "./App";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";

const commandMocks = vi.hoisted(() => ({
  openVault: vi.fn<(path: string) => Promise<VaultOpenResult>>(),
  startVaultSync: vi.fn<() => Promise<boolean>>(),
  listGridBlocks: vi.fn<(tag?: string, offset?: number, limit?: number) => Promise<GridSnapshot>>(),
  listTaxonomySnapshot: vi.fn<() => Promise<TaxonomySnapshot>>(),
  renameBlockFile: vi.fn(),
  prepareDeleteBlock: vi.fn<(slug: string) => Promise<DeleteBlockPlan>>(),
  deleteBlock: vi.fn<(slug: string, deleteUnusedMedia?: boolean) => Promise<boolean>>(),
  getBlock: vi.fn(),
  extractInlineMedia: vi.fn(),
  extractTextSelection: vi.fn(),
}));

const clipboardWriteText = vi.fn<(text: string) => Promise<void>>();

vi.mock("@/lib/commands", () => ({
  getVaultPath: vi.fn(),
  openVault: commandMocks.openVault,
  selectVault: vi.fn(),
  startVaultSync: commandMocks.startVaultSync,
  listGridBlocks: commandMocks.listGridBlocks,
  listTaxonomySnapshot: commandMocks.listTaxonomySnapshot,
  createChannel: vi.fn(),
  deleteChannel: vi.fn(),
  reorderChannels: vi.fn(),
  renameChannel: vi.fn(),
  renameBlockFile: commandMocks.renameBlockFile,
  deleteTagFromAll: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  prepareDeleteBlock: commandMocks.prepareDeleteBlock,
  deleteBlock: commandMocks.deleteBlock,
  getBlock: commandMocks.getBlock,
  extractInlineMedia: commandMocks.extractInlineMedia,
  extractTextSelection: commandMocks.extractTextSelection,
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
    width: 300,
    collapsed: false,
    isResizing: false,
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
  VaultSwitcher: () => <button type="button">Vault Switcher</button>,
}));

vi.mock("@/components/SidebarResizeHandle", () => ({
  SidebarResizeHandle: () => null,
}));

vi.mock("@/components/Grid", () => ({
  Grid: ({
    blocks,
    currentTag,
    keyboardNavigationDisabled,
    restoreFocusSlug,
    restoreFocusSequence,
    onBlockClick,
  }: {
    blocks: LightBlock[];
    currentTag?: string;
    keyboardNavigationDisabled?: boolean;
    restoreFocusSlug?: string | null;
    restoreFocusSequence?: number;
    onBlockClick: (block: LightBlock) => void;
  }) => (
    <div>
      <div data-testid="grid">{`${currentTag ?? "__all__"}:${blocks.length}`}</div>
      <div data-testid="grid-keyboard-disabled">{String(Boolean(keyboardNavigationDisabled))}</div>
      <div data-testid="grid-restore">{`${restoreFocusSlug ?? "none"}:${restoreFocusSequence ?? 0}`}</div>
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

vi.mock("@/components/Search", () => ({
  Search: () => null,
}));

vi.mock("@/components/Detail", () => ({
  Detail: ({
    block,
    onClose,
    onRequestDelete,
  }: {
    block: LightBlock | IndexedBlock;
    onClose: () => void;
    onRequestDelete: (slug: string) => void;
  }) => (
    <div role="dialog" aria-label={`${block.slug}.md`} data-detail-root>
      <div data-testid="detail-title">{block.title ?? block.slug}</div>
      <button type="button" onClick={onClose}>
        Close detail
      </button>
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
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ThemeMenuButton", () => ({
  ThemeMenuButton: forwardRef(function ThemeMenuButton() {
    return null;
  }),
}));

vi.mock("@/components/Sidebar", async () => {
  const { Link } = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    Sidebar: ({
      orderedTags,
      totalBlocks,
    }: {
      orderedTags: Array<{ tag: string; count: number }>;
      totalBlocks: number;
    }) => (
      <nav>
        <Link to="/">Everything {totalBlocks}</Link>
        {orderedTags.map((tag) => (
          <Link key={tag.tag} to={`/channel/${encodeURIComponent(tag.tag)}`}>
            {tag.tag}
          </Link>
        ))}
      </nav>
    ),
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

describe("AppWithVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    commandMocks.renameBlockFile.mockReset();
    commandMocks.prepareDeleteBlock.mockResolvedValue({
      slug: "alpha-block",
      markdown_file: "alpha-block.md",
      unused_media: [],
      shared_media: [],
    });
    commandMocks.deleteBlock.mockResolvedValue(true);
    commandMocks.getBlock.mockImplementation(async (slug: string) => indexedBlock(1, slug, slug));
    commandMocks.listGridBlocks.mockImplementation(async (tag, offset, limit) => {
      expect(offset).toBe(0);
      expect(limit).toBe(200);
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
    expect(commandMocks.startVaultSync).toHaveBeenCalledTimes(1);
    expect(commandMocks.listTaxonomySnapshot).toHaveBeenCalledTimes(1);
    expect(commandMocks.listGridBlocks).toHaveBeenNthCalledWith(4, undefined, 0, 200);
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
    expect(screen.getByTestId("grid-restore")).toHaveTextContent("none:0");

    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
    });
    expect(screen.getByTestId("grid-keyboard-disabled")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "Close detail" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid-restore")).toHaveTextContent("alpha-block:1");
    });
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
