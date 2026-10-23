import { commandById, setCommandOverrides } from "@/lib/commandRegistry";
import { getFeedDisplay, reloadFeedDisplay, setFeedSort } from "@/lib/feedDisplay";
import {
  GRAPH_PREFERENCES_STORAGE_KEY,
  reloadGraphPreferences,
  type GraphPreferences,
} from "@/lib/graphPreferences";
import { reportCardsRendered } from "@/lib/startup";
import { clearActionFailures } from "@/lib/actionFailures";
import { isTabVisible, setTabVisible } from "@/lib/tabVisibility";
import { TAB_VIEW_REPORT_DEBOUNCE_MS } from "@/lib/tabPage";
import { useThumbnailUpgrade } from "@/hooks/useThumbnailUpgrade";
import type { ReactNode } from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { isTauri } from "@tauri-apps/api/core";

import type { ChannelDto, CollectionDeleted, DeleteBlockMedia, DeleteBlockOutcome, DeleteBlockPlan, DeleteBlocksOutcome, DeleteBlocksPlan, GridSnapshot, IndexedBlock, LightBlock, SidebarLayout, SidebarOverlay, TabBootstrap, TabLocation, TabView, TaxonomySnapshot, VaultOpenResult } from "@/types";
import { App, AppWithVault } from "./App";
import { APP_MAIN_MIN_WIDTH_PX, APP_MIN_WIDTH_PX } from "@/lib/appLayout";
import { SEARCH_OVERLAY_RECENT_LIMIT, SEARCH_OVERLAY_RESULT_LIMIT } from "@/components/SearchOverlay";
import { INDEXING_NOTICE_DELAY_MS } from "@/components/IndexingProgress";
import { indexedBlock as completeIndexedBlock, lightBlock } from "@/test/blocks";

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
function isSearchOverlayQuery(limit: number | undefined, query?: string): boolean {
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
  // Every place a feed read asked for, as sent: the mock above hears a
  // collection's tag (`undefined` on Everything and in an author's feed).
  gridPlaces: [] as TabLocation[],
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
  createBlock: vi.fn(async () => ({}) as IndexedBlock),
  readClipboardPayload: vi.fn(async () => ({ kind: "empty" }) as const),
  listTaxonomySnapshot: vi.fn<() => Promise<TaxonomySnapshot>>(),
  createChannel: vi.fn<(tag: string) => Promise<ChannelDto>>(),
  reorderChannels: vi.fn(async (_items: { tag: string; position: number }[]) => undefined),
  renameBlockFile: vi.fn(),
  prepareDeleteBlock: vi.fn<(slug: string) => Promise<DeleteBlockPlan>>(),
  deleteBlock: vi.fn<(slug: string, deleteUnusedMedia?: boolean, offeredMedia?: string[]) => Promise<DeleteBlockOutcome>>(),
  prepareDeleteBlocks: vi.fn<(slugs: string[]) => Promise<DeleteBlocksPlan>>(),
  deleteBlocks: vi.fn<(slugs: string[], deleteUnusedMedia: boolean, offeredMedia?: string[]) => Promise<DeleteBlocksOutcome>>(),
  deleteChannel: vi.fn<(tag: string) => Promise<CollectionDeleted>>(),
  mergeBlocks: vi.fn<(orderedSlugs: string[]) => Promise<unknown>>(),
  getBlock: vi.fn(),
  addTag: vi.fn(async (_slug: string, _tag: string) => undefined),
  removeTag: vi.fn(async (_slug: string, _tag: string) => undefined),
  setBlocksMembership: vi.fn(async (_slugs: string[], _tag: string, _connected: boolean) => undefined),
  checkCollectionName: vi.fn(async (_oldTag: string | null, _name: string): Promise<string | null> => null),
  extractTextSelection: vi.fn(),
  deleteTextSelection: vi.fn(),
  openSettingsWindow: vi.fn<() => Promise<void>>(async () => {}),
  // The page as a tab (SPEC_TABS.md, «Команды»).
  getTabBootstrap: vi.fn<() => Promise<TabBootstrap | null>>(async () => null),
  reportTabView: vi.fn<(view: TabView) => Promise<void>>(async () => {}),
  reportTabHistory: vi.fn<(back: boolean, forward: boolean) => Promise<void>>(async () => {}),
  tabPainted: vi.fn<() => Promise<void>>(async () => {}),
  setWindowSidebar: vi.fn<(sidebar: SidebarLayout) => Promise<void>>(async () => {}),
  reportSidebarOverlay: vi.fn<(overlay: SidebarOverlay) => Promise<void>>(async () => {}),
  startWindowDrag: vi.fn<() => Promise<void>>(async () => {}),
  reportWindowSurface: vi.fn<(color: string) => Promise<void>>(async () => {}),
  newTab: vi.fn<(vaultId?: string) => Promise<void>>(async () => {}),
  activateAdjacentTab: vi.fn<(forward: boolean) => Promise<void>>(async () => {}),
}));

const sidebarResizeState = vi.hoisted(() => ({
  width: 300,
  collapsed: false,
  isResizing: false,
  widthAnimating: false,
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
  listVaultConflictPaths: vi.fn(async (): Promise<string[]> => []),
  listVaultConflicts: vi.fn(async () => []),
  resolveVaultConflict: vi.fn(async () => undefined),
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
  listGridBlocks: (place: TabLocation, ...rest: [offset?: number, limit?: number, order?: string]) => {
    commandMocks.gridPlaces.push(place);
    return commandMocks.listGridBlocks(place.kind === "collection" ? place.tag : undefined, ...rest);
  },
  listCardAssociations: commandMocks.listCardAssociations,
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
  createChannel: commandMocks.createChannel,
  reorderChannels: commandMocks.reorderChannels,
  deleteChannel: commandMocks.deleteChannel,
  reorderCollections: vi.fn(),
  renameChannel: vi.fn(),
  checkCollectionName: commandMocks.checkCollectionName,
  renameBlockFile: commandMocks.renameBlockFile,
  addTag: commandMocks.addTag,
  removeTag: commandMocks.removeTag,
  setBlocksMembership: commandMocks.setBlocksMembership,
  isCollectionNotFound: (error: unknown) => Boolean(error) && typeof error === "object"
    && (error as { kind?: unknown }).kind === "collection_not_found",
  prepareDeleteBlock: commandMocks.prepareDeleteBlock,
  deleteBlock: commandMocks.deleteBlock,
  prepareDeleteBlocks: commandMocks.prepareDeleteBlocks,
  deleteBlocks: commandMocks.deleteBlocks,
  mergeBlocks: commandMocks.mergeBlocks,
  getBlock: commandMocks.getBlock,
  extractTextSelection: commandMocks.extractTextSelection,
  deleteTextSelection: commandMocks.deleteTextSelection,
  openSettingsWindow: commandMocks.openSettingsWindow,
  getTabBootstrap: commandMocks.getTabBootstrap,
  reportTabView: commandMocks.reportTabView,
  reportTabHistory: commandMocks.reportTabHistory,
  tabPainted: commandMocks.tabPainted,
  setWindowSidebar: commandMocks.setWindowSidebar,
  reportSidebarOverlay: commandMocks.reportSidebarOverlay,
  startWindowDrag: commandMocks.startWindowDrag,
  reportWindowSurface: commandMocks.reportWindowSurface,
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
  useSidebarResize: (windowSidebar: { width_px: number; collapsed: boolean } | null = null, overlaid = false) => {
    sidebarResizeState.windowSidebar = windowSidebar;
    return {
      width: sidebarResizeState.width,
      collapsed: sidebarResizeState.collapsed,
      isResizing: sidebarResizeState.isResizing,
      widthAnimating: sidebarResizeState.widthAnimating,
      besideShown: !overlaid,
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
    onOpenInNewTab,
  }: {
    currentPath: string;
    surface?: string;
    topChromeCollapsed?: boolean;
    onOpenInNewTab?: (vaultId: string) => void;
  }) => (
    <>
      <button
        type="button"
        data-vault-switcher=""
        data-vault-switcher-surface={surface}
        data-vault-switcher-top-chrome-collapsed={String(topChromeCollapsed)}
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

// The card thumbnails the Sidebar mock shows in its collection rows.
const sidebarMockState = vi.hoisted(() => ({
  thumbnails: [] as Array<{ tag: string; slug: string; dragId?: string }>,
}));

vi.mock("@/components/Grid", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  function MockGrid({
    blocks,
    currentTag,
    location,
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
    onCreateAndAssign,
    onCreateAndAssignBatch,
    onDeleteSelectedBlocks,
    onBatchSetTag,
    onToggleTag,
  }: {
    onBatchSetTag?: (slugs: string[], tag: string, connected: boolean) => void | Promise<unknown>;
    onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void | Promise<unknown>;
    onCreateAndAssign?: (tag: string, blockSlug: string) => void | Promise<void>;
    onCreateAndAssignBatch?: (tag: string, slugs: string[]) => void | Promise<void>;
    onDeleteSelectedBlocks?: (
      slugs: string[],
      deleteUnusedMedia: boolean,
      offeredMedia: DeleteBlockMedia[],
    ) => Promise<void>;
    restoreScrollAnchor?: { slug: string; offset_px: number } | null;
    onScrollAnchorRestored?: () => void;
    onScrollPositionChange?: (read: () => { slug: string; offset_px: number } | null) => void;
    blocks: LightBlock[];
    currentTag?: string;
    location?: TabLocation;
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
        <div data-testid="grid">
          {`${location?.kind === "author" ? `author ${location.author}` : currentTag ?? "__all__"}:${blocks.length}`}
        </div>
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
        {/* `Create collection` in a card's picker and in the group selection's. */}
        <button type="button" onClick={() => void onCreateAndAssign?.("gamma", "alpha-block")}>
          Create gamma for alpha-block
        </button>
        <button
          type="button"
          onClick={() => void onCreateAndAssignBatch?.("gamma", ["alpha-block", "beta-block"])}
        >
          Create gamma for the selection
        </button>
        {/* The group selection's Disconnect and Connect, and one card's
            Connect in its picker, as Grid hands them on. */}
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(onBatchSetTag?.(["alpha-block", "beta-block"], "alpha", false))
              .catch(() => undefined);
          }}
        >
          Disconnect the selection from alpha
        </button>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(onBatchSetTag?.(["alpha-block", "beta-block"], "beta", true))
              .catch(() => undefined);
          }}
        >
          Connect the selection to beta
        </button>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(onToggleTag?.("alpha-block", "beta", false)).catch(() => undefined);
          }}
        >
          Connect alpha-block to beta
        </button>
        {/* The group delete window's `Delete`, which offered one file. */}
        <button
          type="button"
          onClick={() => {
            void onDeleteSelectedBlocks?.(
              ["alpha-block", "beta-block"],
              true,
              [{ path: "Media/photo.png", file_name: "photo.png", kind: "image", referenced_by: ["alpha-block"] }],
            ).catch(() => undefined);
          }}
        >
          Delete the selection with its media
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
  GraphView: ({
    currentCollection,
    graphPreferences,
  }: {
    currentCollection?: string;
    graphPreferences: GraphPreferences;
  }) => (
    <div data-testid="graph-view" data-graph-preferences={JSON.stringify(graphPreferences)}>
      {currentCollection ?? "__all__"}
    </div>
  ),
}));

vi.mock("@/components/Detail", () => ({
  Detail: ({
    block,
    topChromeMode,
    onClose,
    onRequestDelete,
    onOpenAuthorFeed,
  }: {
    block: LightBlock | IndexedBlock;
    topChromeMode?: "classic" | "external";
    onClose: () => void;
    onRequestDelete: (slug: string) => void;
    onOpenAuthorFeed?: (author: string) => void;
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
      {/* A related note's row deletes another card. */}
      <button type="button" onClick={() => onRequestDelete("beta-block")}>
        Delete related note
      </button>
      {/* The author heading of an association block. */}
      <button type="button" onClick={() => onOpenAuthorFeed?.("@kotecinho")}>
        Open author feed
      </button>
    </div>
  ),
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
  const { useDraggable, useDroppable } = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  /// A collection row as the real one takes a drop: `tag:<name>`, marked for
  /// the pointer's hit test (`sidebarDropIdFromPoint`).
  function MockCollectionRow({ tag, children }: { tag: string; children: ReactNode }) {
    const { setNodeRef } = useDroppable({ id: `tag:${tag}` });
    return (
      <div ref={setNodeRef} data-sidebar-row="" data-sidebar-row-key={`tag:${tag}`}>
        {children}
      </div>
    );
  }
  /// A strip thumbnail as the real Sidebar drags it (Sidebar.test.tsx checks
  /// that shape): only the card's slug and the row's collection. `dragId`
  /// stands in another draggable under its own id, a feed card's.
  function MockThumbnail({ tag, slug, dragId }: { tag: string; slug: string; dragId?: string }) {
    const { listeners, setNodeRef } = useDraggable({
      id: dragId ?? `sidebar-thumbnail:tag:${tag}:${slug}:0`,
      data: { type: "block", slug, sourceTag: tag },
    });
    return <span ref={setNodeRef} {...listeners} data-sidebar-mock-thumbnail={slug} />;
  }
  return {
    Sidebar: ({
      orderedTags,
      totalBlocks,
      searchQuery = "",
      topRow = null,
      isDropDragging = false,
      onDeleteTag,
      onCreateChannel,
      onNavClick,
    }: {
      orderedTags: Array<{ tag: string; count: number }>;
      totalBlocks: number;
      searchQuery?: string;
      topRow?: ReactNode;
      isDropDragging?: boolean;
      onDeleteTag?: (tag: string) => void | Promise<void>;
      onCreateChannel?: (tag: string) => void | Promise<void>;
      onNavClick?: () => void;
    }) => {
      const normalizedSearchQuery = searchQuery.trim().toLowerCase();
      const showEverything = !normalizedSearchQuery
        || "everything".includes(normalizedSearchQuery)
        || "__all__".includes(normalizedSearchQuery);

      return (
        <nav data-sidebar-mock="" data-sidebar-mock-drop-dragging={String(isDropDragging)}>
          {topRow}
          {/* The creation row's `Create`: a refusal comes back to the row. */}
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(onCreateChannel?.("gamma")).catch(() => undefined);
            }}
          >
            Create collection gamma
          </button>
          {showEverything && <Link to="/" onClick={onNavClick}>Everything {totalBlocks}</Link>}
          {orderedTags
            .filter((tag) => !normalizedSearchQuery || tag.tag.toLowerCase().includes(normalizedSearchQuery))
            .map((tag) => (
              <MockCollectionRow key={tag.tag} tag={tag.tag}>
                <Link to={`/channel/${encodeURIComponent(tag.tag)}`} onClick={onNavClick}>
                  {tag.tag}
                </Link>
                {sidebarMockState.thumbnails
                  .filter((thumbnail) => thumbnail.tag === tag.tag)
                  .map((thumbnail) => (
                    <MockThumbnail
                      key={thumbnail.slug}
                      tag={thumbnail.tag}
                      slug={thumbnail.slug}
                      dragId={thumbnail.dragId}
                    />
                  ))}
                {/* `Delete collection?`'s `Delete`: the window closed on it. */}
                <button type="button" onClick={() => void onDeleteTag?.(tag.tag)}>
                  {`Delete collection ${tag.tag}`}
                </button>
              </MockCollectionRow>
            ))}
        </nav>
      );
    },
  };
});

function block(id: number, slug: string): LightBlock {
  return lightBlock({
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
  });
}

function indexedBlock(id: number, slug: string, title = slug): IndexedBlock {
  return completeIndexedBlock({
    ...block(id, slug),
    title,
    description: null,
    source: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
  });
}

function vaultOpenResult(overrides: Partial<VaultOpenResult> = {}): VaultOpenResult {
  return {
    indexed: 2,
    errors: 0,
    sync_in_progress: false,
    derived_store_ready: true,
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
    // A tab's notices live in its page; each test is a page of its own.
    clearActionFailures();
    commandMocks.gridPlaces.length = 0;
    gridScroll.atEnd = false;
    sidebarMockState.thumbnails = [];
    commandMocks.getGridRows.mockResolvedValue({ path: "/vault", generation: 1, blocks: [] });
    vi.mocked(isTauri).mockReturnValue(false);
    commandMocks.getTabBootstrap.mockResolvedValue(null);
    setTabVisible(true);
    localStorage.clear();
    sidebarResizeState.width = 300;
    sidebarResizeState.collapsed = false;
    sidebarResizeState.isResizing = false;
    sidebarResizeState.widthAnimating = false;
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
    commandMocks.deleteBlock.mockResolvedValue({ removed: true, kept_media: [] });
    commandMocks.deleteBlocks.mockResolvedValue({ removed: 2, kept_media: [] });
    commandMocks.deleteChannel.mockResolvedValue({ deleted: true, kept_links: [] });
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
          description: null,
          color: null,
          icon: null,
          position: 0,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        },
        {
          tag: "beta",
          description: null,
          color: null,
          icon: null,
          position: 1,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        },
      ],
      total_blocks: 2,
      memberships: [],
    });
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
      memberships: [],
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
      memberships: [],
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

  // SPEC_CARD_ASSOCIATIONS.md, «Лента автора».
  it("opens an author's feed from the open card and leaves it through the sidebar", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
    await screen.findByRole("dialog", { name: "alpha-block.md" });

    fireEvent.click(screen.getByRole("button", { name: "Open author feed" }));

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("author @kotecinho:");
    });
    // The card closes on the way; the feed reads that author's cards.
    expect(screen.queryByRole("dialog", { name: "alpha-block.md" })).toBeNull();
    expect(commandMocks.gridPlaces).toContainEqual({ kind: "author", author: "@kotecinho" });
    // The path names the author, the sidebar marks no row, no graph.
    expect(screen.getByRole("button", { name: "Switch collection: @kotecinho" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Everything 2/ })).not.toHaveAttribute("aria-current", "page");
    expect(document.querySelector("[data-main-view-mode-switcher] [role='tablist']")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: /Everything 2/ }));
    await waitFor(() => {
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

  describe("the graph's Display panel (SPEC_GRAPH_VIEW.md, «Панель графа»)", () => {
    afterEach(() => {
      localStorage.clear();
      reloadGraphPreferences();
    });

    function graphPreferencesShown(): unknown {
      return JSON.parse(screen.getByTestId("graph-view").getAttribute("data-graph-preferences") ?? "null");
    }

    async function openDisplayPanel(): Promise<HTMLElement> {
      fireEvent.keyDown(screen.getByRole("button", { name: "Display options" }), { key: "ArrowDown" });
      return screen.findByRole("menu");
    }

    async function closeDisplayPanel(menu: HTMLElement) {
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    }

    function switchView(name: "Grid" | "Graph") {
      const switcher = document.querySelector("[data-main-view-mode-switcher]") as HTMLElement;
      fireEvent.mouseDown(within(switcher).getByRole("tab", { name }), { button: 0 });
    }

    it("opens the feed's panel in Grid and the graph's in Graph, and a switch reaches the graph at once", async () => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
      });

      let menu = await openDisplayPanel();
      expect(menu).toHaveAttribute("data-display-panel", "feed");
      expect(within(menu).getByRole("group", { name: "Sort" })).toBeInTheDocument();
      // The graph's switches are not here (the trial «Sidebar columns» is, PLAN 47.6).
      expect(within(menu).queryByRole("menuitemcheckbox", { name: "Wikilinks" })).not.toBeInTheDocument();
      await closeDisplayPanel(menu);

      switchView("Graph");
      expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
      expect(graphPreferencesShown()).toEqual({ include_wikilinks: true, include_related_notes: true });

      menu = await openDisplayPanel();
      expect(menu).toHaveAttribute("data-display-panel", "graph");
      expect(within(menu).getByRole("group", { name: "Links" })).toBeInTheDocument();
      expect(within(menu).queryByRole("group", { name: "Sort" })).not.toBeInTheDocument();
      expect(within(menu).queryByText("Collections")).not.toBeInTheDocument();

      fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Wikilinks" }));

      // The page's own announcement comes back to it and changes nothing.
      await waitFor(() => {
        expect(graphPreferencesShown()).toEqual({ include_wikilinks: false, include_related_notes: true });
      });
      expect(screen.getByRole("menu")).toBe(menu);
      expect(JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY) ?? "null")).toEqual({
        include_wikilinks: false,
        include_related_notes: true,
      });

      await closeDisplayPanel(menu);
      switchView("Grid");
      expect(await screen.findByTestId("grid")).toBeInTheDocument();
      menu = await openDisplayPanel();
      expect(menu).toHaveAttribute("data-display-panel", "feed");
    });

    it("hands the graph what another window switched, and never a stored wish to hide collections", async () => {
      localStorage.setItem(
        GRAPH_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ include_collections: false, include_wikilinks: true, include_related_notes: false }),
      );
      reloadGraphPreferences();
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
      });
      switchView("Graph");
      expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
      expect(graphPreferencesShown()).toEqual({ include_wikilinks: true, include_related_notes: false });

      // The Settings window switched both; its write may reach this page's
      // storage after the event, so the event carries the value.
      act(() => {
        window.dispatchEvent(new CustomEvent("settings-changed", {
          detail: {
            payload: {
              key: GRAPH_PREFERENCES_STORAGE_KEY,
              value: JSON.stringify({ include_wikilinks: false, include_related_notes: true }),
            },
          },
        }));
      });

      expect(graphPreferencesShown()).toEqual({ include_wikilinks: false, include_related_notes: true });
      const menu = await openDisplayPanel();
      expect(within(menu).getByRole("menuitemcheckbox", { name: "Wikilinks" }))
        .toHaveAttribute("aria-checked", "false");
      expect(within(menu).getByRole("menuitemcheckbox", { name: "Related notes" }))
        .toHaveAttribute("aria-checked", "true");
    });
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

  // SPEC_DEEP_AUDIT.md, Е6.14: the connections filter of an open element is
  // gone (07.10.2026); Tab there stays the system's focus traversal, and the
  // view does not flip underneath the element. Before, the key was swallowed.
  it("leaves Tab to the system while an element is open", async () => {
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

    const notPrevented = fireEvent.keyDown(window, { key: "Tab" });

    expect(notPrevented).toBe(true);
    // The view must not flip underneath the open element.
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

  // User's decision of 07.10.2026: the bar's first plate stands under the
  // sidebar row names, its right end on the chrome inset; the toggle does
  // not move when it hides the sidebar.
  it.each([false, true])("puts the bottom bar's left end under the sidebar names (collapsed: %s)", async (collapsed) => {
    sidebarResizeState.collapsed = collapsed;
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    const bar = document.querySelector("[data-bottom-action-bar]") as HTMLElement;
    expect(bar).toHaveClass("pl-[var(--sidebar-label-inset)]", "pr-[var(--chrome-edge-pad)]");
    expect(bar.className).not.toContain("px-[");
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

  describe("a sidebar thumbnail dragged to a collection (SPEC_FRONTEND.md, «Перетаскивание миниатюры»)", () => {
    /// The app's drag threshold, the feed card's.
    const DRAG_DISTANCE_PX = 8;
    /// dnd-kit drops a finished drag's document listeners, the click blocker
    /// among them, this long after the release.
    const DND_KIT_LISTENER_RELEASE_MS = 50;
    /// What the pointer's hit test finds (jsdom has no layout to ask).
    let elementsUnderPointer: Element[] = [];

    beforeEach(() => {
      // A card in alpha's strip that the feed does not hold.
      sidebarMockState.thumbnails = [{ tag: "alpha", slug: "gamma-card" }];
      elementsUnderPointer = [];
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => elementsUnderPointer,
      });
    });

    afterEach(async () => {
      fireEvent.pointerUp(document, { isPrimary: true });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, DND_KIT_LISTENER_RELEASE_MS + 1));
      });
      Reflect.deleteProperty(document, "elementsFromPoint");
    });

    async function renderWithThumbnail(path = "/", feed = "__all__:2") {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent(feed));
      return waitFor(() => {
        const thumbnail = document.querySelector('[data-sidebar-mock-thumbnail="gamma-card"]');
        expect(thumbnail).not.toBeNull();
        return thumbnail as HTMLElement;
      });
    }

    const sidebar = () => document.querySelector("[data-sidebar-mock]") as HTMLElement;

    function pickUp(thumbnail: HTMLElement) {
      fireEvent.pointerDown(thumbnail, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 10 + DRAG_DISTANCE_PX + 4, clientY: 10 });
    }

    function dropOn(tag: string) {
      elementsUnderPointer = [document.querySelector(`[data-sidebar-row-key="tag:${tag}"]`)!];
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 40, clientY: 12 });
      fireEvent.pointerUp(document, { isPrimary: true, clientX: 40, clientY: 12 });
    }

    it("travels as the feed's card and connects it to the collection it is dropped on", async () => {
      const read = deferred<IndexedBlock>();
      commandMocks.getBlock.mockImplementation(async (slug: string) => (
        slug === "gamma-card" ? read.promise : indexedBlock(1, slug, slug)
      ));
      const thumbnail = await renderWithThumbnail();

      pickUp(thumbnail);
      // The sidebar takes the drop from the first frame, before the card is read.
      expect(sidebar()).toHaveAttribute("data-sidebar-mock-drop-dragging", "true");
      expect(commandMocks.getBlock).toHaveBeenCalledWith("gamma-card");
      expect(document.querySelector("[data-card-preview]")).toBeNull();

      await act(async () => {
        read.resolve(indexedBlock(7, "gamma-card"));
        await read.promise;
      });
      await waitFor(() => expect(document.querySelector("[data-card-preview]")).not.toBeNull());

      dropOn("beta");
      await waitFor(() => expect(commandMocks.addTag).toHaveBeenCalledWith("gamma-card", "beta"));
      expect(sidebar()).toHaveAttribute("data-sidebar-mock-drop-dragging", "false");
    });

    it("changes nothing when dropped back on its own collection", async () => {
      const thumbnail = await renderWithThumbnail();

      pickUp(thumbnail);
      dropOn("alpha");

      expect(sidebar()).toHaveAttribute("data-sidebar-mock-drop-dragging", "false");
      await act(async () => {
        await Promise.resolve();
      });
      expect(commandMocks.addTag).not.toHaveBeenCalled();
    });

    it("keeps a card read that lands after its drag ended out of the next drag", async () => {
      sidebarMockState.thumbnails = [
        { tag: "alpha", slug: "gamma-card" },
        { tag: "beta", slug: "delta-card" },
      ];
      const read = deferred<IndexedBlock>();
      commandMocks.getBlock.mockImplementation(async (slug: string) => (
        slug === "gamma-card" ? read.promise : indexedBlock(8, slug, slug)
      ));
      const gamma = await renderWithThumbnail();

      pickUp(gamma);
      fireEvent.pointerUp(document, { isPrimary: true, clientX: 22, clientY: 10 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, DND_KIT_LISTENER_RELEASE_MS + 1));
      });
      pickUp(document.querySelector('[data-sidebar-mock-thumbnail="delta-card"]') as HTMLElement);
      await waitFor(() => {
        expect(document.querySelector("[data-card-preview]")).toHaveTextContent("delta-card");
      });

      await act(async () => {
        read.resolve(indexedBlock(7, "gamma-card"));
        await read.promise;
      });

      expect(document.querySelector("[data-card-preview]")).toHaveTextContent("delta-card");
      expect(document.querySelector("[data-card-preview]")).not.toHaveTextContent("gamma-card");
    });

    describe("on the open collection's feed or graph (SPEC_FRONTEND.md, «Бросок миниатюры в открытую коллекцию»)", () => {
      /// Where the right part of the window stands; jsdom lays nothing out.
      const MAIN_RECT = { x: 300, y: 64, left: 300, top: 64, right: 1200, bottom: 800, width: 900, height: 736 };
      /// A point over the feed, away from every sidebar row.
      const OVER_FEED = { clientX: 600, clientY: 400 };

      const dropTarget = () => document.querySelector<HTMLElement>("[data-open-collection-drop]");

      /// The open collection's drop target, placed where the right part is.
      function placeDropTarget(tag: string): HTMLElement {
        const target = dropTarget();
        expect(target).toHaveAttribute("data-open-collection-drop", tag);
        Object.defineProperty(target!, "getBoundingClientRect", {
          configurable: true,
          value: () => ({ ...MAIN_RECT, toJSON: () => MAIN_RECT }),
        });
        return target!;
      }

      function moveOverFeed() {
        elementsUnderPointer = [];
        fireEvent.pointerMove(document, { isPrimary: true, ...OVER_FEED });
      }

      function dropOnFeed() {
        moveOverFeed();
        fireEvent.pointerUp(document, { isPrimary: true, ...OVER_FEED });
      }

      it("connects the card to the open collection and frames the right part while over it", async () => {
        const thumbnail = await renderWithThumbnail("/channel/beta", "beta:1");
        const target = placeDropTarget("beta");
        expect(target).not.toHaveClass("ring-2");

        pickUp(thumbnail);
        moveOverFeed();
        await waitFor(() => expect(target).toHaveAttribute("data-open-collection-drop-over", "true"));
        expect(target).toHaveClass("ring-2", "ring-ring", "ring-inset", "pointer-events-none");

        fireEvent.pointerUp(document, { isPrimary: true, ...OVER_FEED });
        await waitFor(() => expect(commandMocks.addTag).toHaveBeenCalledWith("gamma-card", "beta"));
        expect(commandMocks.addTag).toHaveBeenCalledTimes(1);
        expect(target).not.toHaveAttribute("data-open-collection-drop-over");
        expect(target).not.toHaveClass("ring-2");
      });

      it("changes nothing for a card already in the open collection", async () => {
        commandMocks.getBlock.mockImplementation(async (slug: string) => ({
          ...indexedBlock(7, slug),
          tags: ["beta"],
        }));
        const thumbnail = await renderWithThumbnail("/channel/beta", "beta:1");
        placeDropTarget("beta");

        pickUp(thumbnail);
        dropOnFeed();

        // The drop reads the card's collections from the index, then stops.
        await waitFor(() => expect(commandMocks.getBlock).toHaveBeenCalledTimes(2));
        await act(async () => {
          await Promise.resolve();
        });
        expect(commandMocks.addTag).not.toHaveBeenCalled();
      });

      it("changes nothing for a thumbnail from the open collection's own row", async () => {
        sidebarMockState.thumbnails = [{ tag: "beta", slug: "gamma-card" }];
        const thumbnail = await renderWithThumbnail("/channel/beta", "beta:1");
        placeDropTarget("beta");

        pickUp(thumbnail);
        const readsAtPickUp = commandMocks.getBlock.mock.calls.length;
        dropOnFeed();

        await act(async () => {
          await Promise.resolve();
        });
        expect(commandMocks.getBlock).toHaveBeenCalledTimes(readsAtPickUp);
        expect(commandMocks.addTag).not.toHaveBeenCalled();
      });

      it("takes no other drag", async () => {
        // A feed card's drag: its id is its slug, not a thumbnail's.
        sidebarMockState.thumbnails = [{ tag: "alpha", slug: "gamma-card", dragId: "gamma-card" }];
        const card = await renderWithThumbnail("/channel/beta", "beta:1");
        const target = placeDropTarget("beta");

        pickUp(card);
        dropOnFeed();

        await act(async () => {
          await Promise.resolve();
        });
        expect(target).not.toHaveAttribute("data-open-collection-drop-over");
        expect(commandMocks.addTag).not.toHaveBeenCalled();
      });

      it("is no target on Everything, in an author's feed or under an open card", async () => {
        const { unmount } = render(
          <MemoryRouter initialEntries={["/"]}>
            <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
          </MemoryRouter>,
        );
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        expect(dropTarget()).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
        await screen.findByRole("dialog", { name: "alpha-block.md" });
        fireEvent.click(screen.getByRole("button", { name: "Open author feed" }));
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("author @kotecinho:"));
        expect(dropTarget()).toBeNull();
        unmount();

        render(
          <MemoryRouter initialEntries={["/channel/beta"]}>
            <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
          </MemoryRouter>,
        );
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("beta:1"));
        expect(dropTarget()).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Open beta-block" }));
        await screen.findByRole("dialog", { name: "beta-block.md" });
        expect(dropTarget()).toBeNull();
      });
    });
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

    // The path's lines (11.10.2026): one line between space and collection
    // and one between collection and an open card's name, the sidebar open or
    // collapsed. The space switcher's own padding is VaultSwitcher.test.tsx's
    // to check.
    for (const collapsed of [false, true]) {
      const mode = collapsed ? "collapsed" : "open";
      const renderPath = async () => {
        sidebarResizeState.width = collapsed ? 0 : 300;
        sidebarResizeState.collapsed = collapsed;
        render(
          <MemoryRouter initialEntries={["/"]}>
            <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
          </MemoryRouter>,
        );
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      };
      const contentSegment = () =>
        document.querySelector("[data-main-secondary-top-bar-content-segment]") as HTMLElement;
      const pathLines = () =>
        (document.querySelector("header.chrome-row") as HTMLElement).querySelectorAll(".border-sidebar-border");

      it(`parts space and collection by the segment's line with the sidebar ${mode}`, async () => {
        await renderPath();

        const segment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement;
        expect(segment).toHaveClass("border-r", "border-sidebar-border");
        // The segment's line is the only one: nothing after it draws another.
        const pathRest = segment.nextElementSibling as HTMLElement;
        const collection = screen.getByRole("button", { name: "Switch collection: Everything" });
        expect(pathRest.firstElementChild).toBe(collection.closest("[data-top-collection-switcher-slot]"));
        expect(pathRest).not.toHaveClass("border-l");
        expect(collection).not.toHaveClass("border-l");
        // 8 px from the line, the path going on after it.
        expect(collection).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-0");
        // No card open: no line after the collection.
        expect(contentSegment().previousElementSibling).toBe(collection.closest("[data-top-collection-switcher-slot]"));
        expect(contentSegment()).not.toHaveAttribute("data-path-card-line");
        expect(contentSegment()).not.toHaveClass("border-l");
        expect(pathLines()).toHaveLength(1);
      });

      it(`parts collection and the open card's name by the same line with the sidebar collapsed, the name alone with it open (${mode})`, async () => {
        await renderPath();

        const collection = screen.getByRole("button", { name: "Switch collection: Everything" });
        const collectionClass = collection.className;

        fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
        await waitFor(() => {
          expect(document.querySelector("[data-secondary-detail-top-menu]")).toHaveAttribute("data-entered", "true");
        });
        if (!collapsed) {
          // The open sidebar shows the place: the card's name stands alone
          // after the segment's line (user's decision of 23.10.2026), and the
          // place comes back once the name has left the row.
          // The switcher has faded out where it stands, out of the row's flow, inert.
          expect(screen.queryByRole("button", { name: "Switch collection: Everything" })).toBeNull();
          const slot = document.querySelector("[data-top-collection-switcher-slot]") as HTMLElement;
          expect(slot).toHaveAttribute("inert");
          expect(slot).toHaveClass("absolute");
          expect(contentSegment()).not.toHaveAttribute("data-path-card-line");
          expect(contentSegment()).not.toHaveClass("border-l");
          expect(contentSegment()).toHaveTextContent("alpha-block");
          expect(pathLines()).toHaveLength(1);
          fireEvent.click(screen.getByRole("button", { name: "Close" }));
          await waitFor(() => {
            expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeNull();
          });
          expect(screen.getByRole("button", { name: "Switch collection: Everything" }).className).toBe(collectionClass);
          expect(pathLines()).toHaveLength(1);
          return;
        }
        // The column's line, 8 px past the collection's pill.
        expect(contentSegment()).toHaveAttribute("data-path-card-line", "");
        expect(contentSegment()).toHaveClass(
          "ml-[var(--top-collection-pad-x)]",
          "border-l",
          "border-sidebar-border",
        );
        const name = document.querySelector("[data-secondary-detail-card-name]") as HTMLElement;
        expect(name).toHaveTextContent("alpha-block");
        expect(contentSegment().contains(name)).toBe(true);
        // The name's pill keeps 8 px from the line, as a switcher does; the
        // moving layer draws no line of its own.
        const detailLayer = document.querySelector("[data-secondary-detail-top-menu]") as HTMLElement;
        expect(detailLayer).toHaveClass("pl-[var(--top-collection-pad-x)]");
        expect(detailLayer).not.toHaveClass("border-l");
        // Space and collection keep their places: the segment's line is still
        // the one between them, the switcher keeps its box.
        const segment = document.querySelector("[data-app-top-sidebar-segment]") as HTMLElement;
        expect(segment).toHaveClass("border-r", "border-sidebar-border");
        expect(collection.className).toBe(collectionClass);
        expect(pathLines()).toHaveLength(2);

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        // The line leaves with the name, once its exit is over.
        await waitFor(() => {
          expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeNull();
        });
        expect(contentSegment()).not.toHaveAttribute("data-path-card-line");
        expect(contentSegment()).not.toHaveClass("border-l");
        expect(contentSegment()).not.toHaveClass("ml-[var(--top-collection-pad-x)]");
        expect(collection.className).toBe(collectionClass);
        expect(pathLines()).toHaveLength(1);
      });
    }
  });

  it("animates the sidebar's segment and the second row only while the sidebar collapses or opens (SPEC_NARROW_WINDOW.md, У1, У10)", async () => {
    sidebarResizeState.widthAnimating = true;

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });
    const shell = document.querySelector("[data-chrome-shell]");
    expect(shell).toHaveAttribute("data-sidebar-width-animating", "");
    // One row until the row is measured to cut something.
    expect(shell).toHaveAttribute("data-top-row", "one");
    expect(document.querySelector("[data-app-top-sidebar-segment]")).toHaveClass("transition-[width]", "duration-200", "ease-out");
    expect(document.querySelector("main")).toHaveAttribute("data-below-top-row", "");
    expect(shell?.querySelector("header [data-top-row-bar]")).not.toBeNull();
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
    // The space switcher keeps the cap; the segment adds only its line.
    expect(topSidebarSegment).toHaveClass("w-auto", "border-r", "border-sidebar-border");
    expect(topSidebarSegment).not.toHaveClass("max-w-[240px]");
    expect(topSidebarSegment).not.toHaveStyle({ width: "var(--sidebar-width)" });
    // Its width animates only while the sidebar collapses or opens: a
    // window's resize squeezes it at once (SPEC_NARROW_WINDOW.md, У1).
    expect(topSidebarSegment).not.toHaveClass("transition-[width]");
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
    // Collapsed, the segment's line still parts space and collection: the
    // collection keeps its inset from it, none before the content that
    // follows (11.10.2026).
    expect(collectionSwitcher).toHaveClass("pl-[var(--top-collection-pad-x)]", "pr-0");
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
        explanation: null,
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

  it("creates a collection from the filter on Enter and opens one already called that", async () => {
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
    // The backend writes the new page first in the manual order; no reorder
    // rewrites the pages of the rest (SPEC_DEEP_AUDIT.md, Е6.2).
    expect(commandMocks.checkCollectionName).toHaveBeenCalledWith(null, "Gamma");
    expect(input).toHaveValue("");
    expect(commandMocks.reorderChannels).not.toHaveBeenCalled();

    // A name already taken, in any case, opens that collection instead.
    fireEvent.change(input, { target: { value: "ALPHA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commandMocks.createChannel).toHaveBeenCalledTimes(1);
  });

  describe("a membership change whose menu has closed (SPEC_DEEP_AUDIT.md, Н11)", () => {
    async function renderFeed() {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    }

    it("sends the selection's Disconnect as one command and says when it changed nothing (Е6.1)", async () => {
      commandMocks.setBlocksMembership.mockRejectedValueOnce(
        new Error("“beta-block.md” changed outside Mine; nothing was changed. Try again."),
      );
      await renderFeed();

      fireEvent.click(screen.getByRole("button", { name: "Disconnect the selection from alpha" }));

      expect(await screen.findByText("Could not disconnect 2 elements")).toBeInTheDocument();
      expect(screen.getByText("Nothing changed.")).toBeInTheDocument();
      expect(screen.getByText("“beta-block.md” changed outside Mine; nothing was changed. Try again."))
        .toBeInTheDocument();
      // One command for the whole selection: no card is changed before
      // another fails.
      expect(commandMocks.setBlocksMembership).toHaveBeenCalledTimes(1);
      expect(commandMocks.setBlocksMembership).toHaveBeenCalledWith(["alpha-block", "beta-block"], "alpha", false);
      expect(commandMocks.removeTag).not.toHaveBeenCalled();
    });

    it("hides the last notice of its kind when the next change succeeds or fails (Е6.1)", async () => {
      commandMocks.setBlocksMembership.mockRejectedValueOnce(new Error("first refusal"));
      await renderFeed();
      fireEvent.click(screen.getByRole("button", { name: "Disconnect the selection from alpha" }));
      expect(await screen.findByText("first refusal")).toBeInTheDocument();

      commandMocks.setBlocksMembership.mockRejectedValueOnce(new Error("second refusal"));
      fireEvent.click(screen.getByRole("button", { name: "Connect the selection to beta" }));
      expect(await screen.findByText("Could not connect 2 elements")).toBeInTheDocument();
      expect(screen.queryByText("first refusal")).toBeNull();
      expect(screen.getByText("second refusal")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Connect the selection to beta" }));
      await waitFor(() => expect(screen.queryByText("second refusal")).toBeNull());
    });

    it("says when one card's Connect failed (Е6.3)", async () => {
      commandMocks.addTag.mockRejectedValueOnce(new Error("Collection “beta” has no page; nothing was written."));
      await renderFeed();

      fireEvent.click(screen.getByRole("button", { name: "Connect alpha-block to beta" }));

      expect(await screen.findByText("Could not connect the element")).toBeInTheDocument();
      expect(screen.getByText("Collection “beta” has no page; nothing was written.")).toBeInTheDocument();
    });
  });

  // SPEC_DEEP_AUDIT.md, Е6.15: the opening screen speaks of a space.
  it("says the space is opening in the words of the dictionary", async () => {
    commandMocks.openVault.mockImplementation(() => new Promise<VaultOpenResult>(() => {}));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Opening space…")).toBeInTheDocument();
    expect(screen.queryByText(/vault/i)).toBeNull();
  });

  /// SPEC_DEEP_AUDIT.md, Е6.17: the notes a pass could not read are named by
  /// the space's notice; a pass that reads them takes it away. Before, they
  /// were in the journal only.
  it("names the notes a pass of the space could not read", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    const pass = (errorFiles: Array<{ path: string; kind: string; message: string }>) => {
      act(() => {
        window.dispatchEvent(new CustomEvent("vault-freshness-changed", {
          detail: {
            payload: {
              vault_path: "/vault",
              generation: 2,
              state: errorFiles.length > 0 ? "degraded" : "fresh",
              joined_callers: 0,
              inventory_markdown: 3,
              content_reads: 1,
              database_writes: 0,
              error_count: errorFiles.length,
              error_files: errorFiles,
              elapsed_ms: 5,
              fast_path_hits: 0,
            },
          },
        }));
      });
    };

    pass([{ path: "Cards/Broken.md", kind: "parse", message: "the properties are not valid YAML" }]);

    expect(await screen.findByText("Could not read 1 note")).toBeInTheDocument();
    expect(screen.getByText("Mine shows the space without them.")).toBeInTheDocument();
    expect(screen.getByText("“Broken.md”: the properties are not valid YAML")).toBeInTheDocument();

    pass([]);
    await waitFor(() => expect(screen.queryByText("Could not read 1 note")).toBeNull());
  });

  describe("⌘V into the feed (SPEC_DEEP_AUDIT.md, Е6.4)", () => {
    async function renderFeed() {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    }

    it("says when the pasted element could not be created", async () => {
      commandMocks.readClipboardPayload.mockResolvedValueOnce({ kind: "text", text: "A note" } as never);
      commandMocks.createBlock.mockRejectedValueOnce(new Error("The disk is full."));
      await renderFeed();

      fireEvent.keyDown(window, { key: "v", code: "KeyV", metaKey: true });

      expect(await screen.findByText("Could not create an element")).toBeInTheDocument();
      expect(screen.getByText("The disk is full.")).toBeInTheDocument();
    });

    it("pastes again when ⌘V comes while the last paste is still being created", async () => {
      let finishFirst!: () => void;
      commandMocks.readClipboardPayload.mockResolvedValue({ kind: "text", text: "A note" } as never);
      commandMocks.createBlock
        .mockImplementationOnce(() => new Promise<IndexedBlock>((resolve) => {
          finishFirst = () => resolve({} as IndexedBlock);
        }))
        .mockResolvedValueOnce({} as IndexedBlock);
      await renderFeed();

      fireEvent.keyDown(window, { key: "v", code: "KeyV", metaKey: true });
      await waitFor(() => expect(commandMocks.createBlock).toHaveBeenCalledTimes(1));
      fireEvent.keyDown(window, { key: "v", code: "KeyV", metaKey: true });
      await act(async () => finishFirst());

      await waitFor(() => expect(commandMocks.createBlock).toHaveBeenCalledTimes(2));
      commandMocks.readClipboardPayload.mockResolvedValue({ kind: "empty" } as never);
    });
  });

  describe("one way to create a collection (SPEC_DEEP_AUDIT.md, Е6.2)", () => {
    async function renderFeed() {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
    }

    it("creates from the sidebar without rewriting the other collection pages or leaving the place", async () => {
      await renderFeed();

      fireEvent.click(screen.getByRole("button", { name: "Create collection gamma" }));

      await waitFor(() => expect(commandMocks.createChannel).toHaveBeenCalledWith("gamma"));
      // The new page takes the first place itself: no reorder writes the
      // pages of the rest.
      await waitFor(() => expect(commandMocks.listTaxonomySnapshot.mock.calls.length).toBeGreaterThan(1));
      expect(commandMocks.reorderChannels).not.toHaveBeenCalled();
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    it("creates from the collection switcher the same way: no reorder, the place stays", async () => {
      // The collection lists read after the creation hold its page.
      const taxonomy = await commandMocks.listTaxonomySnapshot();
      commandMocks.listTaxonomySnapshot.mockResolvedValue({
        ...taxonomy,
        tags: [{ tag: "gamma", count: 0 }, ...taxonomy.tags],
        channels: [{ ...taxonomy.channels[0]!, tag: "gamma", position: -1, block_count: 0 }, ...taxonomy.channels],
      });
      await renderFeed();

      fireEvent.click(screen.getByRole("button", { name: "Switch collection: Everything" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Create collection" }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Collection name" }), {
        target: { value: "gamma" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(commandMocks.createChannel).toHaveBeenCalledWith("gamma"));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New collection" })).toBeNull());
      // The lists read again, the feed stays where it was.
      await waitFor(() => expect(commandMocks.listTaxonomySnapshot.mock.calls.length).toBeGreaterThan(2));
      await act(async () => {
        await Promise.resolve();
      });
      expect(commandMocks.reorderChannels).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Switch collection: Everything" })).toBeInTheDocument();
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    it("refuses a taken name in the collection switcher by the one check, in the words of the dictionary", async () => {
      commandMocks.checkCollectionName.mockImplementation(async (_oldTag, name) => (
        name.toLowerCase() === "alpha" ? "A collection named \"alpha\" already exists." : null
      ));
      await renderFeed();

      fireEvent.click(screen.getByRole("button", { name: "Switch collection: Everything" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Create collection" }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Collection name" }), {
        target: { value: "Alpha" },
      });

      const dialog = await screen.findByRole("dialog", { name: "New collection" });
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("A collection named \"alpha\" already exists."));
      expect(dialog.textContent ?? "").not.toMatch(/channel/i);
      expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
      expect(commandMocks.createChannel).not.toHaveBeenCalled();
      commandMocks.checkCollectionName.mockImplementation(async () => null);
    });
  });

  describe("a collection exists only as its page (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md)", () => {
    /// The taxonomy of a space where cards also link `pageless`, a name with
    /// no collection page.
    function withPagelessLink() {
      commandMocks.listTaxonomySnapshot.mockResolvedValue({
        generation: 1,
        tags: [
          { tag: "pageless", count: 3 },
          { tag: "alpha", count: 1 },
          { tag: "beta", count: 1 },
        ],
        channels: ["alpha", "beta"].map((tag, position) => ({
          tag,
          title: tag,
          description: null,
          color: null,
          icon: null,
          position,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        })),
        total_blocks: 2,
        memberships: [],
      });
    }

    it("lists only the collection pages in the sidebar and the top switcher (К1, К9)", async () => {
      withPagelessLink();
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      const sidebar = document.querySelector("[data-sidebar-mock]") as HTMLElement;
      expect(within(sidebar).getAllByRole("link").map((link) => link.textContent)).toEqual([
        "Everything 2",
        "alpha",
        "beta",
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Switch collection: Everything" }));
      await screen.findByRole("textbox", { name: "Search collections" });
      expect(screen.getByRole("menuitem", { name: "alpha" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "beta" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "pageless" })).not.toBeInTheDocument();
    });

    it("makes the place of a name without a page Everything (К1, В18)", async () => {
      withPagelessLink();
      render(
        <MemoryRouter initialEntries={["/channel/pageless"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      expect(screen.getByRole("button", { name: "Switch collection: Everything" })).toBeInTheDocument();
    });

    it("creates the page before a card's Create collection connects the card (К5)", async () => {
      // The page takes the first free name; the card joins that collection.
      commandMocks.createChannel.mockImplementationOnce(async (tag: string) => ({
        tag: `${tag} (2)`,
        description: null,
        color: null,
        icon: null,
        position: 2,
        created_at: "2026-04-17T00:00:00Z",
        block_count: 0,
      }));
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      fireEvent.click(screen.getByRole("button", { name: "Create gamma for alpha-block" }));

      await waitFor(() => expect(commandMocks.addTag).toHaveBeenCalledWith("alpha-block", "gamma (2)"));
      expect(commandMocks.createChannel).toHaveBeenCalledWith("gamma");
      expect(commandMocks.createChannel.mock.invocationCallOrder[0]).toBeLessThan(
        commandMocks.addTag.mock.invocationCallOrder[0]!,
      );
      expect(commandMocks.addTag).toHaveBeenCalledTimes(1);
    });

    it("creates the page before the group selection's Create collection connects the cards (К5)", async () => {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));

      fireEvent.click(screen.getByRole("button", { name: "Create gamma for the selection" }));

      // The selection joins in one command (SPEC_DEEP_AUDIT.md, Е6.1).
      await waitFor(() => expect(commandMocks.setBlocksMembership).toHaveBeenCalledTimes(1));
      expect(commandMocks.createChannel).toHaveBeenCalledWith("gamma");
      expect(commandMocks.setBlocksMembership).toHaveBeenCalledWith(["alpha-block", "beta-block"], "gamma", true);
      expect(commandMocks.createChannel.mock.invocationCallOrder[0]).toBeLessThan(
        commandMocks.setBlocksMembership.mock.invocationCallOrder[0]!,
      );
      expect(commandMocks.addTag).not.toHaveBeenCalled();
    });

    it("connects nothing when the page cannot be made (К5)", async () => {
      commandMocks.createChannel.mockRejectedValueOnce(new Error("A collection named \"gamma\" already exists."));
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      const taxonomyReads = commandMocks.listTaxonomySnapshot.mock.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "Create gamma for alpha-block" }));

      await waitFor(() => {
        expect(commandMocks.listTaxonomySnapshot.mock.calls.length).toBeGreaterThan(taxonomyReads);
      });
      expect(commandMocks.addTag).not.toHaveBeenCalled();
      // The picker's row was cleared by the press: the refusal is a notice
      // of this tab (SPEC_DEEP_AUDIT.md, Е6.2, Н11).
      expect(await screen.findByText("Could not create the collection")).toBeInTheDocument();
      expect(screen.getByText("A collection named \"gamma\" already exists.")).toBeInTheDocument();
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
          description: null,
          color: null,
          icon: null,
          position: 0,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 1,
        },
        {
          tag: "beta",
          description: null,
          color: null,
          icon: null,
          position: 1,
          created_at: "2026-04-17T00:00:00Z",
          block_count: 9,
        },
      ],
      total_blocks: 2,
      memberships: [],
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "alpha" })).toBeInTheDocument();
    });

    // "loose" has no collection page: cards name it, but it is no
    // collection and no row (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1).
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Everything 2",
      "alpha",
      "beta",
    ]);
  });

  it("opens a space with no finished index without covering the window, and reads it again once built (Х28)", async () => {
    commandMocks.openVault.mockResolvedValue(
      vaultOpenResult({
        derived_store_ready: false,
      }),
    );

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("grid")).toBeInTheDocument());
    // The opening notice is the only sign; no screen covers the feed (П31).
    expect(screen.queryByText("Preparing library…")).toBeNull();
    const readsBefore = commandMocks.listGridBlocks.mock.calls.length;

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

    // The first pass landed: every route reads the snapshot it built.
    await waitFor(() => {
      expect(commandMocks.listGridBlocks.mock.calls.length).toBeGreaterThan(readsBefore);
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
      expect(commandMocks.deleteBlock).toHaveBeenCalledWith("alpha-block", false, []);
    });
    // Optimistic notice for overlay-owned result sets fires on confirm.
    expect(deletedSlugs).toEqual(["alpha-block"]);
    window.removeEventListener("block-deleted", onBlockDeleted);
    // The deleted card was the open one: it closes.
    expect(document.querySelector("[data-detail-root]")).toBeNull();
  });

  it("keeps the open card open when a row over it deletes another card", async () => {
    commandMocks.prepareDeleteBlock.mockResolvedValue({
      slug: "beta-block",
      markdown_file: "beta-block.md",
      unused_media: [],
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
    fireEvent.click(await screen.findByRole("button", { name: "Delete related note" }));
    expect(await screen.findByText("Delete element?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(commandMocks.deleteBlock).toHaveBeenCalledWith("beta-block", false, []);
    });
    expect(document.querySelector("[data-detail-root]")).not.toBeNull();
    expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block");
  });

  // User's decision of 11.10.2026: the window waits for its plan and opens at
  // its final width, never as a narrow "checking" window that widens.
  it("opens the delete window once its plan is here, at its final width", async () => {
    let resolvePlan: (plan: DeleteBlockPlan) => void = () => {};
    commandMocks.prepareDeleteBlock.mockImplementation(
      () => new Promise<DeleteBlockPlan>((resolve) => {
        resolvePlan = resolve;
      }),
    );

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
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await act(async () => {
      resolvePlan({
        slug: "alpha-block",
        markdown_file: "alpha-block.md",
        unused_media: [{ path: "photo.png", file_name: "photo.png", kind: "image", referenced_by: [] }],
        shared_media: [],
      });
    });

    expect(await screen.findByRole("alertdialog")).toHaveAttribute("data-modal-width", "content");
  });

  // Decision of 11.10.2026: Delete checks the files against the notes on
  // disk; a file the window offered that another note uses stays, and a
  // notice says so. A file the window already said would stay is no news.
  it("tells which offered file Delete kept because another note uses it", async () => {
    const photo = { path: "Media/photo.png", file_name: "photo.png", kind: "image" as const, referenced_by: [] };
    const lone = { path: "Media/lone.png", file_name: "lone.png", kind: "image" as const, referenced_by: [] };
    const shared = { path: "Media/shared.png", file_name: "shared.png", kind: "image" as const, referenced_by: ["beta-block"] };
    commandMocks.prepareDeleteBlock.mockResolvedValue({
      slug: "alpha-block",
      markdown_file: "alpha-block.md",
      unused_media: [photo, lone],
      shared_media: [shared],
    });
    commandMocks.deleteBlock.mockResolvedValue({
      removed: true,
      kept_media: [shared, { ...photo, referenced_by: ["Cards/Late"] }],
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
    expect(await screen.findByText("Delete element?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      // SPEC_DEEP_AUDIT.md, Е1.12: the files the window offered go with the
      // deletion, which takes no other.
      expect(commandMocks.deleteBlock).toHaveBeenCalledWith(
        "alpha-block",
        true,
        ["Media/photo.png", "Media/lone.png"],
      );
    });
    expect(await screen.findByText("Media kept")).toBeInTheDocument();
    expect(document.querySelector("[data-delete-kept-media]")).toHaveTextContent(
      "photo.png is used by another element and stayed in the space.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Media kept")).toBeNull();
  });

  // DESIGN_SYSTEM.md, «Сбой после закрытия окна» (11.10.2026): the window
  // closed on the press, so a failed delete is a notice of this tab, never
  // only the console; the next delete hides it.
  it("tells in a notice that the element was not deleted", async () => {
    commandMocks.deleteBlock.mockRejectedValueOnce(new Error("Permission denied (os error 13)"));

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
    expect(await screen.findByText("Delete element?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Could not delete the element")).toBeInTheDocument();
    expect(document.querySelector('[data-delete-failed-notice="element"]')).toHaveTextContent(
      "Permission denied (os error 13)",
    );

    // The next delete hides the last one's notice.
    fireEvent.click(screen.getByRole("button", { name: "Open beta-block" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete detail" }));
    await waitFor(() => {
      expect(screen.queryByText("Could not delete the element")).toBeNull();
    });
  });

  // Decision of 14.10.2026: notices stand 16 px above the bottom bar's top
  // edge, read from where the bar stands in the window, not over the bar.
  it("puts the notice corner 16 px above the bottom bar", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = this.hasAttribute("data-bottom-action-bar") ? 727 : 0;
      return { top, bottom: top + 40, left: 0, right: 1024, width: 1024, height: 40, x: 0, y: top, toJSON: () => ({}) };
    });
    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      expect(document.querySelector("[data-bottom-action-bar]")).not.toBeNull();
      expect(document.documentElement.style.getPropertyValue("--notification-bottom"))
        .toBe(`${window.innerHeight - 727 + 16}px`);
    } finally {
      rect.mockRestore();
    }
  });

  // Live case of 14.10.2026: the first refusal of a delete showed nothing and
  // only a second press told it. A refusal that comes later, as the real one
  // does after the Trash answered, shows at the first press, and the card
  // stays in the feed.
  it("tells the first refusal of a delete that answers late", async () => {
    const REFUSED_TRASH = "Could not move “alpha-block.md” to the Trash. Nothing was deleted.\n"
      + "Allow Mine to access iCloud Drive in System Settings, Privacy & Security, Files and Folders.";
    commandMocks.deleteBlock.mockImplementationOnce(
      () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error(REFUSED_TRASH)), 50);
      }),
    );

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
    expect(await screen.findByText("Delete element?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Could not delete the element")).toBeInTheDocument();
    const notice = document.querySelector('[data-delete-failed-notice="element"]');
    // Two lines: the refusal with the file's name, then where to allow access.
    expect(notice?.textContent).toBe(REFUSED_TRASH);
    expect(notice?.parentElement).toHaveClass("whitespace-pre-line");
    expect(commandMocks.deleteBlock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
  });

  // SPEC_DEEP_AUDIT.md, Е1.3 (Н2): the collection goes in one backend
  // command, so a failure changed nothing and says so.
  it("tells that the collection was not deleted and that nothing changed", async () => {
    commandMocks.deleteChannel.mockRejectedValueOnce(new Error("The page is locked"));

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete collection alpha" }));

    expect(await screen.findByText("Could not delete the collection")).toBeInTheDocument();
    expect(commandMocks.deleteChannel).toHaveBeenCalledTimes(1);
    expect(commandMocks.deleteChannel).toHaveBeenCalledWith("alpha");
    expect(document.querySelector('[data-delete-failed-summary="collection"]')).toHaveTextContent(
      "Nothing changed.",
    );
    expect(document.querySelector('[data-delete-failed-notice="collection"]')).toHaveTextContent(
      "The page is locked",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Could not delete the collection")).toBeNull();
  });

  // Е1.3: a card the deletion could not change keeps its link, and the tab
  // says which.
  it("names the elements that still link a deleted collection", async () => {
    commandMocks.deleteChannel.mockResolvedValueOnce({
      deleted: true,
      kept_links: ["Cards/Locked"],
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete collection beta" }));

    expect(await screen.findByText("Links kept")).toBeInTheDocument();
    expect(commandMocks.deleteChannel).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-delete-kept-links]")).toHaveTextContent(
      "“Locked” could not be changed and still links to “beta”.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Links kept")).toBeNull();
  });

  // SPEC_GROUP_SELECTION.md, «Окно»: a non-empty `kept_media` of the group
  // delete shows `Media kept` in this tab, as after one element.
  it("tells which offered file the group delete kept", async () => {
    commandMocks.deleteBlocks.mockResolvedValueOnce({
      removed: 2,
      kept_media: [
        { path: "Media/photo.png", file_name: "photo.png", kind: "image", referenced_by: ["Cards/Late"] },
      ],
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2");
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete the selection with its media" }));

    await waitFor(() => {
      expect(commandMocks.deleteBlocks).toHaveBeenCalledWith(
        ["alpha-block", "beta-block"],
        true,
        ["Media/photo.png"],
      );
    });
    expect(await screen.findByText("Media kept")).toBeInTheDocument();
    expect(document.querySelector("[data-delete-kept-media]")).toHaveTextContent(
      "photo.png is used by another element and stayed in the space.",
    );
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

  /// SPEC_DEEP_AUDIT.md, Е6.7: Sort and Show are the whole app's (SPEC_TABS.md,
  /// В78), so the order another tab chose reaches this one; before, each
  /// tab kept the one it read at its start.
  it("takes Sort and Show chosen in another tab (Д18)", async () => {
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

      // The other tab's write may reach this page's storage after the event:
      // the event carries the value.
      act(() => {
        window.dispatchEvent(new CustomEvent("settings-changed", {
          detail: { payload: { key: "mine.feed.sort", value: "oldest" } },
        }));
      });

      await waitFor(() => {
        expect(commandMocks.listGridBlocks).toHaveBeenLastCalledWith(undefined, 0, 200, "oldest");
      });
      expect(getFeedDisplay().sort).toBe("oldest");

      act(() => {
        window.dispatchEvent(new CustomEvent("settings-changed", {
          detail: { payload: { key: "mine.feed.show", value: "media" } },
        }));
      });
      expect(getFeedDisplay().show).toBe("media");
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
      taxonomy.resolve({ generation: 2, tags: [], channels: [], total_blocks: 600, memberships: [] });
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
      expect(screen.getByText("This element is a file")).toBeInTheDocument();
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
      expect(screen.queryByText("This element is a file")).not.toBeInTheDocument();
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
    // Only for what must not happen: a whole interval passes with nothing
    // reported. What must happen is waited for as a condition.
    const waitReportInterval = () => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TAB_VIEW_REPORT_DEBOUNCE_MS + 60));
    });
    // The tab reads its place two frames after the effects of a render
    // (В81). Frame callbacks run in the order they were asked for, so once two
    // frames asked for now have run, a read asked for by effects that already
    // ran has run too. A move made inside `act` runs all its renders and
    // effects before `act` returns.
    const afterPlaceRead = () => act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
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

      await waitFor(() => expect(commandMocks.reportTabView).toHaveBeenCalledTimes(1), {
        timeout: TAB_VIEW_REPORT_DEBOUNCE_MS * 4,
      });
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
        memberships: [],
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
      await act(async () => {
        send("tab-go-everything");
      });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      expect(screen.queryByTestId("detail-title")).toBeNull();
      // Everything is in the history now; its directions are the same as
      // before, so nothing new is reported.
      await afterPlaceRead();
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

    it("settles a step once its route lands, not over the old route with the step's card (В81)", async () => {
      commandMocks.getBlock.mockImplementation(async (slug: string) => indexedBlock(1, slug, slug));
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(false, false));
      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, false));
      await act(async () => {
        send("tab-go-everything");
      });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
      await afterPlaceRead();

      // Frames come before the step's route is drawn: the card the step opens
      // commits at once, and the route it asked for lands in a transition
      // that a busy page draws frames later. Here every frame comes as soon
      // as it is asked for.
      let nextFrame = 0;
      const cancelledFrames = new Set<number>();
      const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        nextFrame += 1;
        const id = nextFrame;
        queueMicrotask(() => {
          if (!cancelledFrames.has(id)) callback(performance.now());
        });
        return id;
      });
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        cancelledFrames.add(id);
      });
      try {
        send("tab-history-go", { forward: false });
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
        await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));
      } finally {
        requestFrame.mockRestore();
        cancelFrame.mockRestore();
      }
      await afterPlaceRead();
      expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, true);

      // One step back is the collection alone, not Everything with the card.
      send("tab-history-go", { forward: false });
      await waitFor(() => expect(screen.queryByTestId("detail-title")).toBeNull());
      expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1");
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(false, true));
    });

    it("steps back from an author's feed to the card it opened from (SPEC_CARD_ASSOCIATIONS.md)", async () => {
      commandMocks.getBlock.mockImplementation(async (slug: string) => indexedBlock(1, slug, slug));
      renderTab({}, "/channel/alpha");
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(false, false));
      fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, false));
      // The card's page is a lazily loaded module: the place is recorded
      // before it shows, and its first load can outlast the default wait on
      // a busy run.
      await waitFor(
        () => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"),
        { timeout: 5000 },
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open author feed" }));
      });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("author @kotecinho:"));
      expect(screen.queryByTestId("detail-title")).toBeNull();
      // The tab remembers the author's feed as its place.
      await waitFor(() => {
        expect(commandMocks.reportTabView).toHaveBeenLastCalledWith(expect.objectContaining({
          location: { kind: "author", author: "@kotecinho" },
          open_card: null,
        }));
      }, { timeout: TAB_VIEW_REPORT_DEBOUNCE_MS * 8 });
      // The author's feed is in the history.
      await afterPlaceRead();

      send("tab-history-go", { forward: false });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
      await waitFor(() => expect(screen.getByTestId("detail-title")).toHaveTextContent("alpha-block"));
      await waitFor(() => expect(commandMocks.reportTabHistory).toHaveBeenLastCalledWith(true, true));
    });

    it("returns to an author's feed, a grid even when the tab's mode is Graph", async () => {
      const view = tabView({ location: { kind: "author", author: "@kotecinho" }, mode: "graph" });
      renderTab({ restore: { path: "/vault", view, saved: view } });
      await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("author @kotecinho:"));
      expect(screen.queryByTestId("graph-view")).toBeNull();
      expect(commandMocks.gridPlaces[0]).toEqual({ kind: "author", author: "@kotecinho" });
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

    it("keeps the space's notices and preview work to its lead tab (В19)", async () => {
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
        expect(screen.queryByText("This element is a file")).toBeNull();
        expect(vi.mocked(commands.completeFirstCardMarker)).not.toHaveBeenCalled();

        // This tab starts leading: the notice shows here, and it cannot be
        // closed: closing would hide the work and stop nothing (О13).
        rerender(view(true));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(vi.mocked(useThumbnailUpgrade)).toHaveBeenLastCalledWith(true);
        expect(screen.getByText("Indexing “vault”")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
      } finally {
        vi.useRealTimers();
        vi.mocked(commands.firstCardMarkerPending).mockResolvedValue(false);
      }
    });

    it("tells the space's iCloud conflicts in the lead tab only, with the side menu collapsed (ВК10)", async () => {
      const commands = await import("@/lib/commands");
      vi.mocked(commands.listVaultConflictPaths).mockResolvedValue(["Cards/Note.md"]);
      sidebarResizeState.collapsed = true;
      const view = (lead: boolean) => (
        <MemoryRouter initialEntries={["/"]}>
          <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} tabPage lead={lead} />
        </MemoryRouter>
      );
      try {
        const { rerender } = render(view(false));
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        expect(screen.queryByText("iCloud sync conflict")).toBeNull();

        rerender(view(true));
        expect(await screen.findByText("iCloud sync conflict")).toBeInTheDocument();
        expect(screen.getByText("“Note” has versions from more than one device.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
      } finally {
        vi.mocked(commands.listVaultConflictPaths).mockResolvedValue([]);
        sidebarResizeState.collapsed = false;
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

    describe("in a narrow window (SPEC_NARROW_WINDOW.md, У4 по У7, У12)", () => {
      const wideWindow = window.innerWidth;
      const resizeWindow = (width: number) => act(() => {
        window.innerWidth = width;
        window.dispatchEvent(new Event("resize"));
      });
      const panel = () => screen.queryByRole("dialog", { name: "Sidebar" });
      const feed = () => document.querySelector("main[data-below-top-row]");

      beforeEach(() => {
        window.innerWidth = 500;
        commandMocks.reportSidebarOverlay.mockClear();
        sidebarResizeState.toggleCollapsed.mockClear();
      });

      afterEach(() => {
        window.innerWidth = wideWindow;
        sidebarResizeState.collapsed = false;
      });

      it("lays the sidebar over the feed only when opened, the space switcher with it (У4, У12)", async () => {
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        // Closed: neither the sidebar nor its filter row in the page.
        expect(document.querySelector("[data-app-top-sidebar-segment]")).toBeNull();
        expect(document.querySelector("[data-sidebar-mock]")).toBeNull();
        expect(screen.queryByRole("textbox", { name: "Find or create collection" })).toBeNull();
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("closed");

        // The backend hands the toggle to the page (47.3b).
        act(() => send("sidebar-overlay-command", { kind: "toggle" }));
        const opened = panel();
        expect(opened).not.toBeNull();
        expect(opened?.querySelector("[data-sidebar-mock]")).not.toBeNull();
        expect(opened?.querySelector("[data-top-chrome-space-search-group]")).not.toBeNull();
        expect(feed()).toHaveAttribute("inert");
        expect(document.querySelector("header")).toHaveAttribute("inert");
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("open");
        // The toggle beside the feed is not touched over it.
        expect(sidebarResizeState.toggleCollapsed).not.toHaveBeenCalled();

        // A collection goes, then the sidebar closes (У6).
        fireEvent.click(within(opened as HTMLElement).getByRole("link", { name: "alpha" }));
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("closed");
        expect(feed()).not.toHaveAttribute("inert");
        await waitFor(() => expect(panel()).toBeNull());
      });

      it("opens on the bottom bar's button and on a swipe, and closes on a swipe back (У4, У11)", async () => {
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        const barToggle = () => document.querySelector("[data-bar-entry='toggle-sidebar'] button");
        expect(barToggle()).toHaveTextContent("Show Sidebar");
        fireEvent.click(barToggle() as HTMLElement);
        expect(panel()).not.toBeNull();
        expect(barToggle()).toHaveTextContent("Hide Sidebar");

        act(() => send("sidebar-overlay-command", { kind: "swipe", open: false }));
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("closed");
        act(() => send("sidebar-overlay-command", { kind: "swipe", open: true }));
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("open");
      });

      it("opens on ⇧⌘F with the cursor in the collections' filter, and Enter there closes it (У11)", async () => {
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        act(() => send("surface-search-shortcut", "sidebar"));
        const filter = screen.getByRole("textbox", { name: "Find or create collection" });
        expect(panel()).toContainElement(filter);
        expect(filter).toHaveFocus();

        fireEvent.change(filter, { target: { value: "alpha" } });
        fireEvent.keyDown(filter, { key: "Enter" });
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("alpha:1"));
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("closed");
      });

      it("stands beside the feed, shown, when the window widens with it open (У7)", async () => {
        sidebarResizeState.collapsed = true;
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        act(() => send("sidebar-overlay-command", { kind: "toggle" }));
        expect(panel()).not.toBeNull();

        resizeWindow(1200);
        expect(sidebarResizeState.toggleCollapsed).toHaveBeenCalledTimes(1);
        expect(commandMocks.reportSidebarOverlay).toHaveBeenLastCalledWith("beside");
        expect(document.querySelector("[data-app-top-sidebar-segment]")).not.toBeNull();
      });

      it("puts every command of the bottom bar at the left in one scrolling row, and back on widening (У13)", async () => {
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        const row = () => document.querySelector("[data-bottom-action-bar] [data-bottom-bar-row]");
        const spacer = () => document.querySelector("[data-bottom-action-bar] [data-bar-spacer]");
        expect(row()).not.toBeNull();
        expect(spacer()).toBeNull();
        expect(row()?.querySelector("[data-bar-entry='toggle-sidebar']")).not.toBeNull();
        expect(row()?.querySelector("[data-bar-entry='settings']")).not.toBeNull();

        resizeWindow(1200);
        expect(row()).toBeNull();
        expect(spacer()).not.toBeNull();
      });

      it("gives an open card's name the whole top row, in a narrow window and beside the open sidebar, and the place back with no card (У15)", async () => {
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        // The place's switcher stays in the page; away, it is inert, faded out
        // and out of the row's flow (23.10.2026).
        const place = () => {
          const slot = document.querySelector("[data-top-collection-switcher-slot]");
          return slot && !slot.hasAttribute("inert") ? slot : null;
        };
        const contentSegment = () =>
          document.querySelector("[data-main-secondary-top-bar-content-segment]") as HTMLElement;
        const detailLayer = () => document.querySelector("[data-secondary-detail-top-menu]") as HTMLElement | null;
        // No card: the place stands in the row.
        expect(place()).not.toBeNull();
        expect(contentSegment().previousElementSibling).toBe(place());

        fireEvent.click(screen.getByRole("button", { name: "Open alpha-block" }));
        await waitFor(() => expect(detailLayer()).toHaveAttribute("data-entered", "true"));
        // The card's name with its menu and close button take the row:
        // nothing stands before them, so no path's line either.
        expect(place()).toBeNull();
        // Before the half only the place's faded-out slot, out of the flow.
        expect(contentSegment().previousElementSibling).toHaveAttribute("inert");
        expect(contentSegment()).toHaveClass("flex-1");
        expect(contentSegment()).not.toHaveAttribute("data-path-card-line");
        expect(contentSegment()).not.toHaveClass("border-l");
        const name = document.querySelector("[data-secondary-detail-card-name]");
        expect(name).toHaveTextContent("alpha-block");
        // A name that does not fit ends in an ellipsis, as before.
        expect(name).toHaveClass("truncate");
        expect(within(detailLayer() as HTMLElement).getByRole("button", { name: "Close" })).toBeInTheDocument();

        // A wide window with the sidebar open beside the feed: the sidebar
        // shows the place, the name keeps the row (23.10.2026).
        resizeWindow(1200);
        expect(place()).toBeNull();
        expect(contentSegment()).not.toHaveAttribute("data-path-card-line");

        // Narrow again, the card closes: the place comes back once the name
        // has left the row.
        resizeWindow(500);
        expect(place()).toBeNull();
        fireEvent.click(within(detailLayer() as HTMLElement).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(detailLayer()).toBeNull());
        expect(place()).not.toBeNull();
        expect(contentSegment().previousElementSibling).toBe(place());
        expect(contentSegment()).not.toHaveAttribute("data-path-card-line");
      });

      it("leaves a collapsed sidebar collapsed when the window widens with it closed (У7)", async () => {
        sidebarResizeState.collapsed = true;
        renderTab();
        await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:2"));
        resizeWindow(1200);
        expect(sidebarResizeState.toggleCollapsed).not.toHaveBeenCalled();
      });
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
