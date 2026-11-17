// The feed while its list grows and changes (SPEC_GRID.md, «Кэш при карточке
// и продолжение раскладки»).
//
// The feed keeps what it read of a card by the card's row and lays a changed
// list out from the first card that differs. These tests hold the feed on the
// page to that: a changed card stands at its new height, not at the height
// kept for the row it replaced; a page added to the end draws no card again
// and moves none; the layout key follows the cards. Card is replaced by a
// counter of its renders, as in Grid.gridItemMemo.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { LightBlock } from "@/types";

const { cardRenderCounts } = vi.hoisted(() => ({
  cardRenderCounts: new Map<string, number>(),
}));

vi.mock("./Card", async () => {
  const React = await import("react");
  const Card = React.memo(function MockCard(props: { block: { slug: string } }) {
    cardRenderCounts.set(props.block.slug, (cardRenderCounts.get(props.block.slug) ?? 0) + 1);
    return React.createElement("div", { "data-block-slug": props.block.slug, "data-mock-card": "" });
  });
  const CardSkeleton = function MockCardSkeleton(props: { block: { slug: string } }) {
    return React.createElement("div", { "data-block-slug": props.block.slug, "data-mock-skeleton": "" });
  };
  return { Card, CardSkeleton };
});

import { Grid } from "./Grid";
import { reconcileBlocks } from "@/lib/blockIdentity";
import { FEED_COLUMN_MIN_WIDTH_PX, computeCardHeight } from "@/lib/cardHeight";
import { computeMasonryLayout, getMasonryColumnWidth } from "@/lib/masonryLayout";
import { lightBlock } from "@/test/blocks";

const FEED_WIDTH = 760;
const GAP = 32;
const SHAPES = [[640, 360], [640, 480], [640, 640], [480, 640]] as const;

/** A picture card: its height is its preview's shape, no word widths needed. */
function picture(id: number, shape = id % SHAPES.length): LightBlock {
  const [width, height] = SHAPES[shape]!;
  return lightBlock({
    id,
    slug: `block-${id}`,
    block_type: "image",
    card_kind: "media",
    media_file: `image-${id}.jpg`,
    saved_at: "2026-01-01T00:00:00Z",
    width: 1600,
    height: 1200,
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: `image-${id}.jpg`,
      width: 1600,
      height: 1200,
      preview_width: width,
      preview_height: height,
      tiles: [],
      overflow_count: 0,
    }),
  });
}

/** The height of a row no cache has seen. */
function freshHeight(block: LightBlock): number {
  return computeCardHeight({ ...block }, getMasonryColumnWidth(FEED_WIDTH, FEED_COLUMN_MIN_WIDTH_PX, GAP), null, "cards");
}

interface Shown {
  left: number;
  top: number;
  height: number;
}

/** Where the card stands on the page, read from its element. */
function shown(slug: string): Shown {
  const element = document.querySelector<HTMLElement>(`[data-feed-grid-item-slug="${slug}"]`);
  if (!element) throw new Error(`${slug} is not on the page`);
  const [, left, top] = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0(?:px)?\)/.exec(element.style.transform) ?? [];
  return { left: Number(left), top: Number(top), height: Number.parseFloat(element.style.height) };
}

// ─── Environment mocks (mirrors Grid.gridItemMemo.test.tsx) ─────────────────

const mockViewport = { width: FEED_WIDTH, height: 20_000 };

class MockResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element): void {
    const contentRect = {
      width: mockViewport.width, height: mockViewport.height, top: 0, left: 0,
      right: mockViewport.width, bottom: mockViewport.height, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRectReadOnly;
    this.cb([{ target: el, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const BASE_PROPS = {
  vaultPath: "/tmp/vault",
  tags: [],
  scrollToTop: 0,
  currentTag: "feed-growth",
  onBlockClick: vi.fn(),
  onToggleTag: vi.fn(),
  onCreateAndAssign: vi.fn(),
  onLoadBlockTags: vi.fn(async (slugs: string[]) => new Map(slugs.map((slug) => [slug, ["test"]]))),
  onBatchSetTag: vi.fn(),
  onCreateAndAssignBatch: vi.fn(),
  onPrepareDeleteSelectedBlocks: vi.fn(async (slugs: string[]) => ({ slugs, markdown_files: [], unused_media: [], shared_media: [] })),
  onDeleteSelectedBlocks: vi.fn(async () => undefined),
  onMergeSelectedBlocks: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

async function show(blocks: LightBlock[]) {
  const view = render(<Grid {...BASE_PROPS} blocks={blocks} />);
  await flushAsync();
  return {
    update: async (next: LightBlock[]) => {
      await act(async () => {
        view.rerender(<Grid {...BASE_PROPS} blocks={next} />);
      });
      await flushAsync();
    },
  };
}

beforeEach(() => {
  cardRenderCounts.clear();
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = vi.fn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the feed on a list that grows and changes", () => {
  it("shows a changed card at its new height and moves only the cards under it", async () => {
    const blocks = Array.from({ length: 12 }, (_, index) => picture(index + 1));
    const feed = await show(blocks);
    const before = new Map(blocks.map((block) => [block.slug, shown(block.slug)]));
    const rendersBefore = new Map(cardRenderCounts);

    // The row of the second card arrives with a preview of another shape;
    // every other row is read again as it was.
    const changed = picture(2, 3);
    const arrived = blocks.map((block) => (block.id === 2 ? changed : structuredClone(block)));
    const next = reconcileBlocks(blocks, arrived);
    expect(next[1]).toBe(changed);
    await feed.update(next);

    const was = before.get("block-2")!;
    const now = shown("block-2");
    expect(freshHeight(changed)).not.toBe(was.height);
    // The new height, not the one kept for the row it replaced.
    expect(now.height).toBe(freshHeight(changed));
    expect(now.top).toBe(was.top);
    for (const block of blocks) {
      if (block.id === 2) continue;
      const stood = before.get(block.slug)!;
      const stands = shown(block.slug);
      const under = stood.left === was.left && stood.top > was.top;
      expect(stands.left).toBe(stood.left);
      expect(stands.top).toBe(under ? stood.top + now.height - was.height : stood.top);
      expect(stands.height).toBe(stood.height);
      // A card that did not change is not drawn again.
      expect(cardRenderCounts.get(block.slug)).toBe(rendersBefore.get(block.slug));
    }
    expect(cardRenderCounts.get("block-2")).toBe((rendersBefore.get("block-2") ?? 0) + 1);
  });

  it("stands a page added to the end under the cards held, which neither move nor are drawn again", async () => {
    const blocks = Array.from({ length: 12 }, (_, index) => picture(index + 1));
    const feed = await show(blocks);
    const before = new Map(blocks.map((block) => [block.slug, shown(block.slug)]));
    const rendersBefore = new Map(cardRenderCounts);

    const page = Array.from({ length: 6 }, (_, index) => picture(13 + index));
    const grown = [...blocks, ...page];
    await feed.update(grown);

    for (const block of blocks) {
      expect(shown(block.slug)).toEqual(before.get(block.slug));
      expect(cardRenderCounts.get(block.slug)).toBe(rendersBefore.get(block.slug));
    }
    // The whole feed stands as a feed laid out from its first card.
    const expected = computeMasonryLayout(grown.map(freshHeight), FEED_WIDTH, FEED_COLUMN_MIN_WIDTH_PX, GAP);
    grown.forEach((block, index) => {
      const position = expected.positions[index]!;
      expect(shown(block.slug)).toEqual({ left: position.left, top: position.top, height: position.height });
    });
  });

  it("moves the cards up when a card leaves, each in the column it stood in", async () => {
    const blocks = Array.from({ length: 12 }, (_, index) => picture(index + 1));
    const feed = await show(blocks);
    const before = new Map(blocks.map((block) => [block.slug, shown(block.slug)]));

    const gone = blocks[4]!;
    await feed.update(blocks.filter((block) => block !== gone));

    const left = before.get(gone.slug)!;
    expect(document.querySelector(`[data-feed-grid-item-slug="${gone.slug}"]`)).toBeNull();
    for (const block of blocks) {
      if (block === gone) continue;
      const stood = before.get(block.slug)!;
      const under = stood.left === left.left && stood.top > left.top;
      expect(shown(block.slug)).toEqual({
        left: stood.left,
        top: under ? stood.top - left.height - GAP : stood.top,
        height: stood.height,
      });
    }
  });

  it("keeps its layout key for rows read again unchanged, and changes it with a card", async () => {
    const blocks = Array.from({ length: 6 }, (_, index) => picture(index + 1));
    const feed = await show(blocks);
    const key = () => window.__MINE_FEED_SCROLL_DEBUG__?.layoutGenerationKey;
    const first = key();
    expect(first).toBeTruthy();

    await feed.update(reconcileBlocks(blocks, structuredClone(blocks)));
    expect(key()).toBe(first);

    const changed = reconcileBlocks(blocks, blocks.map((block) => (block.id === 3 ? picture(3, 0) : structuredClone(block))));
    await feed.update(changed);
    const second = key();
    expect(second).not.toBe(first);

    await feed.update([...changed, picture(7)]);
    expect(key()).not.toBe(second);
  });
});
