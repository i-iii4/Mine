// Incremental font-metrics test.
//
// Verifies that adding a pagination page does not re-measure the whole feed:
// blocks whose word widths are already known keep them, and only genuinely new
// (or edited) blocks are handed to fetchWordWidths. This is isolated in its own
// file because it mocks fetchWordWidths to return real widths — which would
// change deterministic card heights and break the position-accuracy assertions
// in Grid.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

const { fetchWordWidthsMock } = vi.hoisted(() => ({
  fetchWordWidthsMock: vi.fn<(blocks: LightBlock[]) => Promise<Map<number, WordWidths>>>(),
}));

// Keep createFontMetricsCacheIdentity real (it derives the cache identity used
// to decide what needs re-measuring); only stub the async worker call.
vi.mock("@/lib/fontMetrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fontMetrics")>();
  return { ...actual, fetchWordWidths: fetchWordWidthsMock };
});

import { Grid } from "./Grid";
import { computeCardHeight } from "@/lib/cardHeight";
import { reloadFeedDisplay, setFeedShow } from "@/lib/feedDisplay";
import { getMasonryColumnWidth } from "@/lib/masonryLayout";
import { lightBlock } from "@/test/blocks";

// Grid's column geometry for the firing observer's 400px feed; these match the
// constants in Grid.tsx and the default spacing.
const FEED_WIDTH = 400;
const COLUMN_MIN_WIDTH = 220;
const DEFAULT_GAP = 32;

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return lightBlock({
    id,
    slug: `block-${id}`,
    card_kind: "article",
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
    collections: [],
    feed_playback: null,
    ...overrides,
  });
}

const EMPTY_WIDTHS: WordWidths = {
  title: [],
  preview: [],
  titleSpace: 0,
  previewSpace: 0,
  titleNoSpaceBefore: [],
  previewNoSpaceBefore: [],
};

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// A firing ResizeObserver gives Grid a non-zero parentWidth/viewportHeight so it
// mounts real GridItems (committed Card vs skeleton) — the Noop default leaves
// parentWidth 0 and renders nothing. Restores the previous global on teardown.
function installFiringResizeObserver(width = 400, height = 800): { restore: () => void } {
  const previous = globalThis.ResizeObserver;
  class FiringResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element): void {
      const contentRect = {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly;
      this.cb(
        [{ target: el, contentRect } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof ResizeObserver;
  return {
    restore: () => {
      globalThis.ResizeObserver = previous;
    },
  };
}

// A ResizeObserver that fires on observe and again at every `resize`: the
// feed's width moves while the Grid stays mounted.
function installResizableObserver(width: number, height = 800): {
  resize: (next: number) => void;
  restore: () => void;
} {
  const previous = globalThis.ResizeObserver;
  const observed: Array<{ cb: ResizeObserverCallback; el: Element; self: ResizeObserver }> = [];
  const fire = (target: { cb: ResizeObserverCallback; el: Element; self: ResizeObserver }, w: number) => {
    const contentRect = {
      width: w, height, top: 0, left: 0, right: w, bottom: height, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRectReadOnly;
    target.cb([{ target: target.el, contentRect } as unknown as ResizeObserverEntry], target.self);
  };
  class ResizableObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element): void {
      const entry = { cb: this.cb, el, self: this as unknown as ResizeObserver };
      observed.push(entry);
      fire(entry, width);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizableObserver as unknown as typeof ResizeObserver;
  return {
    resize: (next) => {
      for (const entry of observed) fire(entry, next);
    },
    restore: () => {
      globalThis.ResizeObserver = previous;
    },
  };
}

async function flush(): Promise<void> {
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
  onLoadBlockTags: vi.fn(async () => new Map<string, string[]>()),
  onBatchSetTag: vi.fn(),
  onCreateAndAssignBatch: vi.fn(),
  onPrepareDeleteSelectedBlocks: vi.fn(async (slugs: string[]) => ({ slugs, markdown_files: [], unused_media: [], shared_media: [] })),
  onDeleteSelectedBlocks: vi.fn(async () => undefined),
  onMergeSelectedBlocks: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

beforeEach(() => {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = vi.fn();
  fetchWordWidthsMock.mockReset();
  fetchWordWidthsMock.mockImplementation(async (blocks: LightBlock[]) => {
    const map = new Map<number, WordWidths>();
    for (const block of blocks) {
      map.set(block.id, EMPTY_WIDTHS);
    }
    return map;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function calledBlockIds(callIndex: number): number[] {
  const call = fetchWordWidthsMock.mock.calls[callIndex];
  if (!call) return [];
  return call[0].map((block) => block.id).sort((a, b) => a - b);
}

describe("Grid incremental word metrics", () => {
  it("measures only newly appended blocks on pagination", async () => {
    const initial = [makeBlock(1), makeBlock(2), makeBlock(3)];
    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="metrics" />,
    );
    await flush();

    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(1);
    expect(calledBlockIds(0)).toEqual([1, 2, 3]);

    // Pagination: a new array with fresh objects for the existing ids plus two
    // new blocks. Only the new ids should be measured.
    const grown = [
      makeBlock(1),
      makeBlock(2),
      makeBlock(3),
      makeBlock(4),
      makeBlock(5),
    ];
    rerender(<Grid {...BASE_PROPS} blocks={grown} currentTag="metrics" />);
    await flush();

    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(2);
    expect(calledBlockIds(1)).toEqual([4, 5]);
  });

  it("does not re-measure anything when the same content is re-applied", async () => {
    const initial = [makeBlock(10), makeBlock(11)];
    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="metrics-stable" />,
    );
    await flush();
    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(1);

    // A refresh that produced a new array with identical content.
    rerender(
      <Grid
        {...BASE_PROPS}
        blocks={[makeBlock(10), makeBlock(11)]}
        currentTag="metrics-stable"
      />,
    );
    await flush();

    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(1);
  });

  it("re-measures a block whose measured text changed", async () => {
    const initial = [makeBlock(20, { title: "One" }), makeBlock(21)];
    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="metrics-edit" />,
    );
    await flush();
    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(1);

    const edited = [makeBlock(20, { title: "One edited" }), makeBlock(21)];
    rerender(<Grid {...BASE_PROPS} blocks={edited} currentTag="metrics-edit" />);
    await flush();

    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(2);
    expect(calledBlockIds(1)).toEqual([20]);
  });

  it("re-measures a block that left and rejoined the feed", async () => {
    const initial = [makeBlock(40), makeBlock(41)];
    const { rerender } = render(
      <Grid {...BASE_PROPS} blocks={initial} currentTag="prune-rejoin" />,
    );
    await flush();
    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(1);
    expect(calledBlockIds(0)).toEqual([40, 41]);

    // Block 41 leaves the feed — its metrics are pruned, nothing new to measure.
    rerender(<Grid {...BASE_PROPS} blocks={[makeBlock(40)]} currentTag="prune-rejoin" />);
    await flush();
    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(1);

    // Re-adding 41 with identical content must re-measure it: without the prune
    // its stale identity entry would suppress the re-measurement.
    rerender(
      <Grid {...BASE_PROPS} blocks={[makeBlock(40), makeBlock(41)]} currentTag="prune-rejoin" />,
    );
    await flush();
    expect(fetchWordWidthsMock).toHaveBeenCalledTimes(2);
    expect(calledBlockIds(1)).toEqual([41]);
  });

  it("drops an edited block from render-ready until its recomputed widths arrive", async () => {
    const firing = installFiringResizeObserver();
    try {
      const initial = [makeBlock(50, { title: "Original" })];
      const { rerender } = render(
        <Grid {...BASE_PROPS} blocks={initial} currentTag="edit-render-ready" />,
      );
      await flush();

      const liveState = () =>
        document
          .querySelector('[data-feed-grid-item-slug="block-50"]')
          ?.getAttribute("data-feed-grid-item-live");
      expect(liveState()).toBe("true");

      // Hold the re-measurement so the skeleton window stays observable.
      let resolveEdit!: (map: Map<number, WordWidths>) => void;
      fetchWordWidthsMock.mockImplementationOnce(
        () =>
          new Promise<Map<number, WordWidths>>((resolve) => {
            resolveEdit = resolve;
          }),
      );

      rerender(
        <Grid
          {...BASE_PROPS}
          blocks={[makeBlock(50, { title: "Edited title" })]}
          currentTag="edit-render-ready"
        />,
      );
      await flush();

      // Stale widths were dropped, so the edited block waits as a skeleton rather
      // than laying out at its pre-edit height.
      expect(liveState()).toBe("false");

      await act(async () => {
        resolveEdit(new Map([[50, EMPTY_WIDTHS]]));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(liveState()).toBe("true");
    } finally {
      firing.restore();
    }
  });

  it("holds a picture framed by Cards as a skeleton until its name is measured (В5.4, Д15)", async () => {
    const firing = installFiringResizeObserver(FEED_WIDTH);
    setFeedShow("cards");
    try {
      const picture = makeBlock(60, {
        card_kind: "media",
        block_type: "image",
        title: null,
        // A picture's name in Cards is the heading its body opens with.
        content_heading: "Sunset",
        body: "# Sunset",
        media_file: "Media/Sunset.jpg",
        fallback_label: "Sunset",
        preview_manifest: JSON.stringify({
          kind: "image", primary_preview_path: "sunset.jpg", width: 1280, height: 960,
          preview_width: 640, preview_height: 480,
          tiles: [{ source_path: "Media/Sunset.jpg", preview_path: "sunset.jpg", width: 1280, height: 960,
            preview_width: 640, preview_height: 480, is_video: false, is_video_poster: false }],
          overflow_count: 0,
        }),
      });
      const oneLineName: WordWidths = {
        title: [48],
        preview: [],
        titleSpace: 4,
        previewSpace: 4,
        titleNoSpaceBefore: [false],
        previewNoSpaceBefore: [],
      };
      const columnWidth = getMasonryColumnWidth(FEED_WIDTH, COLUMN_MIN_WIDTH, DEFAULT_GAP);
      const exactHeight = computeCardHeight(picture, columnWidth, oneLineName, "cards");
      // The name's two-line allowance is what a cold card would be laid out at.
      expect(computeCardHeight(picture, columnWidth, null, "cards")).not.toBe(exactHeight);

      let finish!: (widths: Map<number, WordWidths>) => void;
      fetchWordWidthsMock.mockImplementationOnce(
        () => new Promise<Map<number, WordWidths>>((resolve) => { finish = resolve; }),
      );
      render(<Grid {...BASE_PROPS} blocks={[picture]} currentTag="cards-cold" />);
      await flush();

      const item = () =>
        document.querySelector<HTMLElement>('[data-feed-grid-item-slug="block-60"]');
      expect(item()?.getAttribute("data-feed-grid-item-live")).toBe("false");

      await act(async () => {
        finish(new Map([[60, oneLineName]]));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(item()?.getAttribute("data-feed-grid-item-live")).toBe("true");
      expect(item()?.style.height).toBe(`${exactHeight}px`);
    } finally {
      window.localStorage.clear();
      reloadFeedDisplay();
      firing.restore();
    }
  });

  it("starts a mounted feed where it stands, and moves to the top only for a new place or the signal («Возврат из графа»)", async () => {
    const firing = installFiringResizeObserver(FEED_WIDTH);
    try {
      const scrollToMock = vi.mocked(Element.prototype.scrollTo);
      scrollToMock.mockClear();
      const { rerender } = render(<Grid {...BASE_PROPS} blocks={[makeBlock(80)]} currentTag="place-a" />);
      await flush();
      // A feed just mounted may already have scrolled back to its card.
      expect(scrollToMock).not.toHaveBeenCalled();

      rerender(<Grid {...BASE_PROPS} blocks={[makeBlock(80)]} currentTag="place-b" />);
      await flush();
      expect(scrollToMock).toHaveBeenCalledTimes(1);
      expect(scrollToMock).toHaveBeenLastCalledWith(0, 0);

      rerender(<Grid {...BASE_PROPS} blocks={[makeBlock(80)]} currentTag="place-b" scrollToTop={1} />);
      await flush();
      expect(scrollToMock).toHaveBeenCalledTimes(2);

      rerender(<Grid {...BASE_PROPS} blocks={[makeBlock(81)]} currentTag="place-b" scrollToTop={1} />);
      await flush();
      expect(scrollToMock).toHaveBeenCalledTimes(2);
    } finally {
      firing.restore();
    }
  });

  it("lays a card out again with two text lines under its media when its column narrows past 220px (У14)", async () => {
    // 500px holds columns of at least 220px; 200px holds none, whatever the
    // column count, so its column is narrower than the minimum.
    const WIDE = 500;
    const NARROW = 200;
    const resizable = installResizableObserver(WIDE);
    setFeedShow("cards");
    try {
      const post = makeBlock(70, {
        title: null,
        url: "https://x.com/someone/status/70",
        body: "Ten long words\n\n![](photo.jpg)",
        preview_text: "Ten long words",
        media_urls: "[\"photo.jpg\"]",
        preview_manifest: JSON.stringify({
          kind: "image", primary_preview_path: "photo.jpg", width: 1000, height: 1000,
          preview_width: 1000, preview_height: 1000,
          tiles: [{ source_path: "photo.jpg", preview_path: "photo.jpg", width: 1000, height: 1000,
            preview_width: 1000, preview_height: 1000, is_video: false, is_video_poster: false }],
          overflow_count: 0,
        }),
      });
      // Ten 120px words: one per line at any column here.
      const tenLines: WordWidths = {
        title: [],
        preview: Array.from({ length: 10 }, () => 120),
        titleSpace: 4,
        previewSpace: 4,
        titleNoSpaceBefore: [],
        previewNoSpaceBefore: Array.from({ length: 10 }, () => false),
      };
      fetchWordWidthsMock.mockImplementation(async () => new Map([[70, tenLines]]));
      const wideColumn = getMasonryColumnWidth(WIDE, COLUMN_MIN_WIDTH, DEFAULT_GAP);
      const narrowColumn = getMasonryColumnWidth(NARROW, COLUMN_MIN_WIDTH, DEFAULT_GAP);
      expect(wideColumn).toBeGreaterThanOrEqual(COLUMN_MIN_WIDTH);
      expect(narrowColumn).toBeLessThan(COLUMN_MIN_WIDTH);

      render(<Grid {...BASE_PROPS} blocks={[post]} currentTag="narrow-text" />);
      await flush();

      const item = () =>
        document.querySelector<HTMLElement>('[data-feed-grid-item-slug="block-70"]');
      const textClamp = () =>
        Array.from(item()?.querySelectorAll("p") ?? [])
          .find((p) => p.textContent === "Ten long words")
          ?.className.match(/line-clamp-\d+/)?.[0];
      expect(item()?.style.height).toBe(`${computeCardHeight(post, wideColumn, tenLines, "cards")}px`);
      expect(textClamp()).toBe("line-clamp-3");

      await act(async () => {
        resizable.resize(NARROW);
        await Promise.resolve();
        await Promise.resolve();
      });
      await flush();
      expect(item()?.style.height).toBe(`${computeCardHeight(post, narrowColumn, tenLines, "cards")}px`);
      expect(textClamp()).toBe("line-clamp-2");

      await act(async () => {
        resizable.resize(WIDE);
        await Promise.resolve();
        await Promise.resolve();
      });
      await flush();
      expect(item()?.style.height).toBe(`${computeCardHeight(post, wideColumn, tenLines, "cards")}px`);
      expect(textClamp()).toBe("line-clamp-3");
    } finally {
      window.localStorage.clear();
      reloadFeedDisplay();
      resizable.restore();
    }
  });
});
