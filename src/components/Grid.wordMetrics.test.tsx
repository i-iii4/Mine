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

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
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
    feed_playback: null,
    ...overrides,
  };
}

const EMPTY_WIDTHS: WordWidths = {
  title: [],
  preview: [],
  titleSpace: 0,
  previewSpace: 0,
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
    private el: Element | null = null;
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element): void {
      this.el = el;
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
  onDeleteSelectedBlocks: vi.fn(),
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
});
