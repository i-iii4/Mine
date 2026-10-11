import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { MicroPreviewThumbnail, microPreviewFromIndexedBlock } from "./MicroPreviewThumbnail";

const pageEvents = vi.hoisted(() => ({
  listeners: [] as Array<{ event: string; handler: (event: { payload: unknown }) => void }>,
  unlisten: vi.fn(),
}));

vi.mock("@/lib/pageEvents", () => ({
  listenPage: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    pageEvents.listeners.push({ event, handler });
    return pageEvents.unlisten;
  }),
}));

function announceThumbUpdated(slug: string) {
  act(() => {
    for (const listener of pageEvents.listeners) {
      if (listener.event === "thumb:updated") listener.handler({ payload: { path: "/vault", slug } });
    }
  });
}

const THUMBS = "/tmp/thumbs";

describe("microPreviewFromIndexedBlock", () => {
  it("keeps hasThumb true when thumb_format is momentarily null after a fresh clip", () => {
    // thumb_format is null in the window between indexing and async thumb
    // generation, but the thumb file (or its placeholder) exists. The preview
    // must still attempt the image instead of hiding an already-present
    // thumbnail; the consumer's onError covers the rare missing-file case.
    const preview = microPreviewFromIndexedBlock(
      { slug: "fresh-clip", thumb_format: null, thumb_mtime: 0, preview_manifest: null },
      THUMBS,
    );
    expect(preview.hasThumb).toBe(true);
    expect(preview.url).toContain("fresh-clip");
  });

  it("detects a text thumb from preview_manifest, not the volatile thumb_format", () => {
    // preview_manifest is stable across the indexing→thumb-generation window,
    // so it — not the briefly-null thumb_format — drives the dark:invert flag.
    const preview = microPreviewFromIndexedBlock(
      {
        slug: "text-article",
        thumb_format: null,
        thumb_mtime: 0,
        preview_manifest: JSON.stringify({ kind: "text", width: 1, height: 1, tiles: [] }),
      },
      THUMBS,
    );
    expect(preview.text).toBe(true);
  });

  it("falls back to thumb_format for legacy blocks without a manifest", () => {
    const media = microPreviewFromIndexedBlock(
      { slug: "legacy-media", thumb_format: "jpeg", thumb_mtime: 5, preview_manifest: null },
      THUMBS,
    );
    expect(media.text).toBe(false);

    const text = microPreviewFromIndexedBlock(
      { slug: "legacy-text", thumb_format: "png", thumb_mtime: 5, preview_manifest: null },
      THUMBS,
    );
    expect(text.text).toBe(true);
  });
});

describe("MicroPreviewThumbnail", () => {
  const textPreview = { slug: "note", url: "/thumbs/note.png", text: true, hasThumb: true };
  const mediaPreview = { slug: "photo", url: "/thumbs/photo.jpg", text: false, hasThumb: true };

  it("brings a text thumb's card fill in with its ink, not before it", () => {
    const { container } = render(<MicroPreviewThumbnail preview={textPreview} />);
    const fill = container.querySelector("[data-micro-preview-state]") as HTMLElement;

    // While the picture decodes the slot keeps the caller's own fill; an early
    // card fill would read as a blank tile.
    expect(fill).toHaveAttribute("data-micro-preview-state", "loading");
    expect(fill).not.toHaveClass("bg-card");

    fireEvent.load(container.querySelector("img") as HTMLImageElement);

    expect(fill).toHaveAttribute("data-micro-preview-state", "loaded");
    expect(fill).toHaveClass("bg-card");
  });

  it("never gives a media thumb a card fill", () => {
    const { container } = render(<MicroPreviewThumbnail preview={mediaPreview} />);
    const fill = container.querySelector("[data-micro-preview-state]") as HTMLElement;

    fireEvent.load(container.querySelector("img") as HTMLImageElement);

    expect(fill).toHaveAttribute("data-micro-preview-state", "loaded");
    expect(fill).not.toHaveClass("bg-card");
  });

  it("still calls the caller's own load handler", () => {
    const onLoad = vi.fn();
    const { container } = render(<MicroPreviewThumbnail preview={textPreview} onLoad={onLoad} />);

    fireEvent.load(container.querySelector("img") as HTMLImageElement);

    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});

describe("MicroPreviewThumbnail without its file", () => {
  const mediaPreview = { slug: "photo", url: "/thumbs/photo.micro.jpg", text: false, hasThumb: true };
  const textPreview = { slug: "note", url: "/thumbs/note.micro.jpg", text: true, hasThumb: true };

  beforeEach(() => {
    pageEvents.listeners.length = 0;
    pageEvents.unlisten.mockClear();
  });

  it("keeps the loading fill instead of the browser's broken-image icon", () => {
    const { container } = render(<MicroPreviewThumbnail preview={textPreview} />);
    const slot = container.querySelector("[data-micro-preview-state]") as HTMLElement;

    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    // No image element is left to draw the icon, and the slot carries neither
    // the card fill nor anything else the loading state does not.
    expect(container.querySelector("img")).toBeNull();
    expect(slot).toHaveAttribute("data-micro-preview-state", "missing");
    expect(slot).not.toHaveClass("bg-card");
  });

  it("loads again when this card's preview is ready, and not for another card", async () => {
    const { container } = render(<MicroPreviewThumbnail preview={mediaPreview} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    await act(async () => {});

    announceThumbUpdated("another-card");
    expect(container.querySelector("img")).toBeNull();

    announceThumbUpdated("photo");
    const image = container.querySelector("img") as HTMLImageElement;
    expect(image).not.toBeNull();
    // A new address: the browser asks the file again rather than repeating
    // the failure from its memory cache.
    expect(image.getAttribute("src")).toBe("/thumbs/photo.micro.jpg?retry=1");

    fireEvent.load(image);
    const slot = container.querySelector("[data-micro-preview-state]") as HTMLElement;
    expect(slot).toHaveAttribute("data-micro-preview-state", "loaded");
    // The wait ends with the failure: nothing listens any more.
    expect(pageEvents.unlisten).toHaveBeenCalledTimes(1);
  });

  it("loads again when the caller cache-busts the address", () => {
    const { container, rerender } = render(<MicroPreviewThumbnail preview={mediaPreview} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();

    // The sidebar bumps its own `?v=` on `thumb:updated`.
    rerender(<MicroPreviewThumbnail preview={{ ...mediaPreview, url: `${mediaPreview.url}?v=1` }} />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/thumbs/photo.micro.jpg?v=1");
  });
});
