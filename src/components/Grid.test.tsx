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
const TEST_COLUMN_MIN_WIDTH = 240;
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
    tags: ["test"],
    ...overrides,
  };
}

// Deterministic per-block heights. Keyed by block id so that add/remove
// operations stay stable across rerenders.
const BLOCK_HEIGHTS = new Map<number, number>();

function setBlockHeight(id: number, height: number): void {
  BLOCK_HEIGHTS.set(id, height);
}

// ─── Environment mocks ─────────────────────────────────────────────────────

// Mock ResizeObserver so Grid's useEffect reports a non-zero parentWidth.
// jsdom has no layout engine, so clientWidth is 0 — we fire the observer
// callback synchronously with a fake contentRect.
class MockResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element): void {
    const entry = {
      target: el,
      contentRect: {
        width: 1200,
        height: 800,
        top: 0,
        left: 0,
        right: 1200,
        bottom: 800,
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
  unobserve(): void {}
  disconnect(): void {}
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
      const height = BLOCK_HEIGHTS.get(id) ?? 200;
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
    const height = BLOCK_HEIGHTS.get(id) ?? 0;
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
  onCreateChannelFromTag: vi.fn(),
  onDeleteBlock: vi.fn(),
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
