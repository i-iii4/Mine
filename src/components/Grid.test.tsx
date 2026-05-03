// Grid integration test — reproduces the "cards collapse after save / on
// channel revisit" bug described in the debugging session of 2026-04-13.
//
// Methodology: drive the real <Grid> component in jsdom, mock only the
// layout-observation primitives (ResizeObserver, getBoundingClientRect),
// let the full state machine (heightsMap, heightsReady, allHeightsPresent,
// layoutCache) run as it does in production.
//
// Success criterion: after adding a new block to the blocks prop, every
// rendered card's position must have height > 0, and no two cards in the
// same column may have top coordinates that overlap.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { Grid } from "./Grid";
import { computeMasonryLayout } from "@/lib/masonryLayout";
import type { LightBlock } from "@/types";

// These constants must match the ones in Grid.tsx. If Grid.tsx changes
// them, this test must be updated in lockstep — but since the test's
// entire purpose is to verify Grid produces positions consistent with
// a fresh buildLayout, the values must match.
const TEST_COLUMN_MIN_WIDTH = 220;
const TEST_GAP = 32;

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id,
    slug: `block-${id}`,
    block_type: "article",
    title: `Block ${id}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `Body text for block ${id}`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    tags: ["test"],
    ...overrides,
  };
}

function makeVideoBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return makeBlock(id, {
    block_type: "video",
    media_file: `clip-${id}.mp4`,
    preview_manifest: JSON.stringify({
      kind: "video_poster",
      primary_preview_path: `block-${id}.jpg`,
      width: 1280,
      height: 720,
      tiles: [
        {
          source_path: `clip-${id}.mp4`,
          preview_path: `block-${id}.jpg`,
          width: 1280,
          height: 720,
          is_video: true,
          is_video_poster: true,
        },
      ],
      overflow_count: 0,
    }),
    feed_playback: JSON.stringify({
      kind: "single_video",
      source_path: `clip-${id}.mp4`,
      poster_preview_path: `block-${id}.jpg`,
      width: 1280,
      height: 720,
      container: "mp4",
      profile: "standard",
    }),
    ...overrides,
  });
}

function makeHeavyVideoBlock(
  id: number,
  overrides: Partial<LightBlock> = {},
): LightBlock {
  const block = makeVideoBlock(id, overrides);
  const playback = JSON.parse(block.feed_playback ?? "{}") as Record<string, unknown>;
  block.feed_playback = JSON.stringify({
    ...playback,
    profile: "heavy",
  });
  return block;
}

function makeArticleVideoBlock(
  id: number,
  overrides: Partial<LightBlock> = {},
): LightBlock {
  return makeBlock(id, {
    title: `Article video ${id}`,
    body: "Video preview text that continues below the media surface.",
    first_image: `clip-${id}.mp4`,
    media_urls: JSON.stringify([`clip-${id}.mp4`]),
    preview_manifest: JSON.stringify({
      kind: "video_poster",
      primary_preview_path: `block-${id}.jpg`,
      width: 1144,
      height: 720,
      tiles: [
        {
          source_path: `clip-${id}.mp4`,
          preview_path: `clip-${id}.jpg`,
          width: 1144,
          height: 720,
          is_video: true,
          is_video_poster: false,
        },
      ],
      overflow_count: 0,
    }),
    feed_playback: JSON.stringify({
      kind: "single_video",
      source_path: `clip-${id}.mp4`,
      poster_preview_path: `block-${id}.jpg`,
      width: 1144,
      height: 720,
      container: "mp4",
      profile: "standard",
    }),
    ...overrides,
  });
}

// Deterministic per-block heights. Keyed by block id so that add/remove
// operations stay stable across rerenders.
const BLOCK_HEIGHTS = new Map<number, number>();
const BLOCK_HEIGHTS_BY_COLUMN_WIDTH = new Map<string, number>();

function setBlockHeight(id: number, height: number): void {
  BLOCK_HEIGHTS.set(id, height);
}

function resolveBlockHeight(id: number, columnWidth?: number): number {
  if (columnWidth !== undefined && Number.isFinite(columnWidth)) {
    const byWidth = BLOCK_HEIGHTS_BY_COLUMN_WIDTH.get(
      `${id}:${Math.round(columnWidth)}`,
    );
    if (byWidth !== undefined) return byWidth;
  }
  return BLOCK_HEIGHTS.get(id) ?? 200;
}

function testColumnWidth(parentWidth: number): number {
  const provisionalColumnCount = Math.max(
    1,
    Math.floor((parentWidth + TEST_GAP) / (TEST_COLUMN_MIN_WIDTH + TEST_GAP)),
  );
  return Math.max(
    1,
    (Math.max(0, parentWidth - TEST_GAP * (provisionalColumnCount - 1))) /
      provisionalColumnCount,
  );
}

function setBlockHeightAtParentWidth(
  id: number,
  parentWidth: number,
  height: number,
): void {
  BLOCK_HEIGHTS_BY_COLUMN_WIDTH.set(
    `${id}:${Math.round(testColumnWidth(parentWidth))}`,
    height,
  );
}

// ─── Environment mocks ─────────────────────────────────────────────────────

// Mock ResizeObserver so Grid's useEffect reports a non-zero parentWidth.
// jsdom has no layout engine, so clientWidth is 0 — we fire the observer
// callback synchronously with a fake contentRect.
let mockViewport = { width: 1200, height: 800 };
const resizeObservers = new Set<MockResizeObserver>();

class MockResizeObserver {
  private cb: ResizeObserverCallback;
  private el: Element | null = null;

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }

  emit(): void {
    if (!this.el) return;
    const entry = {
      target: this.el,
      contentRect: {
        width: mockViewport.width,
        height: mockViewport.height,
        top: 0,
        left: 0,
        right: mockViewport.width,
        bottom: mockViewport.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    this.cb([entry], this as unknown as ResizeObserver);
  }

  observe(el: Element): void {
    this.el = el;
    resizeObservers.add(this);
    this.emit();
  }
  unobserve(): void {
    resizeObservers.delete(this);
    this.el = null;
  }
  disconnect(): void {
    resizeObservers.delete(this);
    this.el = null;
  }
}

function triggerResize(width: number, height: number = 800): void {
  mockViewport = { width, height };
  for (const observer of resizeObservers) {
    observer.emit();
  }
}

// Mock getBoundingClientRect on Elements: when called on a MeasureCard
// wrapper (identified by data-measure-id), return the fake height for that
// block. Other calls fall back to a zero rect (jsdom default).
const originalGetBCR = Element.prototype.getBoundingClientRect;
function mockGetBoundingClientRect(): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const idAttr = this.getAttribute("data-measure-id");
    if (idAttr !== null) {
      const id = Number(idAttr);
      const width = parseFloat((this as HTMLElement).style.width || "0");
      const height = resolveBlockHeight(id, width);
      return {
        width: 240,
        height,
        top: 0,
        left: 0,
        right: 240,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

// ─── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  BLOCK_HEIGHTS.clear();
  BLOCK_HEIGHTS_BY_COLUMN_WIDTH.clear();
  mockViewport = { width: 1200, height: 800 };
  resizeObservers.clear();
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  mockGetBoundingClientRect();
  // jsdom does not implement Element.scrollTo — stub it out.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBCR;
  vi.useRealTimers();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

interface RenderedPosition {
  slug: string;
  left: number;
  top: number;
  height: number;
}

/**
 * Read the currently-rendered visible cards and their absolute positions
 * from the DOM. Grid uses inline `transform: translate3d(left, top, 0)`
 * and inline `width` on the wrapper of each visible card.
 */
function readRenderedPositions(): RenderedPosition[] {
  const cards = Array.from(
    document.querySelectorAll("[data-block-slug]"),
  ) as HTMLElement[];
  return cards.map((card) => {
    const wrapper = card.parentElement as HTMLElement;
    const transform = wrapper.style.transform || "";
    const match = transform.match(
      /translate3d\(\s*([^,]+)px\s*,\s*([^,]+)px\s*,/,
    );
    const slug = card.getAttribute("data-block-slug") ?? "?";
    // We do not have a reliable way to read the computed height back from
    // the DOM because Grid intentionally does not set a height on the
    // wrapper. Instead, we look up by slug via BLOCK_HEIGHTS so the test
    // can reason about collision-free packing.
    const idMatch = slug.match(/^block-(\d+)$/);
    const id = idMatch ? Number(idMatch[1]) : -1;
    const height = resolveBlockHeight(id);
    return {
      slug,
      left: match ? parseFloat(match[1]!) : NaN,
      top: match ? parseFloat(match[2]!) : NaN,
      height,
    };
  });
}

/**
 * Wait for all pending microtasks, timers, and RAF callbacks to drain.
 * Drives the measurement pass (which awaits fonts and images) and any
 * follow-up React rerenders to completion.
 */
async function flushAsync(): Promise<void> {
  // Run any microtasks (warmFromIndexedDb resolves here).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // MeasurementPass's 2s per-image timeout guard — advance all timers.
  await act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
  });
  // Let any follow-up effects (scroll-tick, visibility index) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const BASE_PROPS = {
  vaultPath: "/tmp/vault",
  tags: [],
  scrollToTop: 0,
  onBlockClick: vi.fn(),
  onToggleTag: vi.fn(),
  onCreateAndAssign: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Grid — no collapse after add / revisit", () => {
  it("renders initial blocks with non-colliding positions", async () => {
    vi.useFakeTimers();

    const initialBlocks = [
      makeBlock(1),
      makeBlock(2),
      makeBlock(3),
      makeBlock(4),
    ];
    setBlockHeight(1, 200);
    setBlockHeight(2, 300);
    setBlockHeight(3, 250);
    setBlockHeight(4, 180);

    render(<Grid {...BASE_PROPS} blocks={initialBlocks} />);
    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions.length).toBe(4);

    // Sanity: every card has a parsed left/top.
    for (const p of positions) {
      expect(Number.isFinite(p.left)).toBe(true);
      expect(Number.isFinite(p.top)).toBe(true);
    }

    assertPositionsMatchFreshLayout(initialBlocks, positions, 1200);
  });

  it("keeps the top feed inset inside the scroll content, not on the scrollport", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(8001), makeBlock(8002)];
    setBlockHeight(8001, 200);
    setBlockHeight(8002, 220);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="top-inset" />);
    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    const layoutEl = document.querySelector("[data-grid-layout]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();
    expect(layoutEl).toBeTruthy();
    expect(scrollEl).not.toHaveClass("pt-20");
    expect(layoutEl?.style.marginTop).toBe("80px");
  });

  it("keeps the first paint skeleton-only until the current generation is measured", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(901), makeBlock(902), makeBlock(903), makeBlock(904)];
    setBlockHeight(901, 200);
    setBlockHeight(902, 300);
    setBlockHeight(903, 250);
    setBlockHeight(904, 180);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="fresh-skeleton" />);

    expect(readRenderedPositions()).toHaveLength(0);

    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions).toHaveLength(4);
    assertPositionsMatchFreshLayout(blocks, positions, 1200);
  });

  it("after adding a new block, no cards collapse (the save-new-card bug)", async () => {
    vi.useFakeTimers();

    const initialBlocks = [
      makeBlock(1),
      makeBlock(2),
      makeBlock(3),
      makeBlock(4),
    ];
    setBlockHeight(1, 200);
    setBlockHeight(2, 300);
    setBlockHeight(3, 250);
    setBlockHeight(4, 180);

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initialBlocks} />,
    );
    await flushAsync();

    // Simulate a clipper save: new block id=5 added to the channel at
    // the FRONT of the array (newest-first sort, as listBlocks() returns).
    // Placing it at the front means its (possibly stale/fallback) height
    // affects every subsequent block's column placement — which is what
    // makes the stale-layout bug visible.
    setBlockHeight(5, 220);
    const afterSave = [makeBlock(5), ...initialBlocks];
    rerender(<Grid {...BASE_PROPS} blocks={afterSave} />);
    await flushAsync();

    const positions = readRenderedPositions();

    expect(positions.map((p) => p.slug).sort()).toEqual([
      "block-1",
      "block-2",
      "block-3",
      "block-4",
      "block-5",
    ]);

    assertPositionsMatchFreshLayout(afterSave, positions, 1200);
  });

  it("unmount before measurement completes → remount reuses clean state", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(200),
      makeBlock(201),
      makeBlock(202),
      makeBlock(203),
      makeBlock(204),
      makeBlock(205),
    ];
    setBlockHeight(200, 150);
    setBlockHeight(201, 280);
    setBlockHeight(202, 210);
    setBlockHeight(203, 370);
    setBlockHeight(204, 190);
    setBlockHeight(205, 240);

    // Mount and IMMEDIATELY unmount, without flushing — measurement pass
    // is in flight at unmount time. Handler may fire onto an unmounted
    // component; its side-effects on module-level memoryCache persist.
    const first = render(
      <Grid {...BASE_PROPS} blocks={blocks} currentTag="alpha" />,
    );
    // Minimal flush: microtasks only, no timers. Gives React a chance to
    // run effects but NOT to complete the measurement pass.
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    // Now remount. Depending on what in-flight state leaked into the
    // module-level cache, this mount may or may not build a correct
    // layout.
    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="alpha" />);
    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions.length).toBe(6);
    assertPositionsMatchFreshLayout(blocks, positions, 1200);
  });

  it("rapid blocks prop thrashing does not corrupt layout", async () => {
    vi.useFakeTimers();

    const blocksA = [makeBlock(300), makeBlock(301), makeBlock(302)];
    const blocksB = [makeBlock(310), makeBlock(311), makeBlock(312), makeBlock(313)];
    setBlockHeight(300, 200);
    setBlockHeight(301, 300);
    setBlockHeight(302, 150);
    setBlockHeight(310, 180);
    setBlockHeight(311, 220);
    setBlockHeight(312, 400);
    setBlockHeight(313, 170);

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={blocksA} currentTag="alpha" />,
    );
    // Barely any flush — measurement is in flight.
    await act(async () => {
      await Promise.resolve();
    });

    // Thrash: flip back and forth while measurement is still pending.
    rerender(<Grid {...BASE_PROPS} blocks={blocksB} currentTag="beta" />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<Grid {...BASE_PROPS} blocks={blocksA} currentTag="alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    rerender(<Grid {...BASE_PROPS} blocks={blocksB} currentTag="beta" />);
    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions.length).toBe(4);
    assertPositionsMatchFreshLayout(blocksB, positions, 1200);
  });

  it("after unmount+remount (simulates leave+revisit), layout from layoutCache stays valid", async () => {
    vi.useFakeTimers();

    const blocksA = [
      makeBlock(100),
      makeBlock(101),
      makeBlock(102),
      makeBlock(103),
      makeBlock(104),
      makeBlock(105),
      makeBlock(106),
      makeBlock(107),
    ];
    setBlockHeight(100, 210);
    setBlockHeight(101, 340);
    setBlockHeight(102, 180);
    setBlockHeight(103, 260);
    setBlockHeight(104, 290);
    setBlockHeight(105, 150);
    setBlockHeight(106, 400);
    setBlockHeight(107, 230);

    // ── First visit ────────────────────────────────────────────────────
    const first = render(
      <Grid {...BASE_PROPS} blocks={blocksA} currentTag="alpha" />,
    );
    await flushAsync();

    const positionsFirst = readRenderedPositions();
    expect(positionsFirst.length).toBe(8);
    assertPositionsMatchFreshLayout(blocksA, positionsFirst, 1200);

    // ── Leave ──────────────────────────────────────────────────────────
    first.unmount();

    // ── Revisit ────────────────────────────────────────────────────────
    // Fresh mount with the SAME blocks content. Module-level layoutCache
    // and memoryCache still hold entries from the first visit. This is
    // exactly the state after navigating away and back (Grid unmounts on
    // "/" ↔ "/channel/X" transitions because AllBlocksPage and ChannelPage
    // are different Route elements).
    render(<Grid {...BASE_PROPS} blocks={blocksA} currentTag="alpha" />);
    await flushAsync();

    const positionsSecond = readRenderedPositions();
    expect(positionsSecond.length).toBe(8);
    assertPositionsMatchFreshLayout(blocksA, positionsSecond, 1200);

    // Extra invariant: positions must be BIT-EQUAL between visits, since
    // the same blocks + same heights must produce the same layout.
    const byIdFirst = new Map(
      positionsFirst.map((p) => [p.slug, { left: p.left, top: p.top }]),
    );
    for (const p of positionsSecond) {
      const prev = byIdFirst.get(p.slug);
      if (!prev) continue;
      if (Math.abs(p.left - prev.left) > 0.5 || Math.abs(p.top - prev.top) > 0.5) {
        throw new Error(
          `Revisit position drift for ${p.slug}: first (${prev.left}, ${prev.top}), ` +
            `second (${p.left}, ${p.top})`,
        );
      }
    }
  });

  it("after channel revisit (blocks identity changes, content same), layout stays valid", async () => {
    vi.useFakeTimers();

    const visitA = [
      makeBlock(1),
      makeBlock(2),
      makeBlock(3),
      makeBlock(4),
    ];
    setBlockHeight(1, 200);
    setBlockHeight(2, 300);
    setBlockHeight(3, 250);
    setBlockHeight(4, 180);

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={visitA} currentTag="alpha" />,
    );
    await flushAsync();

    // Go to channel B with different blocks.
    const visitB = [makeBlock(10), makeBlock(11)];
    setBlockHeight(10, 150);
    setBlockHeight(11, 220);
    rerender(<Grid {...BASE_PROPS} blocks={visitB} currentTag="beta" />);
    await flushAsync();

    // Return to channel A — new array identity, same ids, same content.
    const visitAAgain = [
      makeBlock(1),
      makeBlock(2),
      makeBlock(3),
      makeBlock(4),
    ];
    rerender(
      <Grid {...BASE_PROPS} blocks={visitAAgain} currentTag="alpha" />,
    );
    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions.length).toBe(4);
    assertPositionsMatchFreshLayout(visitAAgain, positions, 1200);
  });

  it("re-measures when layout-relevant text changes at the same block ids", async () => {
    vi.useFakeTimers();

    const initial = [
      makeBlock(911, { title: "One", body: "Body one" }),
      makeBlock(912, { title: "Two", body: "Body two" }),
      makeBlock(913, { title: "Three", body: "Body three" }),
    ];
    setBlockHeight(911, 180);
    setBlockHeight(912, 220);
    setBlockHeight(913, 260);

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="layout-text-change" />,
    );
    await flushAsync();

    setBlockHeight(911, 320);
    setBlockHeight(912, 180);
    setBlockHeight(913, 290);
    const updated = [
      makeBlock(911, { title: "One updated", body: "Body one updated" }),
      makeBlock(912, { title: "Two updated", body: "Body two updated" }),
      makeBlock(913, { title: "Three updated", body: "Body three updated" }),
    ];
    rerender(<Grid {...BASE_PROPS} blocks={updated} currentTag="layout-text-change" />);
    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions.length).toBe(3);
    assertPositionsMatchFreshLayout(updated, positions, 1200);
  });

  it("re-measures when preview manifest changes at the same block ids", async () => {
    vi.useFakeTimers();

    const initial = [
      makeBlock(921, {
        preview_manifest: JSON.stringify({
          kind: "image",
          primary_preview_path: "block-1.jpg",
          width: 480,
          height: 320,
          tiles: [],
          overflow_count: 0,
        }),
      }),
      makeBlock(922),
      makeBlock(923),
    ];
    setBlockHeight(921, 200);
    setBlockHeight(922, 220);
    setBlockHeight(923, 260);

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="layout-preview-change" />,
    );
    await flushAsync();

    setBlockHeight(921, 360);
    const updated = [
      makeBlock(921, {
        preview_manifest: JSON.stringify({
          kind: "composite",
          primary_preview_path: "block-1.jpg",
          width: 480,
          height: 480,
          tiles: [
            { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
            { source_path: "b.jpg", preview_path: "b.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
          ],
          overflow_count: 0,
        }),
      }),
      makeBlock(922),
      makeBlock(923),
    ];
    rerender(<Grid {...BASE_PROPS} blocks={updated} currentTag="layout-preview-change" />);
    await flushAsync();

    const positions = readRenderedPositions();
    expect(positions.length).toBe(3);
    assertPositionsMatchFreshLayout(updated, positions, 1200);
  });

  it("switches to skeleton-only while a new resize generation is measuring", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(400),
      makeBlock(401),
      makeBlock(402),
      makeBlock(403),
    ];
    const wideParentWidth = 1200;
    const narrowParentWidth = 720;

    setBlockHeightAtParentWidth(400, wideParentWidth, 180);
    setBlockHeightAtParentWidth(401, wideParentWidth, 260);
    setBlockHeightAtParentWidth(402, wideParentWidth, 220);
    setBlockHeightAtParentWidth(403, wideParentWidth, 300);

    setBlockHeightAtParentWidth(400, narrowParentWidth, 260);
    setBlockHeightAtParentWidth(401, narrowParentWidth, 360);
    setBlockHeightAtParentWidth(402, narrowParentWidth, 280);
    setBlockHeightAtParentWidth(403, narrowParentWidth, 410);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="alpha" />);
    await flushAsync();

    const widePositions = readRenderedPositions();
    assertPositionsMatchExplicitLayout(
      blocks,
      widePositions,
      wideParentWidth,
      [180, 260, 220, 300],
    );

    act(() => {
      triggerResize(narrowParentWidth);
    });

    expect(readRenderedPositions()).toHaveLength(0);

    await flushAsync();

    const narrowPositions = readRenderedPositions();
    assertPositionsMatchExplicitLayout(
      blocks,
      narrowPositions,
      narrowParentWidth,
      [260, 360, 280, 410],
    );
  });

  it("autoplays all sufficiently visible standard feed videos", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeVideoBlock(1001),
      makeVideoBlock(1002),
      makeVideoBlock(1003),
    ];
    setBlockHeight(1001, 300);
    setBlockHeight(1002, 300);
    setBlockHeight(1003, 300);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="video-feed" />);

    act(() => {
      triggerResize(280, 800);
    });

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(0);

    await flushAsync();

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(3);
    expect(document.querySelector("[data-block-slug='block-1001'] [data-feed-video-surface='true']")).toBeTruthy();
    expect(document.querySelector("[data-block-slug='block-1002'] [data-feed-video-surface='true']")).toBeTruthy();
    expect(document.querySelector("[data-block-slug='block-1003'] [data-feed-video-surface='true']")).toBeTruthy();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();

    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 500;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });

    await flushAsync();

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(2);
    expect(document.querySelector("[data-block-slug='block-1001'] [data-feed-video-surface='true']")).toBeFalsy();
    expect(document.querySelector("[data-block-slug='block-1002'] [data-feed-video-surface='true']")).toBeTruthy();
    expect(document.querySelector("[data-block-slug='block-1003'] [data-feed-video-surface='true']")).toBeTruthy();
  });

  it("prewarms standard feed video before the card enters the visible viewport", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(1400),
      makeVideoBlock(1401),
    ];
    setBlockHeight(1400, 420);
    setBlockHeight(1401, 300);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="video-prewarm" />);

    act(() => {
      triggerResize(280, 400);
    });

    await flushAsync();

    const positions = readRenderedPositions();
    const videoCard = positions.find((pos) => pos.slug === "block-1401");
    expect(videoCard).toBeTruthy();
    expect(videoCard!.top).toBeGreaterThan(400);
    expect(
      document.querySelector(
        "[data-block-slug='block-1401'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
  });

  it("keeps standard feed video playing until it leaves the expanded autoplay window", async () => {
    vi.useFakeTimers();

    const blocks = [makeVideoBlock(1501)];
    setBlockHeight(1501, 300);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="video-linger" />);

    act(() => {
      triggerResize(280, 400);
    });

    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1501'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();

    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 170;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });

    await flushAsync();

    expect(
      document.querySelector(
        "[data-block-slug='block-1501'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();

    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 340;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });

    await flushAsync();

    expect(
      document.querySelector(
        "[data-block-slug='block-1501'] [data-feed-video-surface='true']",
      ),
    ).toBeFalsy();
  });

  it("prefers an in-viewport heavy clip over an off-screen lingering heavy clip", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeHeavyVideoBlock(1601),
      makeHeavyVideoBlock(1602),
    ];
    setBlockHeight(1601, 300);
    setBlockHeight(1602, 300);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="video-heavy-priority" />);

    act(() => {
      triggerResize(280, 400);
    });

    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();

    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 180;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });

    await flushAsync();

    expect(
      document.querySelector(
        "[data-block-slug='block-1601'] [data-feed-video-surface='true']",
      ),
    ).toBeFalsy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1602'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
  });

  it("keeps only the top-most heavy video active when multiple heavy cards compete", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeHeavyVideoBlock(1201),
      makeHeavyVideoBlock(1202),
      makeHeavyVideoBlock(1203),
    ];
    setBlockHeight(1201, 300);
    setBlockHeight(1202, 300);
    setBlockHeight(1203, 300);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="video-tie-break" />);

    act(() => {
      triggerResize(280, 800);
    });

    await flushAsync();

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(1);
    expect(
      document.querySelector(
        "[data-block-slug='block-1201'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1202'] [data-feed-video-surface='true']",
      ),
    ).toBeFalsy();
  });

  it("allows one heavy video alongside visible standard videos", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeVideoBlock(1301),
      makeHeavyVideoBlock(1302),
      makeHeavyVideoBlock(1303),
    ];
    setBlockHeight(1301, 300);
    setBlockHeight(1302, 300);
    setBlockHeight(1303, 300);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="mixed-video-policy" />);

    act(() => {
      triggerResize(280, 800);
    });

    await flushAsync();

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(2);
    expect(
      document.querySelector(
        "[data-block-slug='block-1301'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1302'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1303'] [data-feed-video-surface='true']",
      ),
    ).toBeFalsy();
  });

  it("uses visible playback surface, not full card height, for tall article-video cards", async () => {
    vi.useFakeTimers();

    const blocks = [makeArticleVideoBlock(1101)];
    setBlockHeight(1101, 450);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="video-surface" />);

    act(() => {
      triggerResize(280, 180);
    });

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(0);

    await flushAsync();

    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(1);
    expect(
      document.querySelector(
        "[data-block-slug='block-1101'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
  });
});

// ─── Assertion helpers ─────────────────────────────────────────────────────

/**
 * Assert that the rendered positions match what a fresh masonry layout
 * computation with the CURRENT block heights would produce. Any divergence
 * means Grid is serving a stale layout — which is exactly the "glued cards"
 * bug when fallback heights were used to build the cached layout and the
 * real heights (larger) cause visual overlap on screen.
 */
function assertPositionsMatchFreshLayout(
  blocks: LightBlock[],
  rendered: RenderedPosition[],
  parentWidth: number,
): void {
  const heights = blocks.map((b) => BLOCK_HEIGHTS.get(b.id) ?? 200);
  assertPositionsMatchExplicitLayout(blocks, rendered, parentWidth, heights);
}

function assertPositionsMatchExplicitLayout(
  blocks: LightBlock[],
  rendered: RenderedPosition[],
  parentWidth: number,
  heights: number[],
): void {
  const expectedLayout = computeMasonryLayout(
    heights,
    parentWidth,
    TEST_COLUMN_MIN_WIDTH,
    TEST_GAP,
  );

  // Index expected positions by block slug for order-independent comparison.
  const expectedBySlug = new Map<string, { left: number; top: number }>();
  blocks.forEach((b, i) => {
    const pos = expectedLayout.positions[i]!;
    expectedBySlug.set(b.slug, { left: pos.left, top: pos.top });
  });

  for (const r of rendered) {
    const exp = expectedBySlug.get(r.slug);
    if (!exp) {
      throw new Error(`Unexpected rendered slug: ${r.slug}`);
    }
    if (Math.abs(r.left - exp.left) > 0.5 || Math.abs(r.top - exp.top) > 0.5) {
      throw new Error(
        `Stale layout for ${r.slug}: rendered at (${r.left}, ${r.top}) ` +
          `but a fresh computation with current heights gives (${exp.left}, ${exp.top}). ` +
          `This is the "collapsed cards" bug — the cached layout was built ` +
          `with wrong heights. Rendered: ${JSON.stringify(rendered)}`,
      );
    }
  }
}
