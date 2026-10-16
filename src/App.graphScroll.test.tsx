// The feed comes back from Graph where it stood (SPEC_GRAPH_VIEW.md, «Возврат
// из графа»): the card at its top waits as the tab's scroll anchor while the
// graph shows the place, and the feed returns to it. Kept apart from
// App.test.tsx: it needs only the feed, the graph and the place.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type {
  GridSnapshot,
  LightBlock,
  ScrollAnchor,
  TabLocation,
  TabView,
  TaxonomySnapshot,
  VaultOpenResult,
} from "@/types";
// Before the commands: the mocked commands build their cards with it.
import { lightBlock } from "@/test/blocks";
import { listGridBlocks, reportTabView } from "@/lib/commands";
import { TAB_VIEW_REPORT_DEBOUNCE_MS } from "@/lib/tabPage";
import { AppWithVault } from "./App";

const ALL_BLOCKS = vi.hoisted(() => ["alpha-block", "beta-block", "gamma-block"]);

/// Where the mocked feed says it stands: the card at its top, or null at the
/// feed's top.
const feedState = vi.hoisted(() => ({ anchor: null as ScrollAnchor | null }));

function block(id: number, slug: string): LightBlock {
  return lightBlock({
    id,
    slug,
    card_kind: "article",
    block_type: "article",
    title: slug,
    body: `${slug} body`,
    collections: [],
  });
}

function snapshot(blocks: LightBlock[]): GridSnapshot {
  return { generation: 1, blocks, total_blocks: blocks.length, has_more: false };
}

const TAXONOMY: TaxonomySnapshot = {
  generation: 1,
  tags: [{ tag: "alpha", count: 1 }],
  channels: [{
    tag: "alpha",
    description: null,
    color: null,
    icon: null,
    position: 0,
    created_at: "2026-04-17T00:00:00Z",
    block_count: 1,
  }],
  total_blocks: ALL_BLOCKS.length,
  memberships: [],
};

const VAULT_OPEN: VaultOpenResult = {
  indexed: ALL_BLOCKS.length,
  errors: 0,
  sync_in_progress: false,
  derived_store_ready: true,
  thumbs_root: "/derived/thumbs",
};

vi.mock("@/lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commands")>();
  const all = ALL_BLOCKS.map((slug, index) => block(index + 1, slug));
  return {
    ...actual,
    cloudRecommendationState: vi.fn(async () => ({ due: false })),
    listVaultConflictPaths: vi.fn(async (): Promise<string[]> => []),
    listVaultConflicts: vi.fn(async () => []),
    firstCardMarkerPending: vi.fn(async () => false),
    spaceOnboardingPending: vi.fn(async () => false),
    getVaultPath: vi.fn(async () => null),
    getUnavailableVault: vi.fn(async () => null),
    listSpaces: vi.fn(async () => []),
    openVault: vi.fn(async () => VAULT_OPEN),
    startVaultSync: vi.fn(async () => true),
    recordStartupMilestone: vi.fn(async () => undefined),
    startStartupMaintenance: vi.fn(async () => true),
    sweepVaultThumbnails: vi.fn(async () => 0),
    listGridBlocks: vi.fn(async (place: TabLocation) => (
      snapshot(place.kind === "collection" ? all.slice(0, 1) : all)
    )),
    searchGridBlocks: vi.fn(async () => ({
      generation: 1,
      search_generation: 1,
      blocks: [],
      has_more: false,
      next_cursor: null,
      cursor_reset: false,
    })),
    listTaxonomySnapshot: vi.fn(async () => TAXONOMY),
    listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
    getGridRows: vi.fn(async () => ({ path: "/vault", generation: 1, blocks: [] })),
    getTabBootstrap: vi.fn(async () => null),
    reportTabView: vi.fn(async () => {}),
    reportTabHistory: vi.fn(async () => {}),
    tabPainted: vi.fn(async () => {}),
    setWindowSidebar: vi.fn(async () => {}),
    reportSidebarOverlay: vi.fn(async () => {}),
    reportWindowSurface: vi.fn(async () => {}),
  };
});

vi.mock("@/hooks/useThumbnailUpgrade", () => ({ useThumbnailUpgrade: vi.fn() }));
vi.mock("@/hooks/useChannelPreviewsEvents", () => ({
  useChannelPreviewsEvents: () => ({
    channelPreviews: new Map(),
    refresh: vi.fn().mockResolvedValue(undefined),
    bumpThumbVersion: vi.fn(),
  }),
}));
vi.mock("@/components/VaultPicker", () => ({ VaultPicker: () => <div>Vault Picker</div> }));
vi.mock("@/components/SidebarResizeHandle", () => ({ SidebarResizeHandle: () => null }));

// The feed as App drives it: it reports where it stands through the reader it
// hands App, and shows the anchor App asks it to return to.
vi.mock("@/components/Grid", () => ({
  Grid: ({
    blocks,
    currentTag,
    restoreScrollAnchor,
    onScrollAnchorRestored,
    onScrollPositionChange,
  }: {
    blocks: LightBlock[];
    currentTag?: string;
    restoreScrollAnchor?: ScrollAnchor | null;
    onScrollAnchorRestored?: () => void;
    onScrollPositionChange?: (read: () => ScrollAnchor | null) => void;
  }) => (
    <div>
      <div data-testid="grid">{`${currentTag ?? "__all__"}:${blocks.length}`}</div>
      <div data-testid="grid-scroll-restore">
        {restoreScrollAnchor ? `${restoreScrollAnchor.slug}:${restoreScrollAnchor.offset_px}` : "none"}
      </div>
      <button type="button" onClick={() => onScrollPositionChange?.(() => feedState.anchor)}>
        Report scroll
      </button>
      <button type="button" onClick={() => onScrollAnchorRestored?.()}>
        Finish scroll restore
      </button>
    </div>
  ),
}));

vi.mock("@/components/GraphView", () => ({
  GraphView: ({ currentCollection }: { currentCollection?: string }) => (
    <div data-testid="graph-view">{currentCollection ?? "__all__"}</div>
  ),
}));

vi.mock("@/components/Sidebar", async () => {
  const { Link } = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    Sidebar: ({ topRow = null }: { topRow?: ReactNode }) => (
      <nav>
        {topRow}
        <Link to="/">Everything</Link>
        <Link to="/channel/alpha">alpha</Link>
      </nav>
    ),
  };
});

function renderApp(entry = "/", props: Partial<Parameters<typeof AppWithVault>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

function tabView(overrides: Partial<TabView> = {}): TabView {
  return {
    location: { kind: "everything" },
    mode: "grid",
    open_card: null,
    scroll_anchor: null,
    collection_filter: "",
    ...overrides,
  };
}

/// The tab's memory as last reported, once a report interval has let it out.
async function expectReported(view: TabView) {
  await waitFor(() => expect(vi.mocked(reportTabView)).toHaveBeenLastCalledWith(view), {
    timeout: TAB_VIEW_REPORT_DEBOUNCE_MS * 8,
  });
}

function switchTo(mode: "Grid" | "Graph") {
  const switcher = document.querySelector<HTMLElement>("[data-main-view-mode-switcher]");
  if (!switcher) throw new Error("The Grid | Graph switch is not on the page");
  fireEvent.mouseDown(within(switcher).getByRole("tab", { name: mode }), { button: 0 });
}

/// Scroll the feed so the anchor's card stands at its top (null: the feed's
/// own top), as the real feed reports it.
function scrollFeedTo(anchor: ScrollAnchor | null) {
  feedState.anchor = anchor;
  fireEvent.click(screen.getByRole("button", { name: "Report scroll" }));
}

describe("the feed comes back from Graph where it stood (SPEC_GRAPH_VIEW.md, «Возврат из графа»)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feedState.anchor = null;
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it.each([
    { name: "Everything", entry: "/", graph: "__all__", feed: "__all__:3", anchor: { slug: "gamma-block", offset_px: 24 } },
    { name: "a collection", entry: "/channel/alpha", graph: "alpha", feed: "alpha:1", anchor: { slug: "alpha-block", offset_px: 8 } },
  ])("returns $name to the card that stood at the feed's top before Graph", async ({ entry, graph, feed, anchor }) => {
    renderApp(entry);
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent(feed));
    expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("none");
    scrollFeedTo(anchor);
    const feedReads = vi.mocked(listGridBlocks).mock.calls.length;

    switchTo("Graph");
    expect(await screen.findByTestId("graph-view")).toHaveTextContent(graph);
    expect(screen.queryByTestId("grid")).toBeNull();
    // While the graph shows the place, its feed's anchor waits and no page is
    // read for it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(listGridBlocks).mock.calls.length).toBe(feedReads);

    switchTo("Grid");
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent(feed));
    expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent(`${anchor.slug}:${anchor.offset_px}`);

    // Once the feed stands there, nothing more is asked of it.
    fireEvent.click(screen.getByRole("button", { name: "Finish scroll restore" }));
    expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("none");
  });

  it("leaves the feed at its top when it stood at its top", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:3"));
    scrollFeedTo(null);

    switchTo("Graph");
    expect(await screen.findByTestId("graph-view")).toBeInTheDocument();
    switchTo("Grid");
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:3"));
    expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("none");
  });

  it("keeps the anchor to its place: another place in Graph drops it", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:3"));
    scrollFeedTo({ slug: "gamma-block", offset_px: 24 });

    switchTo("Graph");
    expect(await screen.findByTestId("graph-view")).toHaveTextContent("__all__");
    fireEvent.click(screen.getByRole("link", { name: "alpha" }));
    await waitFor(() => expect(screen.getByTestId("graph-view")).toHaveTextContent("alpha"));
    fireEvent.click(screen.getByRole("link", { name: "Everything" }));
    await waitFor(() => expect(screen.getByTestId("graph-view")).toHaveTextContent("__all__"));

    switchTo("Grid");
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:3"));
    expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("none");
  });

  it("remembers in the tab the anchor waiting in Graph, and none once Graph shows another place", async () => {
    renderApp("/", { tabPage: true });
    await waitFor(() => expect(screen.getByTestId("grid")).toHaveTextContent("__all__:3"));
    await expectReported(tabView());
    scrollFeedTo({ slug: "gamma-block", offset_px: 24 });

    switchTo("Graph");
    await screen.findByTestId("graph-view");
    await expectReported(tabView({ mode: "graph", scroll_anchor: { slug: "gamma-block", offset_px: 24 } }));

    // The feed is off the page: what it last said belongs to Everything.
    fireEvent.click(screen.getByRole("link", { name: "alpha" }));
    await waitFor(() => expect(screen.getByTestId("graph-view")).toHaveTextContent("alpha"));
    await expectReported(tabView({ location: { kind: "collection", tag: "alpha" }, mode: "graph" }));
  });

  it("returns a tab saved in Graph to its feed's card when it goes to Grid", async () => {
    const view = tabView({ mode: "graph", scroll_anchor: { slug: "beta-block", offset_px: 40 } });
    renderApp("/", { tabPage: true, restore: { path: "/vault", view, saved: view } });
    expect(await screen.findByTestId("graph-view")).toHaveTextContent("__all__");

    switchTo("Grid");
    await waitFor(() => expect(screen.getByTestId("grid-scroll-restore")).toHaveTextContent("beta-block:40"));
  });
});
