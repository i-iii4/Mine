// The collection's content of the sidebar's preview window (SPEC_CARD_STATES.md,
// С7.12): what it holds, how many rows it takes, and how it is drawn.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SIDEBAR_PREVIEW_TILE_GAP_PX } from "@/lib/appLayout";
import { thumbnailUrlAtLevel } from "@/lib/assets";
import { EDGE_TEXT_SIDE_PX } from "@/lib/cardTypography";
import type { PreviewCard } from "@/types";
import {
  COLLECTION_PREVIEW_MAX_CARDS,
  CollectionHoverPreview,
  collectionCountLabel,
  collectionPreviewContent,
  collectionPreviewRows,
} from "./CollectionHoverPreview";

function cards(count: number, hasThumb = true): PreviewCard[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `card-${index}`,
    url: `asset://localhost/thumbs/card-${index}.micro.jpg?m=${index + 1}`,
    text: index === 1,
    hasThumb,
  }));
}

const base = { rowKey: "tag:alpha", name: "alpha", previewsPending: false };

describe("what a collection's window holds", () => {
  it("holds the first nine cards with a thumbnail, in the strip's order", () => {
    const list = cards(12);
    const content = collectionPreviewContent({ ...base, count: 12, cards: list });
    expect(content?.cards.map((card) => card.slug)).toEqual(list.slice(0, COLLECTION_PREVIEW_MAX_CARDS).map((card) => card.slug));
    expect(content?.placeholders).toBe(0);
    expect(content && collectionPreviewRows(content)).toBe(3);
  });

  it.each([[1, 1], [3, 1], [4, 2], [6, 2], [7, 3], [9, 3]])("takes fewer rows for fewer cards: %i cards, %i rows", (count, rows) => {
    const content = collectionPreviewContent({ ...base, count, cards: cards(count) });
    expect(content && collectionPreviewRows(content)).toBe(rows);
  });

  it("does not open over an empty collection", () => {
    expect(collectionPreviewContent({ ...base, count: 0, cards: [] })).toBeNull();
    expect(collectionPreviewContent({ ...base, count: 0, cards: undefined })).toBeNull();
    // Cards, none with a thumbnail yet, once the space's previews are built.
    expect(collectionPreviewContent({ ...base, count: 3, cards: cards(3, false) })).toBeNull();
  });

  it("holds the strip's placeholders until the read answers and while previews are built (SPEC_SIDEBAR_STRIP.md, ЛМ3)", () => {
    expect(collectionPreviewContent({ ...base, count: 20, cards: undefined })).toMatchObject({ cards: [], placeholders: 9 });
    expect(collectionPreviewContent({ ...base, count: 2, cards: undefined })).toMatchObject({ placeholders: 2 });
    expect(collectionPreviewContent({ ...base, count: 20, cards: cards(4), previewsPending: true })).toMatchObject({ placeholders: 5 });
  });

  it("writes the count with the product's word for a card", () => {
    expect(collectionCountLabel(1)).toBe("1 element");
    expect(collectionCountLabel(12)).toBe("12 elements");
  });
});

describe("how a collection's window is drawn", () => {
  it("draws the grid three across, the strip's gap apart, 8 px in, under it the whole name and the count", () => {
    const longName = "A collection whose name is far longer than any row of the sidebar could ever show";
    const content = collectionPreviewContent({ ...base, name: longName, count: 12, cards: cards(12) });
    const { container } = render(<CollectionHoverPreview content={content!} width={240} />);
    const frame = container.querySelector<HTMLElement>("[data-feed-card-frame]");
    expect(frame).toHaveAttribute("data-collection-preview", "tag:alpha");
    expect(frame?.style.width).toBe("240px");
    const grid = container.querySelector<HTMLElement>("[data-collection-preview-grid]")!;
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(grid.style.gap).toBe(`${SIDEBAR_PREVIEW_TILE_GAP_PX}px`);
    expect(grid.style.paddingLeft).toBe(`${EDGE_TEXT_SIDE_PX}px`);
    expect(grid.style.paddingTop).toBe(`${EDGE_TEXT_SIDE_PX}px`);
    expect(container.querySelectorAll('[data-collection-preview-tile="card"]')).toHaveLength(9);
    const name = container.querySelector("[data-collection-preview-name]");
    expect(name).toHaveTextContent(longName);
    expect(name?.className).not.toMatch(/line-clamp|truncate/);
    expect(container.querySelector("[data-collection-preview-count]")).toHaveTextContent("12 elements");
    // No buttons: it only shows.
    expect(container.querySelector("button, a")).toBeNull();
  });

  it("draws each card's tile as the strip's, at the level its size needs", () => {
    const list = cards(2);
    const content = collectionPreviewContent({ ...base, count: 2, cards: list });
    const { container } = render(<CollectionHoverPreview content={content!} width={240} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images.map((image) => image.getAttribute("src"))).toEqual(list.map((card) => thumbnailUrlAtLevel(card.url, "zoom")));
    expect(images[0]?.getAttribute("src")).toBe("asset://localhost/thumbs/card-0.zoom.jpg?m=1");
    // Loaded at once: the window lays its next content out unseen and waits for it.
    expect(images.every((image) => image.getAttribute("loading") === null)).toBe(true);
    expect(images[0]?.className).toContain("object-cover");
    // A text card's ink inverts in the dark theme, as on the strip.
    expect(images[1]?.className).toContain("dark:invert");
    for (const tile of container.querySelectorAll("[data-collection-preview-tile]")) {
      expect(tile).toHaveAttribute("data-thumb-edge");
      expect(tile.className).toContain("aspect-square");
    }
  });

  it("fills the places of cards on the way with the strip's placeholder", () => {
    const content = collectionPreviewContent({ ...base, count: 5, cards: cards(2), previewsPending: true });
    const { container } = render(<CollectionHoverPreview content={content!} width={240} />);
    const placeholders = container.querySelectorAll('[data-collection-preview-tile="placeholder"]');
    expect(placeholders).toHaveLength(3);
    expect(placeholders[0]?.className).toContain("bg-accent");
  });
});

describe("a thumbnail's address at another level", () => {
  it("swaps the level and keeps the version marks", () => {
    expect(thumbnailUrlAtLevel("asset://localhost/t/a.micro.jpg?v=3", "zoom")).toBe("asset://localhost/t/a.zoom.jpg?v=3");
    expect(thumbnailUrlAtLevel("asset://localhost/t/a.micro.jpg", "zoom")).toBe("asset://localhost/t/a.zoom.jpg");
    expect(thumbnailUrlAtLevel("asset://localhost/t/a.zoom.jpg?m=2", "micro")).toBe("asset://localhost/t/a.micro.jpg?m=2");
  });
});
