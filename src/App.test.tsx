import type { ReactNode } from "react";
import { forwardRef } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { GridSnapshot, LightBlock, TaxonomySnapshot, VaultOpenResult } from "@/types";
import { AppWithVault } from "./App";

const commandMocks = vi.hoisted(() => ({
  openVault: vi.fn<(path: string) => Promise<VaultOpenResult>>(),
  startVaultSync: vi.fn<() => Promise<boolean>>(),
  listGridBlocks: vi.fn<(tag?: string, offset?: number, limit?: number) => Promise<GridSnapshot>>(),
  listTaxonomySnapshot: vi.fn<() => Promise<TaxonomySnapshot>>(),
}));

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
  deleteTagFromAll: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  deleteBlock: vi.fn(),
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
  }: {
    blocks: LightBlock[];
    currentTag?: string;
  }) => <div data-testid="grid">{`${currentTag ?? "__all__"}:${blocks.length}`}</div>,
}));

vi.mock("@/components/Search", () => ({
  Search: () => null,
}));

vi.mock("@/components/Detail", () => ({
  Detail: () => null,
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

describe("AppWithVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
});
