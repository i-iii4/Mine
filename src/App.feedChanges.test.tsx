// After a change the page reads only the cards that changed, not the whole
// loaded feed (SPEC_FRONTEND.md, «Обновление ленты»; AUDIT_PERFORMANCE.md,
// Л3, item 10 of the plan). Kept apart from App.test.tsx: the commands run
// through their real wrappers against a small backend held in memory, so the
// answers carry the cards a command named, and the feed holds 7 000 cards.

import { loadavg } from "node:os";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type {
  GridSnapshot,
  LightBlock,
  TabLocation,
  TaxonomySnapshot,
  VaultOpenResult,
} from "@/types";
// Before the commands: the backend in memory builds its cards with it.
import { lightBlock } from "@/test/blocks";
import { feedPatchOf } from "@/test/feedBackend";
import { takeOwnFeedChanges } from "@/lib/feedChanges";
import { AppWithVault } from "./App";

/// The space the page reads: the feed of Everything in its order, and every
/// command the page sent.
const space = vi.hoisted(() => ({
  cards: [] as LightBlock[],
  generation: 1,
  calls: [] as Array<{ command: string; args: Record<string, unknown>; at: number }>,
  /// When the last command that changes the space answered.
  answeredAt: 0,
  /// How far the feed loads on its own before the test acts.
  loadUntil: 0,
  /// When the feed last drew each card's row, by slug.
  drawn: new Map<string, { row: string; at: number }>(),
  /// The list the feed was last handed.
  list: [] as LightBlock[],
  /// The card the feed's commands act on.
  chosen: "",
}));

const PAGE_SIZE = 200;

function card(id: number, collections: string[] = []): LightBlock {
  return lightBlock({
    id,
    slug: `card-${id}`,
    card_kind: "article",
    block_type: "article",
    title: `Card ${id}`,
    body: "",
    collections,
  });
}

function rowOf(block: LightBlock): string {
  return `${block.id}:${block.slug}:${block.title ?? ""}:${block.collections.join("+")}`;
}

/// The backend's feed page (`list_grid_blocks`).
function feedPage(offset: number, limit: number): GridSnapshot {
  const blocks = space.cards.slice(offset, offset + limit);
  return {
    generation: space.generation,
    blocks,
    total_blocks: space.cards.length,
    has_more: offset + limit < space.cards.length,
  };
}

/// What the command changed: its answer with the cards it named, as the
/// backend's commands answer (SPEC_INTEGRATION.md, «Список изменённых
/// карточек»).
function changed<T>(value: T, cards: number[]) {
  space.generation += 1;
  space.answeredAt = performance.now();
  return { value, cards };
}

function setCollections(slug: string, change: (collections: string[]) => string[]): number[] {
  const index = space.cards.findIndex((block) => block.slug === slug);
  if (index < 0) return [];
  const current = space.cards[index]!;
  space.cards[index] = { ...current, collections: change(current.collections) };
  return [current.id];
}

const TAXONOMY: TaxonomySnapshot = {
  generation: 1,
  tags: [{ tag: "beta", count: 0 }],
  channels: [{
    tag: "beta",
    description: null,
    color: null,
    icon: null,
    position: 0,
    created_at: "2026-04-17T00:00:00Z",
    block_count: 0,
  }],
  total_blocks: 0,
  memberships: [],
};

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...actual,
    invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
      space.calls.push({ command, args, at: performance.now() });
      switch (command) {
        case "list_grid_blocks": {
          // The page after the place of a card: the card itself may be gone.
          const after = args.after as { slug: string } | null;
          const offset = after === null ? 0 : space.cards.findIndex((block) => block.slug === after.slug) + 1;
          return feedPage(offset, Number(args.limit ?? PAGE_SIZE));
        }
        case "read_feed_changes":
          return feedPatchOf(space.cards, args.cards as number[], args.end as number | null, {
            path: "/vault",
            generation: space.generation,
          });
        case "list_taxonomy_snapshot":
          return { ...TAXONOMY, generation: space.generation, total_blocks: space.cards.length };
        case "add_tag":
          return changed(null, setCollections(String(args.slug), (collections) => [...collections, String(args.tag)]));
        case "remove_tag":
          return changed(null, setCollections(String(args.slug), (collections) => collections.filter((tag) => tag !== args.tag)));
        case "delete_blocks": {
          const slugs = args.slugs as string[];
          const gone = space.cards.filter((block) => slugs.includes(block.slug)).map((block) => block.id);
          space.cards = space.cards.filter((block) => !slugs.includes(block.slug));
          return changed({ removed: gone.length, kept_media: [] }, gone);
        }
        default:
          return null;
      }
    }),
  };
});

const VAULT_OPEN: VaultOpenResult = {
  indexed: 0,
  errors: 0,
  sync_in_progress: false,
  derived_store_ready: true,
  thumbs_root: "/derived/thumbs",
};

vi.mock("@/lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commands")>();
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
    searchGridBlocks: vi.fn(async () => ({
      generation: 1,
      search_generation: 1,
      blocks: [],
      has_more: false,
      next_cursor: null,
      cursor_reset: false,
    })),
    listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
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
vi.mock("@/components/GraphView", () => ({ GraphView: () => null }));
vi.mock("@/components/Sidebar", () => ({
  Sidebar: ({ topRow = null }: { topRow?: ReactNode }) => <nav>{topRow}</nav>,
}));

// The feed as App drives it. It loads pages on its own up to `loadUntil`,
// notes when it drew each card's row, and hands the test the commands a card
// and a selection send.
vi.mock("@/components/Grid", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  function MockGrid({
    blocks,
    hasMoreBlocks,
    loadingMoreBlocks,
    onLoadMoreBlocks,
    onToggleTag,
    onDeleteSelectedBlocks,
    onCardMenuOpenChange,
  }: {
    blocks: LightBlock[];
    hasMoreBlocks?: boolean;
    loadingMoreBlocks?: boolean;
    onLoadMoreBlocks?: () => void;
    onToggleTag?: (slug: string, tag: string, hasTag: boolean) => void | Promise<unknown>;
    onDeleteSelectedBlocks?: (slugs: string[], deleteUnusedMedia: boolean, offeredMedia: never[]) => Promise<void>;
    onCardMenuOpenChange?: (slug: string, open: boolean) => void;
  }) {
    useEffect(() => {
      if (blocks.length >= space.loadUntil || !hasMoreBlocks || loadingMoreBlocks) return;
      onLoadMoreBlocks?.();
    }, [blocks.length, hasMoreBlocks, loadingMoreBlocks, onLoadMoreBlocks]);
    const now = performance.now();
    space.list = blocks;
    for (const block of blocks) {
      const row = rowOf(block);
      if (space.drawn.get(block.slug)?.row !== row) space.drawn.set(block.slug, { row, at: now });
    }
    return (
      <div>
        <div data-testid="grid-count">{blocks.length}</div>
        <div data-testid="grid-more">{String(Boolean(hasMoreBlocks))}</div>
        <div data-testid="grid-head">{blocks.slice(0, 6).map(rowOf).join(",")}</div>
        <button type="button" onClick={() => void onToggleTag?.(space.chosen, "beta", false)}>
          Connect the card to beta
        </button>
        <button type="button" onClick={() => void onDeleteSelectedBlocks?.([space.chosen], false, [])}>
          Delete the card
        </button>
        <button type="button" onClick={() => onCardMenuOpenChange?.(space.chosen, true)}>
          Open the card's menu
        </button>
        <button type="button" onClick={() => onCardMenuOpenChange?.(space.chosen, false)}>
          Close the card's menu
        </button>
      </div>
    );
  }
  return { Grid: MockGrid };
});

/// The feed's list as the page holds it.
function shownRows(): string[] {
  return space.list.map(rowOf);
}

function feedReads() {
  return space.calls.filter((call) => call.command === "list_grid_blocks");
}

function partialReads() {
  return space.calls.filter((call) => call.command === "read_feed_changes");
}

function choose(slug: string) {
  space.chosen = slug;
}

function news(payload: Record<string, unknown>) {
  fireEvent(window, new CustomEvent("vault-changed", { detail: { payload: { path: "/vault", renames: [], ...payload } } }));
}

/// Open the space with `total` cards and let the feed load `loaded` of them.
async function openFeed(total: number, loaded: number) {
  space.cards = Array.from({ length: total }, (_, index) => card(index + 1));
  space.loadUntil = loaded;
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppWithVault vaultPath="/vault" onVaultSelected={vi.fn()} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByTestId("grid-count")).toHaveTextContent(String(loaded)), { timeout: 20_000 });
  // From here the feed stands still: it asks for no page on its own.
  space.loadUntil = 0;
  space.calls.length = 0;
}

/// The list a full read of the same length gives now.
function fullReadRows(): string[] {
  return space.cards.slice(0, space.list.length).map(rowOf);
}

describe("the feed after a change reads only the cards that changed (SPEC_FRONTEND.md, «Обновление ленты»)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    takeOwnFeedChanges();
    space.calls.length = 0;
    space.generation = 1;
    space.answeredAt = 0;
    space.drawn.clear();
    space.list = [];
    space.chosen = "";
  });

  // Item 10 of the plan: after a card is connected with 7 000 cards loaded,
  // no read of the feed from its first card, and the feed shows the change
  // within 50 ms of the command's answer.
  it("connects a card with 7 000 loaded without reading the feed from its first card, within 50 ms", async () => {
    await openFeed(7_200, 7_000);
    expect(screen.getByTestId("grid-more")).toHaveTextContent("true");

    const took: number[] = [];
    for (const id of [3_500, 12, 6_990]) {
      const slug = `card-${id}`;
      choose(slug);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Connect the card to beta" }));
      });
      await waitFor(() => expect(space.drawn.get(slug)?.row).toBe(`${id}:${slug}:Card ${id}:beta`));
      took.push(space.drawn.get(slug)!.at - space.answeredAt);
    }

    // Three connects, three reads of one card each, and no read of the feed.
    expect(feedReads()).toEqual([]);
    expect(partialReads().map((call) => call.args)).toEqual([3_500, 12, 6_990].map((id) => ({
      path: "/vault",
      location: { kind: "everything" } satisfies TabLocation,
      order: "newest",
      cards: [id],
      // The last card of the 7 000 the page holds: the feed has more.
      end: 7_000,
      reason: "own_command",
    })));
    expect(screen.getByTestId("grid-count")).toHaveTextContent("7000");
    expect(shownRows()).toEqual(fullReadRows());

    const sorted = [...took].sort((a, b) => a - b);
    // The test setup silences `console.info`; the numbers go to the run's output.
    process.stdout.write(
      `[feed-changes] connect with 7000 loaded: answer to drawn ${took.map((ms) => ms.toFixed(1)).join(", ")} ms; load ${loadavg()[0]!.toFixed(1)}\n`,
    );
    expect(sorted[1]!).toBeLessThan(50);
  }, 60_000);

  it("removes deleted cards without reading the feed, and the list equals a full read", async () => {
    await openFeed(900, 600);
    choose("card-250");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete the card" }));
    });
    await waitFor(() => expect(screen.getByTestId("grid-count")).toHaveTextContent("599"));
    expect(feedReads()).toEqual([]);
    expect(partialReads()).toHaveLength(1);
    expect(partialReads()[0]!.args).toMatchObject({ cards: [250], end: 600, reason: "own_command" });
    expect(shownRows()).toEqual(fullReadRows());
    expect(screen.getByTestId("grid-more")).toHaveTextContent("true");
  }, 30_000);

  it("reads the cards another tab's command named, and the whole feed for news that names none", async () => {
    await openFeed(900, 600);

    // Another tab connected a card and created one, which stands first.
    setCollections("card-40", () => ["beta"]);
    space.cards.unshift(card(5_000));
    space.generation += 1;
    news({ cards: [40, 5_000] });
    await waitFor(() => expect(screen.getByTestId("grid-count")).toHaveTextContent("601"));
    expect(feedReads()).toEqual([]);
    expect(partialReads()).toHaveLength(1);
    expect(partialReads()[0]!.args).toMatchObject({ cards: [40, 5_000], end: 600, reason: "news" });
    expect(screen.getByTestId("grid-head")).toHaveTextContent("5000:card-5000:Card 5000:");
    expect(shownRows()).toEqual(fullReadRows());

    // The watcher's news names no card: the feed is read in full, from its
    // first card, over the whole loaded range rounded to pages.
    space.calls.length = 0;
    space.cards.splice(10, 1);
    space.generation += 1;
    news({ cards: null });
    const fromFirstCard = () => feedReads().filter((call) => call.args.after === null);
    await waitFor(() => expect(fromFirstCard()).toHaveLength(1), { timeout: 4_000 });
    expect(fromFirstCard()[0]!.args).toMatchObject({ limit: 800, reason: "news" });
    expect(partialReads()).toEqual([]);
    await waitFor(() => expect(shownRows()).toEqual(fullReadRows()));
  }, 30_000);

  it("reads one card's row when its menu closes, not the feed", async () => {
    await openFeed(900, 600);
    choose("card-77");
    fireEvent.click(screen.getByRole("button", { name: "Open the card's menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Close the card's menu" }));
    await waitFor(() => expect(partialReads()).toHaveLength(1));
    expect(partialReads()[0]!.args).toMatchObject({ cards: [77], reason: "card_menu" });
    expect(feedReads()).toEqual([]);
  }, 30_000);

  it("reads the feed in full after a command that failed", async () => {
    await openFeed(400, 400);
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementationOnce(async (command: string, args?: unknown) => {
      space.calls.push({ command, args: (args ?? {}) as Record<string, unknown>, at: performance.now() });
      throw { kind: "internal", message: "the note could not be written" };
    });
    choose("card-9");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect the card to beta" }));
    });
    await waitFor(() => expect(feedReads()).toHaveLength(1));
    expect(feedReads()[0]!.args).toMatchObject({ after: null, limit: 400, reason: "own_command" });
    expect(partialReads()).toEqual([]);
  }, 30_000);
});
