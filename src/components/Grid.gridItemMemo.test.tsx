// GridItem memo-boundary test.
//
// The visible GridItem wraps a memoized <Card>. If GridItem hands Card a fresh
// dragBlocks array or a fresh inline callback on every render, Card's memo is
// defeated and unrelated Cards re-render whenever gridContext identity changes
// (for example when keyboard focus moves between two other cards). This test
// mocks Card with a per-slug render counter and asserts that moving focus does
// not re-render a Card that was neither focused before nor after.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { LightBlock } from "@/types";

const { cardRenderCounts } = vi.hoisted(() => ({
  cardRenderCounts: new Map<string, number>(),
}));

vi.mock("./Card", async () => {
  const React = await import("react");
  const Card = React.memo(function MockCard(props: { block: { slug: string } }) {
    cardRenderCounts.set(
      props.block.slug,
      (cardRenderCounts.get(props.block.slug) ?? 0) + 1,
    );
    return React.createElement("div", {
      "data-block-slug": props.block.slug,
      "data-mock-card": "",
    });
  });
  const CardSkeleton = function MockCardSkeleton(props: { block: { slug: string } }) {
    return React.createElement("div", {
      "data-block-slug": props.block.slug,
      "data-mock-skeleton": "",
    });
  };
  return { Card, CardSkeleton };
});

import { Grid } from "./Grid";

function makeImageBlock(id: number): LightBlock {
  return {
    id,
    slug: `block-${id}`,
    block_type: "image",
    card_kind: "media",
    title: `Block ${id}`,
    url: null,
    media_file: `image-${id}.jpg`,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: 1000,
    height: 1000,
    author: null,
    body: `Body ${id}`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
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
    feed_playback: null,
    tags: ["test"],
  } as LightBlock;
}

// ─── Environment mocks (mirrors Grid.test.tsx) ──────────────────────────────

let mockViewport = { width: 280, height: 2000 };
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
  onBlockClick: vi.fn(),
  onToggleTag: vi.fn(),
  onCreateAndAssign: vi.fn(),
  onLoadBlockTags: vi.fn(async (slugs: string[]) => new Map(slugs.map((s) => [s, ["test"]]))),
  onBatchSetTag: vi.fn(),
  onCreateAndAssignBatch: vi.fn(),
  onDeleteSelectedBlocks: vi.fn(),
  onMergeSelectedBlocks: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

beforeEach(() => {
  cardRenderCounts.clear();
  mockViewport = { width: 280, height: 2000 };
  resizeObservers.clear();
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = vi.fn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GridItem — Card memo boundary", () => {
  it("does not re-render an unrelated Card when keyboard focus moves between other cards", async () => {
    const blocks = [
      makeImageBlock(1),
      makeImageBlock(2),
      makeImageBlock(3),
      makeImageBlock(4),
    ];

    // Focus block-1 via restoreFocus; this also enters keyboard interaction
    // mode, flipping hoverEnabled for every card. Establish the baseline AFTER
    // that so the later focus move is the only variable.
    const { rerender } = render(
      <Grid
        {...BASE_PROPS}
        blocks={blocks}
        currentTag="memo-test"
        restoreFocusSlug="block-1"
        restoreFocusSequence={1}
      />,
    );
    await flushAsync();

    const baseline = cardRenderCounts.get("block-4") ?? 0;
    expect(baseline).toBeGreaterThan(0);

    // Move keyboard focus from block-1 to block-2. gridContext identity changes
    // (focusedSlug), so every GridItem re-renders — but block-4's Card props are
    // all referentially stable, so its memoized Card must be skipped.
    await act(async () => {
      rerender(
        <Grid
          {...BASE_PROPS}
          blocks={blocks}
          currentTag="memo-test"
          restoreFocusSlug="block-2"
          restoreFocusSequence={2}
        />,
      );
    });
    await flushAsync();

    expect(cardRenderCounts.get("block-4")).toBe(baseline);
  });
});
