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
import { render, act, fireEvent, screen, within } from "@testing-library/react";
import {
  Grid,
  selectActiveHeavyPlaybackSlugs,
  FEED_HEAVY_MAX_ACTIVE,
  FEED_HEAVY_HYSTERESIS_FRACTION,
  type HeavyPlaybackCandidate,
} from "./Grid";
import { TOP_FADE_HEIGHT } from "@/lib/edgeFade";
import { computeMasonryLayout } from "@/lib/masonryLayout";
import { computeCardHeight } from "@/lib/cardHeight";
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

function makeImageBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return makeBlock(id, {
    block_type: "image",
    card_kind: "media",
    media_file: `image-${id}.jpg`,
    width: 1000,
    height: 1000,
    preview_manifest: JSON.stringify({
      kind: "image",
      primary_preview_path: `image-${id}.jpg`,
      width: 1000,
      height: 1000,
      tiles: [
        {
          source_path: `image-${id}.jpg`,
          preview_path: `image-${id}.jpg`,
          width: 1000,
          height: 1000,
          is_video: false,
          is_video_poster: false,
        },
      ],
      overflow_count: 0,
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
    Math.floor(
      (Math.max(0, parentWidth - TEST_GAP * (provisionalColumnCount - 1))) /
        provisionalColumnCount,
    ),
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
 * and inline `width` on the GridItem wrapper around each visible card.
 */
function readRenderedPositions(): RenderedPosition[] {
  const cards = Array.from(
    document.querySelectorAll("[data-block-slug]"),
  ) as HTMLElement[];
  return cards.map((card) => {
    const wrapper = card.closest("[data-feed-grid-item]") as HTMLElement;
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
    const height = parseFloat(wrapper.style.height || "0") || resolveBlockHeight(id);
    return {
      slug,
      left: match ? parseFloat(match[1]!) : NaN,
      top: match ? parseFloat(match[2]!) : NaN,
      height,
    };
  });
}

function gridItemForSlug(slug: string): HTMLElement | null {
  const card = document.querySelector(`[data-block-slug="${slug}"]`);
  if (!card) return null;
  return card.closest("[data-feed-grid-item]") as HTMLElement | null;
}

/**
 * Wait for all pending microtasks, timers, and RAF callbacks to drain.
 * Drives the measurement pass (which awaits fonts) and any follow-up React
 * rerenders to completion.
 */
async function flushAsync(): Promise<void> {
  // Run any microtasks scheduled by React effects.
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
  // Let any follow-up effects (scroll-tick, visibility index) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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
  onLoadBlockTags: vi.fn(async (slugs: string[]) => (
    new Map(slugs.map((slug) => [slug, ["test"]]))
  )),
  onBatchSetTag: vi.fn(),
  onCreateAndAssignBatch: vi.fn(),
  onDeleteSelectedBlocks: vi.fn(),
  onMergeSelectedBlocks: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Grid — no collapse after add / revisit", () => {
  it("renders a centered italic placeholder for an empty channel", async () => {
    vi.useFakeTimers();
    const placeholderText = "Elements connected to this collection will appear here.";

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={[]} currentTag="empty-channel" />,
    );
    await flushAsync();

    const placeholder = screen.getByText(placeholderText);
    expect(placeholder.tagName).toBe("P");
    expect(placeholder).toHaveClass("italic");
    expect(placeholder).toHaveClass("text-center");
    expect(placeholder).not.toHaveClass("border-l");
    const placeholderContainer = placeholder.closest(
      "[data-grid-empty-channel-placeholder]",
    ) as HTMLElement | null;
    expect(placeholderContainer).toBeTruthy();
    expect(placeholderContainer).toHaveClass("grid");
    expect(placeholderContainer).toHaveClass("place-items-center");

    await act(async () => {
      rerender(<Grid {...BASE_PROPS} blocks={[]} />);
    });
    await flushAsync();
    expect(screen.queryByText(placeholderText)).not.toBeInTheDocument();

    await act(async () => {
      rerender(
        <Grid
          {...BASE_PROPS}
          blocks={[]}
          currentTag="empty-channel"
          routeSnapshotReady={false}
        />,
      );
    });
    await flushAsync();
    expect(screen.queryByText(placeholderText)).not.toBeInTheDocument();
  });

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

  it("preloads media through a wider readiness window without mounting preload-only GridItems", async () => {
    vi.useFakeTimers();

    const blocks = Array.from({ length: 20 }, (_, index) => {
      const id = 9800 + index;
      setBlockHeight(id, 260);
      return makeBlock(id, {
        block_type: "image",
        card_kind: "media",
        media_file: `source-${id}.png`,
        width: 1200,
        height: 800,
        preview_manifest: JSON.stringify({
          kind: "image",
          primary_preview_path: `preview-${id}.jpg`,
          width: 1200,
          height: 800,
          tiles: [
            {
              source_path: `source-${id}.png`,
              preview_path: `preview-${id}.jpg`,
              width: 1200,
              height: 800,
              is_video: false,
              is_video_poster: false,
            },
          ],
          overflow_count: 0,
        }),
      });
    });

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="scroll-readiness" />);

    act(() => {
      triggerResize(280, 400);
    });
    await flushAsync();

    const mountedItems = document.querySelectorAll("[data-feed-grid-item]").length;
    const debug = window.__MINE_FEED_SCROLL_DEBUG__;

    expect(debug).toBeTruthy();
    expect(debug?.mountedGridItems).toBe(mountedItems);
    expect(debug?.viewport?.mountedDomItemCount).toBe(mountedItems);
    expect(debug?.viewport?.blankViewportRisk).toBe(false);
    expect(debug?.preloadWindowPx.forward).toBeGreaterThan(
      debug?.renderWindowPx.forward ?? 0,
    );
    expect(mountedItems).toBeLessThan(blocks.length);
  });

  it("renders a deterministic-ready deep-viewport card through the layout-readiness live gate", async () => {
    vi.useFakeTimers();
    const imageCompleteSpy = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(false);

    try {
      const parentWidth = 280;
      const routeKey = "layout-readiness";
      const targetIndex = 80;
      const blocks = Array.from({ length: 120 }, (_, index) => {
        const id = 9900 + index;
        setBlockHeight(id, 280);
        return makeImageBlock(id);
      });
      const target = blocks[targetIndex]!;

      render(<Grid {...BASE_PROPS} blocks={blocks} currentTag={routeKey} />);

      act(() => {
        triggerResize(parentWidth, 400);
      });
      await flushMicrotasks();

      const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
      expect(scrollEl).toBeTruthy();

      act(() => {
        if (!scrollEl) return;
        scrollEl.scrollTop = targetIndex * (280 + TEST_GAP);
        scrollEl.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(20);
      });
      await flushMicrotasks();

      const liveCard = document.querySelector(`[data-block-slug="${target.slug}"]`);
      const debug = window.__MINE_FEED_SCROLL_DEBUG__;

      expect(debug?.layout?.totalBlockCount).toBe(blocks.length);
      expect(debug?.layout?.maxVisibleIndex ?? -1).toBeGreaterThan(0);
      expect(debug?.viewport?.blankViewportRisk).toBe(false);
      expect(debug?.viewport?.domViewportItemCount ?? 0).toBeGreaterThan(0);
      expect(liveCard).toBeTruthy();
      expect(gridItemForSlug(target.slug)).toHaveAttribute(
        "data-feed-grid-item-slug",
        target.slug,
      );
    } finally {
      imageCompleteSpy.mockRestore();
    }
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
    expect(scrollEl).not.toHaveClass("pt-16");
    expect(layoutEl?.style.marginTop).toBe("32px");
  });

  it("leaves the scrollport unmasked when the top fade preference is off", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(8101), makeBlock(8102)];
    setBlockHeight(8101, 200);
    setBlockHeight(8102, 220);

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="fade-off" />);
    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();
    expect(scrollEl?.dataset.gridTopFade).toBeUndefined();
    // The band stays mounted but fully transparent, so turning it on is a
    // compositor-only opacity change rather than a mount.
    const resting = document.querySelector('[data-top-fade-scrim="feed"]') as HTMLElement;
    expect(resting.dataset.topFadeVisible).toBe("false");
    expect(resting.style.opacity).toBe("0");
  });

  it("masks the scrolled feed without dropping the scrollport's own styles", async () => {
    vi.useFakeTimers();

    const blocks = Array.from({ length: 12 }, (_, index) => makeBlock(8200 + index));
    blocks.forEach((block, index) => setBlockHeight(8200 + index, 200 + index));

    render(
      <Grid {...BASE_PROPS} blocks={blocks} currentTag="fade-on" scrollEdgeFade />,
    );
    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement;
    const paddingBeforeScroll = scrollEl.style.paddingLeft;

    // At rest the first row must stay fully opaque.
    expect(scrollEl.dataset.gridTopFade).toBeUndefined();

    scrollEl.scrollTop = 600;
    fireEvent.scroll(scrollEl);
    await flushAsync();

    expect(scrollEl.dataset.gridTopFade).toBe("true");
    const scrim = document.querySelector('[data-top-fade-scrim="feed"]') as HTMLElement;
    expect(scrim).toBeTruthy();
    expect(scrim.dataset.topFadeVisible).toBe("true");
    expect(scrim.style.opacity).toBe("1");
    // Constant height: scrolling changes opacity only, never layout.
    expect(scrim.style.height).toBe(`${TOP_FADE_HEIGHT}px`);
    // Outside the scrollport, so it inherits none of its padding and adds no
    // layout work to the scrolled subtree.
    expect(scrollEl.contains(scrim)).toBe(false);
    // The scrollport keeps its own styles and is never masked.
    expect(scrollEl.style.paddingLeft).toBe(paddingBeforeScroll);
    expect(scrollEl.style.scrollbarGutter).toBe("stable");
    expect(scrollEl.style.maskImage).toBe("");
  });

  it("restores feed focus by slug and marks the GridItem without Card focus props", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9101), makeBlock(9102), makeBlock(9103)];
    setBlockHeight(9101, 200);
    setBlockHeight(9102, 220);
    setBlockHeight(9103, 240);

    render(
      <Grid
        {...BASE_PROPS}
        blocks={blocks}
        restoreFocusSlug="block-9102"
        restoreFocusSequence={1}
      />,
    );
    await flushAsync();

    const focused = document.querySelector(
      '[data-block-slug="block-9102"]',
    ) as HTMLElement | null;
    const focusedWrapper = gridItemForSlug("block-9102");
    const scroll = document.querySelector("[data-grid-scroll]");

    expect(focused).toBeTruthy();
    expect(focused).not.toHaveAttribute("data-feed-card-focused");
    expect(focused).not.toHaveClass("ring-2");
    expect(focusedWrapper?.style.height).toBe(
      `${computeCardHeight(blocks[1]!, testColumnWidth(1200), null)}px`,
    );
    expect(scroll).toHaveAttribute("data-feed-grid-focus-mode", "true");
    expect(focusedWrapper).toHaveAttribute("data-feed-grid-item-focused", "true");
    expect(focusedWrapper?.querySelector("[data-feed-grid-focus-frame]")).toBeNull();
  });

  it("uses the same content-box width source on mount and ResizeObserver updates", async () => {
    vi.useFakeTimers();

    const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).hasAttribute("data-grid-scroll") ? 1064 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).hasAttribute("data-grid-scroll") ? 800 : 0;
      },
    });

    try {
      const blocks = [
        makeImageBlock(9701),
        makeImageBlock(9702),
        makeImageBlock(9703),
      ];

      render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="content-width" />);
      await flushAsync();

      const firstWrapper = gridItemForSlug("block-9701");
      expect(firstWrapper?.style.width).toBe(`${testColumnWidth(1000)}px`);

      act(() => {
        triggerResize(1000, 800);
      });
      await flushAsync();

      expect(firstWrapper?.style.width).toBe(`${testColumnWidth(1000)}px`);
    } finally {
      if (clientWidthDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
      } else {
        delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
      }
    }
  });

  it("owns arrow-key navigation in Grid and uses layout positions instead of DOM rectangles", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(9201),
      makeBlock(9202),
      makeBlock(9203),
      makeBlock(9204),
      makeBlock(9205),
    ];
    setBlockHeight(9201, 200);
    setBlockHeight(9202, 220);
    setBlockHeight(9203, 240);
    setBlockHeight(9204, 260);
    setBlockHeight(9205, 200);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    const firstFocusedWrapper = gridItemForSlug("block-9201");
    expect(firstFocusedWrapper).toHaveAttribute("data-feed-grid-item-focused", "true");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    const nextFocusedWrapper = gridItemForSlug("block-9205");
    expect(nextFocusedWrapper).toHaveAttribute("data-feed-grid-item-focused", "true");
  });

  it("shows the Command-K badge on feed keyboard focus and opens the focused card overflow menu", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9251), makeBlock(9252)];
    setBlockHeight(9251, 200);
    setBlockHeight(9252, 220);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    const focusedWrapper = gridItemForSlug("block-9251");
    expect(focusedWrapper).toHaveAttribute("data-feed-grid-item-focused", "true");
    const actionLayer = focusedWrapper?.querySelector("[data-feed-grid-action-layer]");
    expect(actionLayer).toHaveClass("inset-px");
    const actionBadge = focusedWrapper?.querySelector("[data-feed-grid-action-badge]");
    expect(actionBadge).toHaveTextContent("⌘K");
    expect(actionBadge).toHaveClass("left-2", "top-2");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await flushAsync();

    expect(screen.getByText("Rename…")).toBeInTheDocument();
    expect(
      focusedWrapper?.querySelector("[data-card-hover-more-action]"),
    ).toHaveClass("opacity-100");
    expect(
      focusedWrapper?.querySelector("[data-card-hover-bottom-actions]"),
    ).toHaveClass("opacity-0");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await flushAsync();

    expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
  });

  it("keeps the keyboard-opened menu anchor visually pinned while pointer hover moves elsewhere", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9256), makeBlock(9257), makeBlock(9258)];
    setBlockHeight(9256, 200);
    setBlockHeight(9257, 220);
    setBlockHeight(9258, 240);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    const gridScroll = document.querySelector("[data-grid-scroll]") as HTMLElement;
    const anchorWrapper = gridItemForSlug("block-9256");
    const pointerWrapper = gridItemForSlug("block-9257");
    expect(anchorWrapper).toBeTruthy();
    expect(pointerWrapper).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await flushAsync();

    expect(screen.getByText("Rename…")).toBeInTheDocument();
    expect(anchorWrapper).toHaveAttribute("data-feed-grid-item-focused", "true");

    fireEvent.pointerMove(pointerWrapper!, {
      clientX: 260,
      clientY: 180,
      movementX: 1,
      movementY: 0,
      pointerId: 1,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "pointer");
    expect(gridScroll).toHaveAttribute("data-feed-grid-focus-mode", "true");
    expect(anchorWrapper).toHaveAttribute("data-feed-grid-item-focused", "true");
    expect(anchorWrapper?.querySelector("[data-feed-grid-action-badge]")).toHaveTextContent("⌘K");
    expect(
      anchorWrapper?.querySelector("[data-card-hover-more-action]"),
    ).toHaveClass("opacity-100");
    expect(
      anchorWrapper?.querySelector("[data-card-hover-bottom-actions]"),
    ).not.toHaveClass("group-hover:opacity-100");
    expect(
      pointerWrapper?.querySelector("[data-card-hover-more-action]"),
    ).toHaveClass("group-hover:opacity-100");
    expect(screen.getByText("Rename…")).toBeInTheDocument();
  });

  it("does not let stationary pointer hover compete with feed keyboard focus", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9261), makeBlock(9262), makeBlock(9263)];
    setBlockHeight(9261, 200);
    setBlockHeight(9262, 220);
    setBlockHeight(9263, 240);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    const gridScroll = document.querySelector("[data-grid-scroll]") as HTMLElement;
    const firstWrapper = gridItemForSlug("block-9261");
    const secondWrapper = gridItemForSlug("block-9262");
    expect(firstWrapper).toBeTruthy();
    expect(secondWrapper).toBeTruthy();

    fireEvent.pointerMove(firstWrapper!, { clientX: 120, clientY: 160, pointerId: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "pointer");
    expect(firstWrapper?.querySelector("[data-card-hover-more-action]")).toHaveClass("group-hover:opacity-100");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "keyboard");
    expect(
      document.querySelector("[data-feed-grid-item-focused='true']"),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-card-hover-more-action]"),
    ).not.toHaveClass("group-hover:opacity-100");

    fireEvent.pointerMove(secondWrapper!, { clientX: 120, clientY: 160, pointerId: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "keyboard");
    expect(
      document.querySelector("[data-card-hover-more-action]"),
    ).not.toHaveClass("group-hover:opacity-100");

    fireEvent.pointerMove(secondWrapper!, { clientX: 121, clientY: 160, pointerId: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "pointer");
    expect(secondWrapper?.querySelector("[data-card-hover-more-action]")).toHaveClass("group-hover:opacity-100");
    expect(document.querySelector("[data-feed-grid-item-focused='true']")).toBeNull();
  });

  it("does not let a first stationary pointermove claim the feed after keyboard focus", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9271), makeBlock(9272), makeBlock(9273)];
    setBlockHeight(9271, 200);
    setBlockHeight(9272, 220);
    setBlockHeight(9273, 240);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    const gridScroll = document.querySelector("[data-grid-scroll]") as HTMLElement;
    const secondWrapper = gridItemForSlug("block-9272");
    expect(secondWrapper).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "keyboard");

    fireEvent.pointerMove(secondWrapper!, {
      clientX: 220,
      clientY: 180,
      movementX: 0,
      movementY: 0,
      pointerId: 1,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "keyboard");
    expect(
      secondWrapper?.querySelector("[data-card-hover-more-action]"),
    ).not.toHaveClass("group-hover:opacity-100");

    fireEvent.pointerMove(secondWrapper!, {
      clientX: 221,
      clientY: 180,
      movementX: 1,
      movementY: 0,
      pointerId: 1,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridScroll).toHaveAttribute("data-feed-grid-interaction-mode", "pointer");
    expect(secondWrapper?.querySelector("[data-card-hover-more-action]")).toHaveClass("group-hover:opacity-100");
  });

  it("resynchronizes arrow-key navigation to the current viewport after manual scroll", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(9401),
      makeBlock(9402),
      makeBlock(9403),
      makeBlock(9404),
    ];
    setBlockHeight(9401, 200);
    setBlockHeight(9402, 200);
    setBlockHeight(9403, 200);
    setBlockHeight(9404, 200);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);

    act(() => {
      triggerResize(280, 300);
    });
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridItemForSlug("block-9401")).toHaveAttribute(
      "data-feed-grid-item-focused",
      "true",
    );

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();

    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 560;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridItemForSlug("block-9401")).not.toHaveAttribute(
      "data-feed-grid-item-focused",
    );
    expect(gridItemForSlug("block-9402")).not.toHaveAttribute(
      "data-feed-grid-item-focused",
    );
    expect(gridItemForSlug("block-9403")).toHaveAttribute(
      "data-feed-grid-item-focused",
      "true",
    );
  });

  it("preserves the viewport anchor when cards are removed from different feed positions", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(9601),
      makeBlock(9602),
      makeBlock(9603),
      makeBlock(9604),
      makeBlock(9605),
      makeBlock(9606),
      makeBlock(9607),
      makeBlock(9608),
    ];
    for (const block of blocks) {
      setBlockHeight(block.id, 200);
    }

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={blocks} currentTag="delete-anchor" />,
    );

    act(() => {
      triggerResize(280, 300);
    });
    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();

    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 528;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });
    await flushAsync();

    expect(gridItemForSlug("block-9603")).toBeTruthy();

    rerender(
      <Grid
        {...BASE_PROPS}
        blocks={blocks.filter((block) => block.id !== 9601 && block.id !== 9605)}
        currentTag="delete-anchor"
      />,
    );
    await flushAsync();

    expect(scrollEl?.scrollTop).toBe(264);
    expect(gridItemForSlug("block-9603")).toBeTruthy();
  });

  it("keeps the viewport at the top when a batch of cards is inserted at the head", async () => {
    vi.useFakeTimers();

    // Single column at 280px, a deep feed so there is room to scroll. The
    // viewport starts at the very top (scrollTop 0).
    const blocks = Array.from({ length: 10 }, (_, index) => makeBlock(9700 + index));
    for (const block of blocks) {
      setBlockHeight(block.id, 200);
    }

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={blocks} currentTag="head-insert-anchor" />,
    );

    act(() => {
      triggerResize(280, 300);
    });
    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();
    expect(scrollEl?.scrollTop).toBe(0);

    // Prepend a full batch (>= columnCount) of new cards at the head, as a
    // clipper/import save does (feed is saved_at DESC). The viewport must stay at
    // the top to reveal them, not anchor the old first card and push the new rows
    // above the fold.
    const prepended = [
      makeBlock(9690),
      makeBlock(9691),
      makeBlock(9692),
      ...blocks,
    ];
    for (const block of prepended) {
      setBlockHeight(block.id, 200);
    }
    rerender(
      <Grid {...BASE_PROPS} blocks={prepended} currentTag="head-insert-anchor" />,
    );
    await flushAsync();

    expect(scrollEl?.scrollTop).toBe(0);
    expect(gridItemForSlug("block-9690")).toBeTruthy();
  });

  it("does not let stale keyboard focus override delete scroll anchoring", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(9611),
      makeBlock(9612),
      makeBlock(9613),
      makeBlock(9614),
      makeBlock(9615),
      makeBlock(9616),
    ];
    for (const block of blocks) {
      setBlockHeight(block.id, 200);
    }

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={blocks} currentTag="delete-keyboard-anchor" />,
    );

    act(() => {
      triggerResize(280, 300);
    });
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9611")).toHaveAttribute(
      "data-feed-grid-item-focused",
      "true",
    );

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement | null;
    expect(scrollEl).toBeTruthy();
    act(() => {
      if (scrollEl) {
        scrollEl.scrollTop = 760;
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });
    await flushAsync();

    const scrollToMock = vi.mocked(Element.prototype.scrollTo);
    scrollToMock.mockClear();

    rerender(
      <Grid
        {...BASE_PROPS}
        blocks={blocks.filter((block) => block.id !== 9612)}
        currentTag="delete-keyboard-anchor"
      />,
    );
    await flushAsync();

    expect(scrollEl?.scrollTop).toBe(496);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("does not handle feed keyboard navigation while disabled by App", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9301), makeBlock(9302)];
    setBlockHeight(9301, 200);
    setBlockHeight(9302, 220);

    render(<Grid {...BASE_PROPS} blocks={blocks} keyboardNavigationDisabled />);
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-feed-grid-item-focused]")).toBeNull();
  });

  it("toggles group selection with Command-click without opening Detail", async () => {
    vi.useFakeTimers();

    const onBlockClick = vi.fn();
    const onGroupSelectionStart = vi.fn();
    const blocks = [makeBlock(9501), makeBlock(9502)];
    setBlockHeight(9501, 200);
    setBlockHeight(9502, 220);

    render(
      <Grid
        {...BASE_PROPS}
        onBlockClick={onBlockClick}
        onGroupSelectionStart={onGroupSelectionStart}
        blocks={blocks}
      />,
    );
    await flushAsync();

    const card = document.querySelector('[data-block-slug="block-9501"]') as HTMLElement;
    fireEvent.click(card, { metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    const selectedWrapper = gridItemForSlug("block-9501");
    expect(onBlockClick).not.toHaveBeenCalled();
    expect(onGroupSelectionStart).toHaveBeenCalledTimes(1);
    expect(selectedWrapper).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(selectedWrapper?.style.overflow).toBe("visible");
    expect(selectedWrapper?.querySelector("[data-feed-grid-card-clip]")).toHaveClass(
      "overflow-hidden",
    );
    expect(
      selectedWrapper?.querySelector("[data-feed-grid-selection-frame]"),
    ).toBeTruthy();
    expect(
      selectedWrapper?.querySelector("[data-card-hover-more-action]"),
    ).not.toHaveClass("group-hover:opacity-100");
    expect(
      selectedWrapper?.querySelector("[data-card-hover-more-action]"),
    ).toHaveClass("pointer-events-none");
    expect(
      selectedWrapper?.querySelector("[data-card-hover-more-action]"),
    ).not.toHaveAttribute("data-card-hover-enabled");
    const unselectedWrapper = gridItemForSlug("block-9502");
    expect(
      unselectedWrapper?.querySelector("[data-card-hover-more-action]"),
    ).not.toHaveClass("group-hover:opacity-100");
    expect(
      unselectedWrapper?.querySelector("[data-card-hover-bottom-actions]"),
    ).not.toHaveClass("group-hover:opacity-100");
    const actionBar = document.querySelector("[data-feed-selection-action-bar]");
    expect(actionBar).toHaveClass(
      "absolute",
      "left-1/2",
      "bottom-s3",
      "max-w-[calc(100%-3rem)]",
      "-translate-x-1/2",
    );
    expect(actionBar).not.toHaveClass("fixed", "right-6");
    expect(actionBar?.firstElementChild).toHaveClass(
      "h-8",
      "overflow-x-auto",
      "border-border",
      "bg-accent",
      "text-foreground",
    );
    expect(actionBar?.firstElementChild).not.toHaveClass(
      "bg-accent/90",
      "bg-foreground",
      "text-background",
      "backdrop-blur-sm",
      "backdrop-saturate-150",
    );
    expect(actionBar?.querySelector(".w-px")).toBeNull();
    expect(screen.getByText("1 карточка")).toHaveClass(
      "font-mono",
      "text-sm",
      "text-muted-foreground",
    );
    expect(screen.getByText("1 карточка")).not.toHaveClass("font-semibold");
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeInTheDocument();
    const actionBarQueries = within(actionBar as HTMLElement);
    expect(
      actionBarQueries.getAllByRole("button").at(-1),
    ).toHaveAccessibleName("Clear selection");
    expect(actionBarQueries.getByRole("button", { name: /Connect/i })).toHaveAttribute(
      "data-variant",
      "default",
    );
    expect(actionBarQueries.getByRole("button", { name: /Connect/i })).toHaveClass(
      "bg-component-fill",
    );
    expect(actionBarQueries.getByRole("button", { name: /Connect/i })).not.toHaveClass(
      "bg-background/15",
      "text-background",
    );
    expect(actionBarQueries.queryByRole("button", { name: /Disconnect/i })).toBeNull();
    expect(actionBarQueries.getByRole("button", { name: /Delete/i })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    expect(actionBarQueries.getByRole("button", { name: /Delete/i })).toHaveClass(
      "text-destructive",
    );
    expect(actionBarQueries.getByRole("button", { name: /Delete/i }).querySelector("svg")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove from Collection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Source/i })).not.toBeInTheDocument();

    fireEvent.click(card, { metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(selectedWrapper).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(screen.queryByText("1 карточка")).not.toBeInTheDocument();
  });

  it("turns plain card clicks into selection toggles while group selection is active", async () => {
    vi.useFakeTimers();

    const onBlockClick = vi.fn();
    const blocks = [makeBlock(9511), makeBlock(9512)];
    setBlockHeight(9511, 200);
    setBlockHeight(9512, 220);

    render(<Grid {...BASE_PROPS} onBlockClick={onBlockClick} blocks={blocks} />);
    await flushAsync();

    const firstCard = document.querySelector('[data-block-slug="block-9511"]') as HTMLElement;
    const secondCard = document.querySelector('[data-block-slug="block-9512"]') as HTMLElement;

    fireEvent.click(firstCard, { metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(secondCard);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9511")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9512")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("2 карточки")).toBeInTheDocument();

    fireEvent.click(firstCard);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9511")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(gridItemForSlug("block-9512")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("1 карточка")).toBeInTheDocument();
  });

  it("opens the merge dialog from the selection island and submits selected slugs", async () => {
    vi.useFakeTimers();

    const onMergeSelectedBlocks = vi.fn(async () => undefined);
    const blocks = [makeBlock(9518), makeBlock(9519)];
    setBlockHeight(9518, 200);
    setBlockHeight(9519, 220);

    render(
      <Grid
        {...BASE_PROPS}
        blocks={blocks}
        onMergeSelectedBlocks={onMergeSelectedBlocks}
      />,
    );
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9518"]')!, {
      metaKey: true,
    });
    fireEvent.click(document.querySelector('[data-block-slug="block-9519"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Merge 2 elements")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(onMergeSelectedBlocks).toHaveBeenCalledWith(["block-9518", "block-9519"]);
    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeNull();
  });

  it("toggles the pointer-hovered card with Enter while group selection is active", async () => {
    vi.useFakeTimers();

    const onBlockClick = vi.fn();
    const blocks = [makeBlock(9515), makeBlock(9516), makeBlock(9517)];
    setBlockHeight(9515, 200);
    setBlockHeight(9516, 220);
    setBlockHeight(9517, 240);

    render(<Grid {...BASE_PROPS} onBlockClick={onBlockClick} blocks={blocks} />);
    await flushAsync();

    const firstCard = document.querySelector('[data-block-slug="block-9515"]') as HTMLElement;
    const thirdCard = document.querySelector('[data-block-slug="block-9517"]') as HTMLElement;
    const secondWrapper = gridItemForSlug("block-9516");
    expect(secondWrapper).toBeTruthy();

    fireEvent.click(firstCard, { metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.pointerMove(secondWrapper!, {
      clientX: 240,
      clientY: 160,
      movementX: 1,
      movementY: 0,
      pointerId: 1,
    });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.keyDown(document.body, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9515")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9516")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("2 карточки")).toBeInTheDocument();

    fireEvent.keyDown(thirdCard, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9517")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("3 карточки")).toBeInTheDocument();
  });

  it("supports keyboard-only group selection with Shift-Enter and Enter", async () => {
    vi.useFakeTimers();

    const onBlockClick = vi.fn();
    const blocks = [makeBlock(9521), makeBlock(9522), makeBlock(9523)];
    setBlockHeight(9521, 200);
    setBlockHeight(9522, 220);
    setBlockHeight(9523, 240);

    render(<Grid {...BASE_PROPS} onBlockClick={onBlockClick} blocks={blocks} />);
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9521")).toHaveAttribute("data-feed-grid-item-focused", "true");

    fireEvent.keyDown(window, { key: "Enter", shiftKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9521")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("1 карточка")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9522")).toHaveAttribute("data-feed-grid-item-focused", "true");

    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9521")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9522")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("2 карточки")).toBeInTheDocument();
  });

  it("uses Grid keyboard focus, not stale DOM focus, for Enter in group selection", async () => {
    vi.useFakeTimers();

    const onBlockClick = vi.fn();
    const blocks = [makeBlock(9524), makeBlock(9525), makeBlock(9526)];
    setBlockHeight(9524, 200);
    setBlockHeight(9525, 220);
    setBlockHeight(9526, 240);

    render(<Grid {...BASE_PROPS} onBlockClick={onBlockClick} blocks={blocks} />);
    await flushAsync();

    const firstCard = document.querySelector('[data-block-slug="block-9524"]') as HTMLElement;

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter", shiftKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9524")).toHaveAttribute("data-feed-grid-item-selected", "true");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9525")).toHaveAttribute("data-feed-grid-item-focused", "true");

    fireEvent.keyDown(firstCard, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9524")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9525")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(screen.getByText("2 карточки")).toBeInTheDocument();
  });

  it("opens a focused-card batch menu with Command-K while group selection is active", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9531), makeBlock(9532)];
    setBlockHeight(9531, 200);
    setBlockHeight(9532, 220);

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter", shiftKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    const focusedWrapper = gridItemForSlug("block-9531");
    const batchMenu = document.querySelector("[data-feed-grid-batch-menu]") as HTMLElement;
    expect(focusedWrapper?.querySelector("[data-feed-grid-batch-menu-trigger]")).toHaveAttribute("data-state", "open");
    expect(batchMenu).toBeInTheDocument();
    expect(within(batchMenu).getByText("1 карточка")).toBeInTheDocument();
    const connectItem = within(batchMenu).getByText("Connect").closest("[role='menuitem']");
    const deleteItem = within(batchMenu).getByText("Delete").closest("[role='menuitem']");
    expect(connectItem?.querySelector("svg")).toBeTruthy();
    expect(deleteItem?.querySelector("[data-card-menu-icon-slot]")).toBeTruthy();
    expect(deleteItem?.querySelector("svg")).toBeTruthy();
    expect(within(batchMenu).queryByText("Disconnect")).toBeNull();
    expect(within(batchMenu).queryByText("Source")).toBeNull();
    expect(within(batchMenu).queryByText("Rename…")).toBeNull();

    fireEvent.keyDown(batchMenu, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-feed-grid-batch-menu]")).not.toBeInTheDocument();
    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeInTheDocument();
    expect(gridItemForSlug("block-9531")).toHaveAttribute("data-feed-grid-item-selected", "true");
  });

  it("shows collection-scoped Disconnect in the focused-card batch menu outside Everything", async () => {
    vi.useFakeTimers();

    const onBatchSetTag = vi.fn();
    const blocks = [makeBlock(9533), makeBlock(9534)];
    setBlockHeight(9533, 200);
    setBlockHeight(9534, 220);

    render(
      <Grid
        {...BASE_PROPS}
        blocks={blocks}
        currentTag="test"
        onBatchSetTag={onBatchSetTag}
      />,
    );
    await flushAsync();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter", shiftKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    const batchMenu = document.querySelector("[data-feed-grid-batch-menu]") as HTMLElement;
    const disconnectItem = within(batchMenu).getByText("Disconnect").closest("[role='menuitem']");
    expect(disconnectItem?.querySelector("[data-card-menu-icon-slot]")).toBeTruthy();
    expect(disconnectItem?.querySelector("svg")).toBeTruthy();

    fireEvent.click(within(batchMenu).getByText("Disconnect"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-feed-grid-batch-menu]")).not.toBeInTheDocument();
    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeNull();
    expect(onBatchSetTag).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(onBatchSetTag).toHaveBeenCalledWith(["block-9533"], "test", false);
  });

  it("exports selected cards as the drag group and hides the action island while dragging", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9571), makeBlock(9572), makeBlock(9573)];
    setBlockHeight(9571, 200);
    setBlockHeight(9572, 220);
    setBlockHeight(9573, 240);

    const { rerender } = render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9571"]')!, { metaKey: true });
    fireEvent.click(document.querySelector('[data-block-slug="block-9572"]')!, { metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('[data-block-slug="block-9571"]')).toHaveAttribute(
      "data-feed-card-drag-count",
      "2",
    );
    expect(document.querySelector('[data-block-slug="block-9571"]')).toHaveAttribute(
      "data-feed-card-drag-slugs",
      "block-9571 block-9572",
    );
    expect(document.querySelector('[data-block-slug="block-9572"]')).toHaveAttribute(
      "data-feed-card-drag-slugs",
      "block-9572 block-9571",
    );
    expect(document.querySelector('[data-block-slug="block-9573"]')).not.toHaveAttribute(
      "data-feed-card-drag-count",
    );
    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeInTheDocument();

    rerender(<Grid {...BASE_PROPS} blocks={blocks} blockDragActive />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeNull();
    expect(gridItemForSlug("block-9571")).toHaveAttribute(
      "data-feed-grid-item-selected",
      "true",
    );
  });

  it("clears group selection on empty-grid click and route change", async () => {
    vi.useFakeTimers();

    const onBlockClick = vi.fn();
    const blocks = [makeBlock(9551), makeBlock(9552)];
    setBlockHeight(9551, 200);
    setBlockHeight(9552, 220);

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={blocks} onBlockClick={onBlockClick} />,
    );
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9551"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9551")).toHaveAttribute("data-feed-grid-item-selected", "true");

    fireEvent.pointerDown(document.querySelector("[data-grid-scroll]")!, {
      pointerId: 1,
      button: 0,
      clientX: 120,
      clientY: 120,
    });
    fireEvent.pointerUp(document.querySelector("[data-grid-scroll]")!, {
      pointerId: 1,
      clientX: 120,
      clientY: 120,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9551")).not.toHaveAttribute("data-feed-grid-item-selected");

    fireEvent.click(document.querySelector('[data-block-slug="block-9551"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(document.querySelector('[data-block-slug="block-9552"]')!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onBlockClick).not.toHaveBeenCalled();
    expect(gridItemForSlug("block-9551")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9552")).toHaveAttribute("data-feed-grid-item-selected", "true");

    fireEvent.click(document.querySelector('[data-block-slug="block-9551"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(gridItemForSlug("block-9551")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(gridItemForSlug("block-9552")).toHaveAttribute("data-feed-grid-item-selected", "true");

    rerender(<Grid {...BASE_PROPS} blocks={blocks} currentTag="next-channel" onBlockClick={onBlockClick} />);
    await flushAsync();
    expect(gridItemForSlug("block-9551")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(gridItemForSlug("block-9552")).not.toHaveAttribute("data-feed-grid-item-selected");
  });

  it("clears group selection when Detail opens outside Grid", async () => {
    vi.useFakeTimers();

    const blocks = [makeBlock(9561), makeBlock(9562)];
    setBlockHeight(9561, 200);
    setBlockHeight(9562, 220);

    const { rerender } = render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9561"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridItemForSlug("block-9561")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeInTheDocument();

    rerender(<Grid {...BASE_PROPS} blocks={blocks} detailOpen />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridItemForSlug("block-9561")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeNull();
  });

  it("toggles individual cards with Shift-click instead of selecting a range", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(9511),
      makeBlock(9512),
      makeBlock(9513),
      makeBlock(9514),
    ];
    for (const block of blocks) {
      setBlockHeight(block.id, 200);
    }

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9511"]')!, {
      shiftKey: true,
    });
    fireEvent.click(document.querySelector('[data-block-slug="block-9513"]')!, {
      shiftKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(gridItemForSlug("block-9511")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9512")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(gridItemForSlug("block-9513")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9514")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(screen.getByText("2 карточки")).toBeInTheDocument();
  });

  it("selects every card intersecting an empty-area marquee drag", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(9541),
      makeBlock(9542),
      makeBlock(9543),
      makeBlock(9544),
    ];
    for (const block of blocks) {
      setBlockHeight(block.id, 200);
    }

    render(<Grid {...BASE_PROPS} blocks={blocks} />);
    await flushAsync();

    const scrollEl = document.querySelector("[data-grid-scroll]") as HTMLElement;
    const layoutEl = document.querySelector("[data-grid-layout]") as HTMLElement;
    layoutEl.getBoundingClientRect = vi.fn(() => ({
      width: 1200,
      height: 300,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect);

    fireEvent.pointerDown(scrollEl, {
      pointerId: 1,
      button: 0,
      clientX: 300,
      clientY: 10,
    });
    fireEvent.pointerMove(scrollEl, {
      pointerId: 1,
      clientX: 700,
      clientY: 220,
    });
    await act(async () => {
      await Promise.resolve();
    });

    const marquee = document.querySelector("[data-feed-grid-marquee-selection]") as HTMLElement;
    expect(marquee).toBeTruthy();
    expect(marquee).toHaveStyle({
      left: "300px",
      top: "10px",
      width: "400px",
      height: "210px",
    });
    expect(gridItemForSlug("block-9541")).not.toHaveAttribute("data-feed-grid-item-selected");
    expect(gridItemForSlug("block-9542")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9543")).toHaveAttribute("data-feed-grid-item-selected", "true");
    expect(gridItemForSlug("block-9544")).not.toHaveAttribute("data-feed-grid-item-selected");

    fireEvent.pointerUp(scrollEl, {
      pointerId: 1,
      clientX: 700,
      clientY: 220,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-feed-grid-marquee-selection]")).toBeNull();
    expect(screen.getByText("2 карточки")).toBeInTheDocument();
  });

  it("runs the collection-scoped Disconnect action against the selected slugs", async () => {
    vi.useFakeTimers();

    const onBatchSetTag = vi.fn();
    const blocks = [makeBlock(9521), makeBlock(9522)];
    setBlockHeight(9521, 200);
    setBlockHeight(9522, 220);

    render(
      <Grid
        {...BASE_PROPS}
        blocks={blocks}
        currentTag="test"
        onBatchSetTag={onBatchSetTag}
      />,
    );
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9521"]')!, {
      metaKey: true,
    });
    fireEvent.click(document.querySelector('[data-block-slug="block-9522"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });

    const disconnectButton = screen.getByRole("button", { name: /Disconnect/i });
    expect(disconnectButton.querySelector("svg")).toBeNull();
    fireEvent.click(disconnectButton);
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector("[data-feed-selection-action-bar]")).toBeNull();
    expect(onBatchSetTag).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(onBatchSetTag).toHaveBeenCalledWith(
      ["block-9521", "block-9522"],
      "test",
      false,
    );
  });

  it("connects or disconnects every selected slug from the batch picker without mixed counts", async () => {
    vi.useFakeTimers();

    const onBatchSetTag = vi.fn();
    const blocks = [makeBlock(9531), makeBlock(9532)];
    setBlockHeight(9531, 200);
    setBlockHeight(9532, 220);

    render(
      <Grid
        {...BASE_PROPS}
        blocks={blocks}
        tags={[
          { tag: "test", count: 1 },
          { tag: "all-connected", count: 2 },
        ]}
        onLoadBlockTags={vi.fn(async () => (
          new Map([
            ["block-9531", ["test", "all-connected"]],
            ["block-9532", ["all-connected"]],
          ])
        ))}
        onBatchSetTag={onBatchSetTag}
      />,
    );
    await flushAsync();

    fireEvent.click(document.querySelector('[data-block-slug="block-9531"]')!, {
      metaKey: true,
    });
    fireEvent.click(document.querySelector('[data-block-slug="block-9532"]')!, {
      metaKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });

    const connectTrigger = within(
      document.querySelector("[data-feed-selection-action-bar]") as HTMLElement,
    ).getByRole("button", { name: /Connect/i });
    fireEvent.pointerDown(connectTrigger, { button: 0, ctrlKey: false });
    await act(async () => {
      await Promise.resolve();
    });

    const testRow = screen.getByText("test").closest("[data-batch-collection-row]") as HTMLElement;
    expect(testRow).toHaveAttribute("data-batch-collection-row-state", "not-all");
    expect(within(testRow).getByRole("button", { name: "Connect test" })).toBeInTheDocument();
    expect(within(testRow).queryByText("1/2")).not.toBeInTheDocument();
    expect(testRow).toHaveAttribute("data-collection-picker-row-active", "true");

    fireEvent.click(within(testRow).getByRole("button", { name: "Connect test" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(testRow).toHaveAttribute("data-batch-collection-row-state", "all");
    expect(within(testRow).getByRole("button", { name: "Disconnect test" })).toHaveTextContent("Disconnect");
    expect(onBatchSetTag).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(onBatchSetTag).toHaveBeenLastCalledWith(
      ["block-9531", "block-9532"],
      "test",
      true,
    );

    const allConnectedRow = screen.getByText("all-connected").closest("[data-batch-collection-row]") as HTMLElement;
    expect(allConnectedRow).toHaveAttribute("data-batch-collection-row-state", "all");
    expect(within(allConnectedRow).getByRole("button", { name: "Disconnect all-connected" })).toHaveTextContent("Connected");
    fireEvent.pointerMove(allConnectedRow);
    expect(within(allConnectedRow).getByRole("button", { name: "Disconnect all-connected" })).toHaveTextContent("Disconnect");
    fireEvent.click(within(allConnectedRow).getByRole("button", { name: "Disconnect all-connected" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(allConnectedRow).toHaveAttribute("data-batch-collection-row-state", "not-all");
    expect(within(allConnectedRow).getByRole("button", { name: "Connect all-connected" })).toHaveTextContent("Connect");
    expect(onBatchSetTag).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(onBatchSetTag).toHaveBeenLastCalledWith(
      ["block-9531", "block-9532"],
      "all-connected",
      false,
    );
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

  it("keeps the masonry layout DOM node mounted when blocks grow", async () => {
    vi.useFakeTimers();

    const initial = Array.from({ length: 8 }, (_, i) => makeBlock(3000 + i));
    for (const block of initial) {
      setBlockHeight(block.id, 200);
    }

    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="no-remount" />,
    );
    await flushAsync();

    const layoutNodeBefore = document.querySelector("[data-grid-layout]");
    expect(layoutNodeBefore).toBeTruthy();

    // Simulate a pagination page arriving: the block list grows, which changes
    // the generation key. The virtualized layout must reconcile in place, not
    // remount — remounting would tear down every mounted <img> and reset any
    // playing video.
    const grown = [
      ...initial,
      ...Array.from({ length: 4 }, (_, i) => makeBlock(3100 + i)),
    ];
    for (const block of grown) {
      setBlockHeight(block.id, 200);
    }
    rerender(<Grid {...BASE_PROPS} blocks={grown} currentTag="no-remount" />);
    await flushAsync();

    const layoutNodeAfter = document.querySelector("[data-grid-layout]");
    expect(layoutNodeAfter).toBe(layoutNodeBefore);
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

  it("uses the new resize generation without reusing stale wide positions", async () => {
    vi.useFakeTimers();

    const blocks = [
      makeBlock(400),
      makeBlock(401),
      makeBlock(402),
      makeBlock(403),
    ];
    const wideParentWidth = 1200;
    const narrowParentWidth = 720;

    render(<Grid {...BASE_PROPS} blocks={blocks} currentTag="alpha" />);
    await flushAsync();

    const widePositions = readRenderedPositions();
    assertPositionsMatchFreshLayout(blocks, widePositions, wideParentWidth);

    act(() => {
      triggerResize(narrowParentWidth);
    });

    await flushAsync();

    const narrowPositions = readRenderedPositions();
    expect(narrowPositions).not.toEqual(widePositions);
    assertPositionsMatchFreshLayout(blocks, narrowPositions, narrowParentWidth);
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
      makeBlock(1400, {
        block_type: "image",
        card_kind: "media",
        media_file: "tall-prewarm-spacer.jpg",
        width: 100,
        height: 136,
      }),
      makeVideoBlock(1401),
    ];
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

  it("plays both visible heavy clips up to the heavy pool limit", async () => {
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

    // Two heavy clips both inside the autoplay window fit the pool of 2.
    expect(
      document.querySelector(
        "[data-block-slug='block-1601'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1602'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
  });

  it("keeps only the two most visible heavy videos active when more heavy cards compete", async () => {
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

    // Pool of 2: the two top-most fully-visible heavy clips play, the third
    // (only partially visible) does not.
    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(2);
    expect(
      document.querySelector(
        "[data-block-slug='block-1201'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1202'] [data-feed-video-surface='true']",
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        "[data-block-slug='block-1203'] [data-feed-video-surface='true']",
      ),
    ).toBeFalsy();
  });

  it("allows two heavy videos alongside visible standard videos", async () => {
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

    // Standard clips are unbounded; both heavy clips fit the pool of 2.
    expect(document.querySelectorAll("[data-feed-video-surface='true']")).toHaveLength(3);
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
    ).toBeTruthy();
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
  const columnWidth = testColumnWidth(parentWidth);
  const heights = blocks.map((block) => computeCardHeight(block, columnWidth, null));
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

// ─── Heavy autoplay pool arbitration (pure) ─────────────────────────────────

function heavyCandidate(
  slug: string,
  overrides: Partial<HeavyPlaybackCandidate> = {},
): HeavyPlaybackCandidate {
  return {
    slug,
    inViewport: true,
    viewportVisibleFraction: 1,
    windowVisibleFraction: 1,
    centerDistance: 0,
    top: 0,
    ...overrides,
  };
}

describe("selectActiveHeavyPlaybackSlugs", () => {
  it("caps the pool at FEED_HEAVY_MAX_ACTIVE, keeping the most visible clips", () => {
    expect(FEED_HEAVY_MAX_ACTIVE).toBe(2);

    const active = selectActiveHeavyPlaybackSlugs(
      [
        heavyCandidate("a", { viewportVisibleFraction: 0.9, top: 0 }),
        heavyCandidate("b", { viewportVisibleFraction: 0.6, top: 400 }),
        heavyCandidate("c", { viewportVisibleFraction: 0.3, top: 800 }),
      ],
      new Set(),
    );

    expect(active).toEqual(new Set(["a", "b"]));
  });

  it("prefers in-viewport clips over an off-screen clip lingering in the window", () => {
    const active = selectActiveHeavyPlaybackSlugs(
      [
        heavyCandidate("visible-a", {
          inViewport: true,
          viewportVisibleFraction: 0.5,
          top: 0,
        }),
        heavyCandidate("visible-b", {
          inViewport: true,
          viewportVisibleFraction: 0.5,
          top: 400,
        }),
        heavyCandidate("lingering", {
          inViewport: false,
          viewportVisibleFraction: 0,
          windowVisibleFraction: 0.6,
          top: 800,
        }),
      ],
      new Set(),
    );

    expect(active).toEqual(new Set(["visible-a", "visible-b"]));
  });

  it("breaks ties deterministically by layout position regardless of input order", () => {
    const build = (order: string[]): Set<string> =>
      selectActiveHeavyPlaybackSlugs(
        order.map((slug, index) =>
          heavyCandidate(slug, { top: { top32: 32, top364: 364, top696: 696 }[slug] ?? index }),
        ),
        new Set(),
      );

    // Three equally-visible clips: the two top-most win, independent of order.
    const forward = build(["top32", "top364", "top696"]);
    const shuffled = build(["top696", "top32", "top364"]);

    expect(forward).toEqual(new Set(["top32", "top364"]));
    expect(shuffled).toEqual(forward);
  });

  it("applies hysteresis so a marginal challenger cannot evict an incumbent", () => {
    expect(FEED_HEAVY_HYSTERESIS_FRACTION).toBe(0.1);

    // The pool holds "strong" and incumbent "held"; challenger "rising" competes
    // for the marginal (second) slot occupied by "held".
    const candidates = (risingFraction: number): HeavyPlaybackCandidate[] => [
      heavyCandidate("strong", { viewportVisibleFraction: 0.9, top: 0 }),
      heavyCandidate("held", { viewportVisibleFraction: 0.5, top: 400 }),
      heavyCandidate("rising", { viewportVisibleFraction: risingFraction, top: 800 }),
    ];
    const previous = new Set(["strong", "held"]);

    // +0.05 over the incumbent: within the 0.1 margin, incumbent keeps the slot.
    expect(selectActiveHeavyPlaybackSlugs(candidates(0.55), previous)).toEqual(
      new Set(["strong", "held"]),
    );

    // +0.15 over the incumbent: beyond the margin, the challenger takes the slot.
    expect(selectActiveHeavyPlaybackSlugs(candidates(0.65), previous)).toEqual(
      new Set(["strong", "rising"]),
    );
  });

  it("does not let an off-screen incumbent hold its slot against an in-viewport challenger", () => {
    // "lingering" was active but has scrolled out of the strict viewport
    // (inViewport false, fraction 0); it lingers only in the expanded window.
    // "rising" is inside the viewport but only marginally visible. Hysteresis
    // must not carry across the inViewport boundary, so the in-viewport
    // challenger takes the slot even though its fraction is within the margin.
    const active = selectActiveHeavyPlaybackSlugs(
      [
        heavyCandidate("strong", { inViewport: true, viewportVisibleFraction: 0.9, top: 0 }),
        heavyCandidate("rising", { inViewport: true, viewportVisibleFraction: 0.05, top: 400 }),
        heavyCandidate("lingering", {
          inViewport: false,
          viewportVisibleFraction: 0,
          windowVisibleFraction: 0.6,
          top: 800,
        }),
      ],
      new Set(["strong", "lingering"]),
    );

    expect(active).toEqual(new Set(["strong", "rising"]));
  });

  it("returns an empty pool when there are no heavy candidates", () => {
    expect(selectActiveHeavyPlaybackSlugs([], new Set(["stale"]))).toEqual(new Set());
  });
});
