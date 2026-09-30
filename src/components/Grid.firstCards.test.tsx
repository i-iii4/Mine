// The first-cards startup milestone (SPEC_AUDIT_FIXES.md, А8.2).
//
// The milestone waits for cards with their content, not for the skeletons
// painted while word widths are measured. Isolated in its own file: the
// "cards rendered" signal is once per app session, so each test file gets a
// fresh one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

const { fetchWordWidthsMock } = vi.hoisted(() => ({
  fetchWordWidthsMock: vi.fn<(blocks: LightBlock[]) => Promise<Map<number, WordWidths>>>(),
}));

vi.mock("@/lib/fontMetrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fontMetrics")>();
  return { ...actual, fetchWordWidths: fetchWordWidthsMock };
});

const { cardsRenderedReports } = vi.hoisted(() => ({ cardsRenderedReports: vi.fn() }));

// Counts every report while keeping the real once-per-session signal.
vi.mock("@/lib/startup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/startup")>();
  return {
    ...actual,
    reportCardsRendered: () => {
      cardsRenderedReports();
      actual.reportCardsRendered();
    },
  };
});

import { Grid } from "./Grid";
import { whenCardsRendered } from "@/lib/startup";

function makeBlock(id: number): LightBlock {
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
  };
}

const EMPTY_WIDTHS: WordWidths = {
  title: [],
  preview: [],
  titleSpace: 0,
  previewSpace: 0,
};

class FiringResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element): void {
    const contentRect = { width: 400, height: 800, top: 0, left: 0, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRectReadOnly;
    this.cb([{ target: el, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
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

let previousObserver: typeof ResizeObserver;

beforeEach(() => {
  previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  globalThis.ResizeObserver = previousObserver;
  vi.restoreAllMocks();
});

async function frames(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  });
}

describe("first cards painted (А8.2)", () => {
  it("waits for cards with their content, not for skeletons", async () => {
    let finish: (widths: Map<number, WordWidths>) => void = () => undefined;
    fetchWordWidthsMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let rendered = false;
    void whenCardsRendered().then(() => { rendered = true; });

    render(<Grid {...BASE_PROPS} blocks={[makeBlock(1), makeBlock(2)]} currentTag="first" />);
    await frames();
    expect(rendered).toBe(false);

    await act(async () => { finish(new Map([[1, EMPTY_WIDTHS], [2, EMPTY_WIDTHS]])); });
    await frames();
    expect(rendered).toBe(true);
  });

  it("does not count an empty feed as painted while the first index runs (Б5.4)", async () => {
    cardsRenderedReports.mockClear();
    const props = { ...BASE_PROPS, blocks: [], routeSnapshotReady: true };

    // A new space: the snapshot is empty and the first index has begun, its
    // progress not yet reported.
    const { rerender } = render(<Grid {...props} vaultIndexing firstIndexProgress={null} />);
    await frames();
    expect(cardsRenderedReports).not.toHaveBeenCalled();

    rerender(<Grid {...props} vaultIndexing firstIndexProgress={{ processed: 3, total: 10 }} />);
    await frames();
    expect(cardsRenderedReports).not.toHaveBeenCalled();

    // The index finished and found nothing: the empty feed is the picture.
    rerender(<Grid {...props} vaultIndexing={false} firstIndexProgress={null} />);
    await frames();
    expect(cardsRenderedReports).toHaveBeenCalledTimes(1);

    rerender(<Grid {...props} vaultIndexing={false} firstIndexProgress={null} spaceOnboardingOwed={false} />);
    await frames();
    expect(cardsRenderedReports).toHaveBeenCalledTimes(1);
  });

  it("introduces the clipper only once an empty feed is final, not while the index may fill it (В5.6)", async () => {
    cardsRenderedReports.mockClear();
    fetchWordWidthsMock.mockResolvedValue(new Map([[7, EMPTY_WIDTHS]]));
    const props = {
      ...BASE_PROPS,
      routeSnapshotReady: true,
      spaceOnboardingOwed: true,
      onInstallClipper: vi.fn(),
      firstIndexProgress: null,
    };
    const onboarding = () => document.querySelector("[data-empty-space-onboarding]");

    // The index is over but the feed on screen was read before it: still
    // counted as indexing, so the old empty snapshot introduces nothing.
    const { rerender } = render(<Grid {...props} blocks={[]} vaultIndexing />);
    await frames();
    expect(onboarding()).toBeNull();
    expect(cardsRenderedReports).not.toHaveBeenCalled();

    // Read again, it holds the index's cards: they are the first picture.
    rerender(<Grid {...props} blocks={[makeBlock(7)]} vaultIndexing={false} />);
    await frames();
    expect(onboarding()).toBeNull();
    // The widths land within those frames; the mark follows two frames later.
    await frames();
    expect(cardsRenderedReports).toHaveBeenCalledTimes(1);
  });

  it("introduces the clipper and marks once when the re-read after the index is empty (В5.6)", async () => {
    cardsRenderedReports.mockClear();
    const props = {
      ...BASE_PROPS,
      blocks: [],
      routeSnapshotReady: true,
      spaceOnboardingOwed: true,
      onInstallClipper: vi.fn(),
      firstIndexProgress: null,
    };
    const onboarding = () => document.querySelector("[data-empty-space-onboarding]");

    const { rerender } = render(<Grid {...props} vaultIndexing />);
    await frames();
    expect(onboarding()).toBeNull();
    expect(cardsRenderedReports).not.toHaveBeenCalled();

    rerender(<Grid {...props} vaultIndexing={false} />);
    await frames();
    expect(onboarding()).not.toBeNull();
    expect(cardsRenderedReports).toHaveBeenCalledTimes(1);
  });
});
