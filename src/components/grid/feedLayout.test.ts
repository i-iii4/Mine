import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";
import type { FeedShow } from "@/lib/feedDisplay";
import { FEED_COLUMN_MIN_WIDTH_PX, computeCardHeight } from "@/lib/cardHeight";
import { generationHasExactDeterministicHeights } from "@/lib/gridLayoutReadiness";
import {
  computeMasonryLayout,
  getMasonryColumnWidth,
  type MasonryLayout,
} from "@/lib/masonryLayout";
import { reconcileBlocks } from "@/lib/blockIdentity";
import { lightBlock } from "@/test/blocks";
import {
  columnsKept,
  everyHeightIsExact,
  layFeedOut,
  rememberedColumns,
  rememberedPosition,
  rememberedPositionAt,
  type ColumnMemory,
  type RememberedColumns,
} from "./feedLayout";

// The feed's layout keeps what it read of a card by the card's row and goes
// on from the layout it remembers (SPEC_GRID.md, «Кэш при карточке и
// продолжение раскладки»). Neither may change where a card stands: every
// layout here is held against the feed as it was laid out before, every
// height computed anew and every card placed from the first one.

const ROUTE = "__all__";

// ─── The feed as it was laid out before the cache ───────────────────────────

interface ReferenceMemory {
  routeKey: string;
  parentWidth: number;
  show: FeedShow;
  order: string[];
  column: Map<string, number>;
  exact: boolean;
}

function referenceColumns(
  memory: ReferenceMemory | null,
  blocks: readonly LightBlock[],
  parentWidth: number,
  show: FeedShow,
): ((index: number) => number | undefined) | null {
  if (
    memory === null
    || !memory.exact
    || memory.routeKey !== ROUTE
    || Math.abs(memory.parentWidth - parentWidth) > 0.5
    || memory.show !== show
  ) {
    return null;
  }
  const present = new Set(blocks.map((block) => block.slug));
  const kept = memory.order.filter((slug) => present.has(slug));
  let next = 0;
  for (const block of blocks) {
    if (!memory.column.has(block.slug)) continue;
    if (kept[next] !== block.slug) return null;
    next += 1;
  }
  return (index) => {
    const slug = blocks[index]?.slug;
    return slug === undefined ? undefined : memory.column.get(slug);
  };
}

/** Every height from a copy of the row, which no cache has seen. */
function referenceLayout(
  blocks: readonly LightBlock[],
  parentWidth: number,
  wordWidths: ReadonlyMap<number, WordWidths>,
  gap: number,
  show: FeedShow,
  columnOf: ((index: number) => number | undefined) | null,
): MasonryLayout {
  const columnWidth = getMasonryColumnWidth(parentWidth, FEED_COLUMN_MIN_WIDTH_PX, gap);
  const heights = blocks.map((block) => {
    const widths = wordWidths.get(block.id);
    return computeCardHeight({ ...block }, columnWidth, widths ? { ...widths } : null, show);
  });
  return computeMasonryLayout(heights, parentWidth, FEED_COLUMN_MIN_WIDTH_PX, gap, columnOf ?? undefined);
}

function referenceMemory(
  blocks: readonly LightBlock[],
  layout: MasonryLayout,
  parentWidth: number,
  show: FeedShow,
  exact: boolean,
): ReferenceMemory {
  const column = new Map<string, number>();
  for (const position of layout.positions) {
    const slug = blocks[position.index]?.slug;
    if (slug !== undefined) column.set(slug, position.column);
  }
  return { routeKey: ROUTE, parentWidth, show, order: blocks.map((block) => block.slug), column, exact };
}

// ─── Cards ──────────────────────────────────────────────────────────────────

/** The same numbers for the same seed on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const SHAPES = [[640, 360], [640, 480], [640, 640], [480, 640], [426, 640]] as const;

/** A card of one of four kinds; `variant` changes what its height reads. */
function card(id: number, variant = 0): LightBlock {
  const kind = id % 4;
  const [width, height] = SHAPES[(id + variant) % SHAPES.length]!;
  const manifest = JSON.stringify({
    kind: "image",
    primary_preview_path: `preview-${id}.jpg`,
    width: 1600,
    height: 1200,
    preview_width: width,
    preview_height: height,
    tiles: [],
    overflow_count: 0,
  });
  const text = Array.from({ length: 4 + ((id * 7 + variant * 5) % 40) }, (_, word) => `word${(id + word) % 13}`).join(" ");
  const base = { id, slug: `card-${id}`, saved_at: "2026-01-01T00:00:00Z" };
  if (kind === 0) {
    return lightBlock({ ...base, block_type: "image", card_kind: "media", media_file: `file-${id}.jpg`, width: 1600, height: 1200, preview_manifest: variant % 3 === 2 ? null : manifest });
  }
  if (kind === 1) {
    return lightBlock({ ...base, block_type: "link", card_kind: "link", title: `Title ${id} ${"more ".repeat(variant % 4)}`, url: `https://example.test/${id}`, preview_text: text, preview_manifest: manifest });
  }
  if (kind === 2) {
    return lightBlock({ ...base, title: `Article ${id}`, author: variant % 2 === 0 ? "Author" : null, body: text, preview_text: text });
  }
  return lightBlock({ ...base, title: `Post ${id}`, url: `https://x.com/mine/status/${id}`, author: "Author", body: text, preview_text: text });
}

/** Widths of a card's words: as many as its text has, by the card and `variant`. */
function widthsOf(block: LightBlock, variant = 0): WordWidths {
  const words = (text: string | null) => (text ?? "").split(/\s+/).filter(Boolean).map((word, index) => 12 + ((word.length * 5 + index + variant) % 37));
  const title = words(block.title);
  const preview = words(block.preview_text);
  return {
    title,
    preview,
    titleSpace: 3,
    previewSpace: 3,
    titleNoSpaceBefore: title.map(() => false),
    previewNoSpaceBefore: preview.map(() => false),
  };
}

// ─── A feed that changes the way the Grid drives it ─────────────────────────

interface Feed {
  blocks: LightBlock[];
  wordWidths: Map<number, WordWidths>;
  parentWidth: number;
  gap: number;
  show: FeedShow;
}

/**
 * The Grid's wiring of the layout: the remembered columns are read when the
 * list, the width or the presentation changes, the layout is made on every
 * change, and the layout made is remembered after it.
 */
function feedDriver(initial: Feed) {
  let feed = initial;
  let memory: ColumnMemory | null = null;
  let reference: ReferenceMemory | null = null;
  let columns: RememberedColumns | null = null;
  let referenceColumnOf: ((index: number) => number | undefined) | null = null;
  let last: MasonryLayout | null = null;
  let viewOf: Feed | null = null;

  const lay = () => {
    if (
      viewOf === null
      || viewOf.blocks !== feed.blocks
      || viewOf.parentWidth !== feed.parentWidth
      || viewOf.show !== feed.show
    ) {
      columns = rememberedColumns(memory, feed.blocks, ROUTE, feed.parentWidth, feed.show);
      referenceColumnOf = referenceColumns(reference, feed.blocks, feed.parentWidth, feed.show);
      viewOf = feed;
    }
    const layout = layFeedOut({
      blocks: feed.blocks,
      parentWidth: feed.parentWidth,
      layoutGap: feed.gap,
      show: feed.show,
      wordWidths: feed.wordWidths,
      columns,
      last,
    });
    const expected = referenceLayout(feed.blocks, feed.parentWidth, feed.wordWidths, feed.gap, feed.show, referenceColumnOf);
    const previous = last;
    const exact = feed.blocks.length > 0 && generationHasExactDeterministicHeights(feed.blocks, feed.wordWidths, feed.show);
    memory = { routeKey: ROUTE, parentWidth: feed.parentWidth, layoutGap: feed.gap, show: feed.show, blocks: feed.blocks, layout, exact };
    reference = referenceMemory(feed.blocks, expected, feed.parentWidth, feed.show, exact);
    last = layout;
    return { layout, expected, previous, columns: columns !== null };
  };

  return {
    feed: () => feed,
    change: (next: Partial<Feed>) => {
      feed = { ...feed, ...next };
      return lay();
    },
    lay,
  };
}

function expectSameLayout(layout: MasonryLayout, expected: MasonryLayout): void {
  expect(layout.columnCount).toBe(expected.columnCount);
  expect(layout.columnWidth).toBe(expected.columnWidth);
  expect(layout.totalHeight).toBe(expected.totalHeight);
  expect(layout.positions).toEqual(expected.positions);
}

function measured(blocks: readonly LightBlock[], variant = 0): Map<number, WordWidths> {
  return new Map(blocks.map((block) => [block.id, widthsOf(block, variant)]));
}

describe("the feed's layout against the feed laid out from the first card", () => {
  it("stands the same after a page is added, a card changes, widths arrive, a card leaves and the width changes", () => {
    const first = Array.from({ length: 60 }, (_, index) => card(index + 1));
    const driver = feedDriver({ blocks: first, wordWidths: measured(first), parentWidth: 1180, gap: 32, show: "cards" });
    const start = driver.lay();
    expectSameLayout(start.layout, start.expected);

    // A page arrives: its cards have no widths yet.
    const page = Array.from({ length: 20 }, (_, index) => card(61 + index));
    const grown = [...first, ...page];
    const arrived = driver.change({ blocks: grown });
    expect(arrived.columns).toBe(true);
    expectSameLayout(arrived.layout, arrived.expected);
    // The cards held before stand where they stood, as the objects they were.
    first.forEach((_, index) => expect(arrived.layout.positions[index]).toBe(start.layout.positions[index]));

    // The widths of the page's words arrive in two parts.
    const withFirstPart = new Map([...driver.feed().wordWidths, ...measured(page.slice(0, 8))]);
    const firstPart = driver.change({ wordWidths: withFirstPart });
    expectSameLayout(firstPart.layout, firstPart.expected);
    const withAll = new Map([...withFirstPart, ...measured(page.slice(8))]);
    const settled = driver.change({ wordWidths: withAll });
    expectSameLayout(settled.layout, settled.expected);
    first.forEach((_, index) => expect(settled.layout.positions[index]).toBe(start.layout.positions[index]));

    // A card in the middle arrives changed: another picture, another text.
    const changed = card(10, 1);
    const afterChange = driver.change({
      blocks: reconcileBlocks(grown, grown.map((block) => (block.id === 10 ? changed : structuredClone(block)))),
    });
    expect(afterChange.columns).toBe(true);
    expectSameLayout(afterChange.layout, afterChange.expected);

    // A card leaves the feed.
    const without = driver.feed().blocks.filter((block) => block.id !== 25);
    const afterLeave = driver.change({ blocks: without });
    expectSameLayout(afterLeave.layout, afterLeave.expected);

    // The feed gets narrower, then the presentation changes.
    const narrower = driver.change({ parentWidth: 1172 });
    expect(narrower.columns).toBe(false);
    expectSameLayout(narrower.layout, narrower.expected);
    const media = driver.change({ show: "media" });
    expectSameLayout(media.layout, media.expected);
  });

  it("shows a changed card at its new height, not at the height kept for the card it replaced", () => {
    const blocks = Array.from({ length: 24 }, (_, index) => card(index + 1));
    const driver = feedDriver({ blocks, wordWidths: measured(blocks), parentWidth: 1180, gap: 32, show: "cards" });
    const before = driver.lay().layout;

    // The fourth card is a picture; its preview arrives in another shape.
    const index = 3;
    const changed = card(blocks[index]!.id, 1);
    const next = reconcileBlocks(blocks, blocks.map((block, at) => (at === index ? changed : structuredClone(block))));
    expect(next[index]).toBe(changed);
    const after = driver.change({ blocks: next });

    const columnWidth = getMasonryColumnWidth(1180, FEED_COLUMN_MIN_WIDTH_PX, 32);
    const newHeight = computeCardHeight({ ...changed }, columnWidth, null, "cards");
    expect(newHeight).not.toBe(before.positions[index]!.height);
    expect(after.layout.positions[index]!.height).toBe(newHeight);
    expectSameLayout(after.layout, after.expected);
    // Only the cards under it in its column moved.
    const column = before.positions[index]!.column;
    after.layout.positions.forEach((position, at) => {
      if (position.column === column && at > index) {
        expect(position.top - before.positions[at]!.top).toBe(newHeight - before.positions[index]!.height);
      } else if (at !== index) {
        expect(position).toBe(before.positions[at]);
      }
    });
  });

  it("stands the same through random changes of the list, the widths, the width, the gap and the presentation", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const next = random(seed * 7919);
      const pick = (count: number) => Math.floor(next() * count);
      let nextId = 1;
      const fresh = (count: number) => Array.from({ length: count }, () => card(nextId++, pick(3)));
      const first = fresh(30 + pick(30));
      const driver = feedDriver({
        blocks: first,
        wordWidths: measured(first),
        parentWidth: 700 + pick(700),
        gap: 32,
        show: "cards",
      });
      const start = driver.lay();
      expectSameLayout(start.layout, start.expected);

      for (let step = 0; step < 60; step += 1) {
        const { blocks, wordWidths } = driver.feed();
        const kind = pick(12);
        let result;
        if (kind <= 2) {
          // A page arrives, with or without its widths.
          const page = fresh(1 + pick(12));
          const all = [...blocks, ...page];
          result = driver.change(next() < 0.5
            ? { blocks: all }
            : { blocks: all, wordWidths: new Map([...wordWidths, ...measured(page)]) });
        } else if (kind <= 5 && blocks.length > 0) {
          // The row of one card arrives changed; every other row is read again unchanged.
          const at = pick(blocks.length);
          const changed = card(blocks[at]!.id, 1 + pick(5));
          result = driver.change({
            blocks: reconcileBlocks(blocks, blocks.map((block, index) => (index === at ? changed : structuredClone(block)))),
          });
        } else if (kind === 6 && blocks.length > 1) {
          // Cards leave the feed.
          const from = pick(blocks.length);
          const gone = 1 + pick(3);
          result = driver.change({ blocks: blocks.filter((_, index) => index < from || index >= from + gone) });
        } else if (kind === 7 && blocks.length > 2) {
          // A card changes places.
          const moved = [...blocks];
          const [taken] = moved.splice(pick(moved.length), 1);
          moved.splice(pick(moved.length), 0, taken!);
          result = driver.change({ blocks: moved });
        } else if (kind === 8) {
          // The widths of the words still waited for arrive, measured anew for some.
          const all = new Map(wordWidths);
          for (const block of blocks) {
            if (!all.has(block.id) || next() < 0.05) all.set(block.id, widthsOf(block, pick(3)));
          }
          result = driver.change({ wordWidths: all });
        } else if (kind === 9) {
          result = driver.change({ parentWidth: 500 + pick(1000) + (next() < 0.3 ? 0.4 : 0) });
        } else if (kind === 10) {
          result = driver.change(next() < 0.5 ? { gap: [8, 16, 24, 32][pick(4)]! } : { show: (["cards", "media", "media-only"] as const)[pick(3)]! });
        } else {
          // Nothing changed: the layout is made again as it is.
          result = driver.lay();
          expect(result.layout.positions).toBe(result.previous!.positions);
          expect(result.layout).not.toBe(result.previous);
        }
        expectSameLayout(result.layout, result.expected);
        // A card that came out where it stood keeps its position object.
        if (result.previous !== null) {
          const previous = result.previous;
          result.layout.positions.forEach((position, index) => {
            const was = previous.positions[index];
            if (was !== undefined && was.top === position.top && was.left === position.left
              && was.width === position.width && was.height === position.height && was.column === position.column) {
              expect(position).toBe(was);
            }
          });
        }
      }
    }
  });
});

describe("the columns a layout remembers", () => {
  const blocks = Array.from({ length: 12 }, (_, index) => card(index + 1));
  const wordWidths = measured(blocks);
  const layout = layFeedOut({ blocks, parentWidth: 1180, layoutGap: 32, show: "cards", wordWidths, columns: null, last: null });
  const memory: ColumnMemory = { routeKey: ROUTE, parentWidth: 1180, layoutGap: 32, show: "cards", blocks, layout, exact: true };

  it("are those of the layout for a list that grew at its end", () => {
    const grown = [...blocks, card(13), card(14)];
    const columns = rememberedColumns(memory, grown, ROUTE, 1180, "cards")!;
    expect(columns.aligned).toBe(blocks.length);
    blocks.forEach((_, index) => {
      expect(columns.columnOf(index)).toBe(layout.positions[index]!.column);
      expect(columns.positionOf(index)).toBe(layout.positions[index]);
      expect(rememberedPositionAt(memory, columns, grown, index)).toBe(layout.positions[index]);
    });
    expect(columns.columnOf(12)).toBeUndefined();
    expect(rememberedPositionAt(memory, columns, grown, 13)).toBeUndefined();
  });

  it("follow a card by its slug once cards left the list", () => {
    const without = blocks.filter((_, index) => index !== 2 && index !== 5);
    const columns = rememberedColumns(memory, without, ROUTE, 1180, "cards")!;
    expect(columns.aligned).toBe(2);
    without.forEach((block, index) => {
      const stood = layout.positions[blocks.indexOf(block)]!;
      expect(columns.columnOf(index)).toBe(stood.column);
      expect(rememberedPosition(memory, block.slug, index)).toBe(stood);
      expect(rememberedPositionAt(memory, null, without, index)).toBe(stood);
    });
    expect(rememberedPosition(memory, "not-a-card", 0)).toBeUndefined();
  });

  it("are dropped when the cards that remain changed their order, the route, the width or the presentation", () => {
    const swapped = [blocks[1]!, blocks[0]!, ...blocks.slice(2)];
    expect(rememberedColumns(memory, swapped, ROUTE, 1180, "cards")).toBeNull();
    expect(rememberedColumns(memory, blocks, "another", 1180, "cards")).toBeNull();
    expect(rememberedColumns(memory, blocks, ROUTE, 1181, "cards")).toBeNull();
    expect(rememberedColumns(memory, blocks, ROUTE, 1180, "media")).toBeNull();
    expect(rememberedColumns({ ...memory, exact: false }, blocks, ROUTE, 1180, "cards")).toBeNull();
    expect(rememberedColumns(null, blocks, ROUTE, 1180, "cards")).toBeNull();
    // Within half a pixel the width is the same view.
    expect(rememberedColumns(memory, blocks, ROUTE, 1180.4, "cards")).not.toBeNull();
  });

  it("tell a layout that kept every card's column from one that did not", () => {
    const columns = rememberedColumns(memory, blocks, ROUTE, 1180, "cards");
    expect(columnsKept(memory, columns, blocks, layout)).toBe(true);
    const moved = {
      ...layout,
      positions: layout.positions.map((position, index) => (index === 3 ? { ...position, column: (position.column + 1) % layout.columnCount } : position)),
    };
    expect(columnsKept(memory, columns, blocks, moved)).toBe(false);
    expect(columnsKept(memory, null, blocks, moved)).toBe(false);
  });
});

describe("everyHeightIsExact", () => {
  it("answers as generationHasExactDeterministicHeights does", () => {
    const blocks = Array.from({ length: 16 }, (_, index) => card(index + 1));
    const all = measured(blocks);
    for (const show of ["cards", "media", "media-only"] as const) {
      expect(everyHeightIsExact(blocks, all, show)).toBe(true);
      expect(everyHeightIsExact(blocks, new Map(), show)).toBe(generationHasExactDeterministicHeights(blocks, new Map(), show));
      for (const block of blocks) {
        const without = new Map(all);
        without.delete(block.id);
        expect(everyHeightIsExact(blocks, without, show)).toBe(generationHasExactDeterministicHeights(blocks, without, show));
      }
    }
    expect(everyHeightIsExact([], new Map(), "cards")).toBe(true);
  });
});
