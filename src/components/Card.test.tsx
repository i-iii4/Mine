import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Card, DragCardStackPreview, ReadOnlyCardPreview } from "./Card";
import { CARD_HOVER_ACTION_MIN_HEIGHT } from "@/lib/cardHeight";
import type { LightBlock } from "@/types";

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => ({ tags: [] })),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

function cardKindForBlockType(blockType: LightBlock["block_type"]): LightBlock["card_kind"] {
  return blockType === "article"
    ? "article"
    : blockType === "channel"
      ? "channel"
      : "media";
}

function block(overrides: Partial<LightBlock> = {}): LightBlock {
  const blockType = overrides.block_type ?? "link";
  const cardKind = overrides.card_kind ?? cardKindForBlockType(blockType);
  return {
    id: 1,
    slug: "test-block",
    card_kind: cardKind,
    block_type: blockType,
    title: "Test Block",
    description: "A test block",
    url: "https://example.com",
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
    width: null,
    height: null,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    tags: ["test"],
    ...overrides,
  };
}

const VAULT = "/tmp/test-vault";

describe("Card", () => {
  it("renders as a clickable button", () => {
    const onClick = vi.fn();
    render(<Card block={block()} vaultPath={VAULT} onClick={onClick} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    const b = block();
    render(<Card block={b} vaultPath={VAULT} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledWith(b);
  });

  it("calls onClick on Enter key", () => {
    const onClick = vi.fn();
    const b = block();
    render(<Card block={b} vaultPath={VAULT} onClick={onClick} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
    expect(onClick).toHaveBeenCalledWith(b);
  });

  it("calls onClick on Space key", () => {
    const onClick = vi.fn();
    const b = block();
    render(<Card block={b} vaultPath={VAULT} onClick={onClick} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: " " });
    expect(onClick).toHaveBeenCalledWith(b);
  });

  it("renders pure text micro previews without a baked thumbnail image", () => {
    const { container } = render(
      <ReadOnlyCardPreview
        block={{
          ...block({
            block_type: "article",
            card_kind: "article",
            title: null,
            author: "@fish_elysium",
            body: "Авторка задает хороший вопрос",
            preview_text: "Авторка задает хороший вопрос",
            preview_manifest: JSON.stringify({
              kind: "text",
              primary_preview_path: null,
              width: null,
              height: null,
              tiles: [],
              overflow_count: 0,
            }),
          }),
          thumb_format: "png",
          thumb_mtime: 123,
        }}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
        previewMode="micro"
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Авторка задает хороший вопрос")).toBeInTheDocument();
    expect(screen.getByText("by @fish_elysium")).toBeInTheDocument();
  });

  it("does not open the card when a nested hover action receives keyboard input", () => {
    const onClick = vi.fn();
    render(
      <Card
        block={block()}
        vaultPath={VAULT}
        onClick={onClick}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const sourceAction = screen
      .getAllByRole("button", { name: /Source/ })
      .find((button) => button.tagName === "BUTTON");
    expect(sourceAction).toBeDefined();

    fireEvent.keyDown(sourceAction!, { key: "Enter" });

    expect(onClick).not.toHaveBeenCalled();
  });

  it("enforces the minimum height needed for hover actions", () => {
    render(<Card block={block()} vaultPath={VAULT} onClick={vi.fn()} />);
    const card = screen.getByRole("button");
    expect(card).toHaveStyle({
      minHeight: `${CARD_HOVER_ACTION_MIN_HEIGHT}px`,
    });
    expect(card).not.toHaveClass("hover:border-component-fill-hover");
    expect(card).not.toHaveClass("transition-colors");
  });

  it("publishes the selected drag group on the draggable card", () => {
    const alpha = block({ slug: "alpha" });
    const beta = block({ slug: "beta" });
    render(
      <Card
        block={alpha}
        dragBlocks={[alpha, beta]}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    const card = screen.getByRole("button");
    expect(card).toHaveAttribute("data-feed-card-drag-count", "2");
    expect(card).toHaveAttribute("data-feed-card-drag-slugs", "alpha beta");
  });

  it("renders selected drags as a bounded macOS-style stack preview", () => {
    const blocks = [
      block({ slug: "front", block_type: "image", media_file: "front.jpg" }),
      block({ slug: "second", block_type: "image", media_file: "second.jpg" }),
      block({ slug: "third", block_type: "image", media_file: "third.jpg" }),
      block({ slug: "fourth", block_type: "image", media_file: "fourth.jpg" }),
      block({ slug: "fifth", block_type: "image", media_file: "fifth.jpg" }),
    ];

    const { container } = render(
      <DragCardStackPreview
        blocks={blocks}
        vaultPath={VAULT}
      />,
    );

    const stack = container.querySelector("[data-feed-drag-stack]");
    expect(stack).toHaveAttribute("data-feed-drag-stack-count", "5");
    expect(stack).toHaveAttribute("data-feed-drag-stack-visible-count", "4");
    expect(container.querySelectorAll("[data-feed-drag-stack-layer]")).toHaveLength(4);
    expect(
      Array.from(container.querySelectorAll("[data-feed-drag-stack-layer]"))
        .map((node) => node.getAttribute("data-feed-drag-stack-layer-index")),
    ).toEqual(["3", "2", "1", "0"]);

    const layers = Array.from(container.querySelectorAll<HTMLElement>("[data-feed-drag-stack-layer]"));
    const backLayers = layers.filter(
      (layer) => layer.getAttribute("data-feed-drag-stack-layer-index") !== "0",
    );
    expect(container.querySelector("[data-feed-drag-stack-plate]")).toBeNull();
    expect(container.querySelectorAll("[data-feed-drag-stack-card]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-feed-drag-stack-card] img")).toHaveLength(4);
    expect(container.querySelectorAll("[data-feed-drag-stack-front] img")).toHaveLength(1);
    expect(container.querySelectorAll("[data-feed-drag-stack] img")).toHaveLength(4);
    expect(screen.getByText("5")).toHaveAttribute("data-feed-drag-stack-count-badge");

    for (const layer of backLayers) {
      expect(layer.style.transform).toMatch(
        /^translate3d\(-?\d+px, -?\d+px, 0\) rotate\(-?\d+(\.\d+)?deg\)$/,
      );
      expect(layer.style.transform).not.toContain("scale");
    }
    expect(
      layers.find((layer) => layer.getAttribute("data-feed-drag-stack-layer-index") === "0")
        ?.style.transform,
    ).toBe("");
  });

  it("marks real graphic surfaces without adding a focus prop to Card", () => {
    const { container, rerender } = render(
      <Card
        block={block({ block_type: "image", media_file: "sunset.jpg" })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    const graphicSurface = container.querySelector("[data-card-graphic-surface]");
    expect(graphicSurface).toBeInTheDocument();
    expect(graphicSurface?.querySelector("img")).toBeInTheDocument();
    expect(screen.getByRole("button")).not.toHaveAttribute("data-feed-card-focused");

    rerender(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          body: "Only text",
          first_image: null,
          media_urls: null,
          thumbnail: null,
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    expect(container.querySelector("[data-card-graphic-surface]")).toBeNull();
  });

  // ── Image card ────────────────────────────────────────────────────────

  it("prefers the source media file over the cached thumbnail", () => {
    // Source-first cascade: the vault-side media file is always on disk
    // by the time a block is indexed, while the thumb may still be in
    // background generation. Using source first avoids the
    // broken-image flash that used to appear between save and
    // thumb-ready.
    const b = block({
      block_type: "image",
      media_file: "sunset.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).not.toHaveClass("feed-article-card");
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", expect.stringContaining("sunset.jpg"));
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).not.toHaveAttribute("src", expect.stringContaining("/.arena/cache/thumbs/"));
  });

  it("falls through to the cached thumbnail when the source media load fails", () => {
    const b = block({
      block_type: "image",
      media_file: "sunset.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const img = screen.getByRole("img");
    fireEvent.error(img);
    const fallback = screen.getByRole("img");
    expect(fallback).toHaveAttribute(
      "src",
      expect.stringContaining("/.arena/cache/thumbs/test-block.jpg"),
    );
  });

  it("renders image card alt text from the title", () => {
    const b = block({ block_type: "image", title: "Sunset", media_file: "sunset.jpg" });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Sunset");
  });

  it("sizes image cards from media_dimensions without letterboxing", () => {
    const b = block({
      block_type: "image",
      title: "Wide Screenshot",
      media_file: "wide-screenshot.jpg",
      width: 4036,
      height: 2578,
      media_dimensions: "{\"wide-screenshot.jpg\":[2880,980]}",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveClass("object-cover");
  });

  it("renders broken image fallback after every source in the cascade fails", () => {
    // Exhaust the whole cascade: source → thumb → fallback text card.
    // Each onError bumps the internal index; once every candidate is
    // spent the text-plus-icon placeholder takes over.
    const b = block({
      block_type: "image",
      media_file: "missing.jpg",
      title: "Missing Image",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    fireEvent.error(screen.getByRole("img"));
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByText("Missing Image")).toBeInTheDocument();
  });

  // ── Link card ─────────────────────────────────────────────────────────

  it("renders link card with title and domain", () => {
    const b = block({
      block_type: "link",
      title: "Example Site",
      url: "https://www.example.com/page",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("Example Site")).toBeInTheDocument();
    // Domain appears twice: in the color placeholder and below the title
    const domains = screen.getAllByText("example.com");
    expect(domains.length).toBeGreaterThanOrEqual(1);
  });

  it("renders link card with slug when no title", () => {
    const b = block({ block_type: "link", title: null });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("test-block")).toBeInTheDocument();
  });

  it("renders compact link card when thumbnail fails to load", () => {
    const b = block({
      block_type: "link",
      title: "No Image Site",
      url: "https://noimage.example.com",
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    // Trigger image error on the hidden thumbnail
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    // Should show compact card without the color placeholder
    expect(screen.getByText("No Image Site")).toBeInTheDocument();
    expect(screen.getByText("noimage.example.com")).toBeInTheDocument();
    // The img element should be gone (compact card has no image)
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-card-graphic-surface]")).toBeNull();
  });

  // ── Article card ──────────────────────────────────────────────────────

  it("renders article card with title and body preview", () => {
    const b = block({
      block_type: "article",
      title: "My Article",
      body: "This is a long article body text for testing.",
      author: "Author Name",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveClass("feed-article-card");
    expect(screen.getByText("My Article")).toBeInTheDocument();
    expect(
      screen.getByText("This is a long article body text for testing."),
    ).toBeInTheDocument();
    expect(screen.getByText("Author Name")).toBeInTheDocument();
  });

  it("renders article media above the full text stack", () => {
    const b = block({
      block_type: "article",
      title: "My Article",
      body: "This is a long article body text for testing.",
      author: "Author Name",
      first_image: "hero.jpg",
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const media = container.querySelector("img");
    const title = screen.getByText("My Article");
    const preview = screen.getByText("This is a long article body text for testing.");
    const author = screen.getByText("Author Name");
    expect(media).toBeTruthy();
    expect(media!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(author) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("article card hides author when absent", () => {
    const b = block({
      block_type: "article",
      title: "No Author Article",
      body: "Body text",
      author: null,
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(screen.getByText("No Author Article")).toBeInTheDocument();
    // The article card renders author in a separate <p> with specific class
    // When author is null, that <p> should not exist
    const paragraphs = container.querySelectorAll("p");
    // Should only have title and body, no author paragraph
    const authorP = Array.from(paragraphs).find(
      (p) => p.classList.contains("mt-2") && p.classList.contains("text-sm"),
    );
    expect(authorP).toBeUndefined();
  });

  it("renders article multi-image preview as a tiled gallery without a counter", () => {
    const b = block({
      block_type: "article",
      title: "Gallery Article",
      body: "One",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test-block.jpg",
        width: 1,
        height: 1,
        tiles: [
          { source_path: "a.webp", preview_path: "a.jpg", width: 800, height: 600, is_video: false, is_video_poster: false },
          { source_path: "b.png", preview_path: "b.jpg", width: 600, height: 800, is_video: false, is_video_poster: false },
          { source_path: "c.heic", preview_path: "c.jpg", width: 900, height: 900, is_video: false, is_video_poster: false },
        ],
        overflow_count: 2,
      }),
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(3);
    expect(images[0]?.getAttribute("src")).toContain("/a.webp");
    expect(images[1]?.getAttribute("src")).toContain("/b.png");
    expect(images[2]?.getAttribute("src")).toContain("/c.heic");
    expect(screen.queryByText("+2")).not.toBeInTheDocument();
  });

  it("renders legacy article multi-image previews from source images when preview_manifest is missing", () => {
    const b = block({
      block_type: "article",
      title: "Legacy Gallery Article",
      body: "![](img0.webp)\n![](img1.webp)",
      first_image: "img0.webp",
      media_urls: "[\"img0.webp\",\"img1.webp\"]",
      media_dimensions: "{\"img0.webp\":[1960,1307],\"img1.webp\":[1960,1307]}",
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toContain("/img0.webp");
    expect(images[1]?.getAttribute("src")).toContain("/img1.webp");
  });

  it("falls back to distinct source images when social gallery tiles have no preview assets", () => {
    const b = block({
      block_type: "article",
      url: "https://x.com/a/status/1",
      author: "@artist",
      body: "![](img0.jpg)\n![](img1.jpg)\n![](img2.jpg)\n![](img3.jpg)",
      media_urls: "[\"img0.jpg\",\"img1.jpg\",\"img2.jpg\",\"img3.jpg\"]",
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(4);
    expect(images[0]?.getAttribute("src")).toContain("/img0.jpg");
    expect(images[1]?.getAttribute("src")).toContain("/img1.jpg");
    expect(images[2]?.getAttribute("src")).toContain("/img2.jpg");
    expect(images[3]?.getAttribute("src")).toContain("/img3.jpg");
  });

  it("does not add a phantom top gap before social media when top content is absent", () => {
    const b = block({
      block_type: "article",
      url: "https://instagram.com/p/1",
      author: "@sorochii_",
      body: "![](photo-a.jpg)\n![](photo-b.jpg)",
      media_urls: "[\"photo-a.jpg\",\"photo-b.jpg\"]",
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const image = container.querySelector("img");
    const mediaWrapper = image?.parentElement?.parentElement ?? null;
    expect(mediaWrapper).toBeTruthy();
    expect(mediaWrapper?.className).not.toContain("mt-3");
    expect(screen.getByText("by @sorochii_")).toBeInTheDocument();
  });

  it("renders social media above text and byline", () => {
    const b = block({
      block_type: "article",
      url: "https://x.com/a/status/1",
      author: "@artist",
      body: "Social preview body text\n![](img0.jpg)",
      media_urls: "[\"img0.jpg\"]",
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const media = container.querySelector("img");
    const preview = screen.getByText("Social preview body text");
    const author = screen.getByText("by @artist");
    expect(media).toBeTruthy();
    expect(media!.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(preview.compareDocumentPosition(author) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders social single-image cards from the source image when preview path is synthetic", () => {
    const b = block({
      block_type: "article",
      slug: "tweet-block",
      url: "https://x.com/a/status/1",
      author: "@artist",
      body: "Preview text",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "tweet-block.jpg",
        width: 1200,
        height: 628,
        tiles: [
          {
            source_path: "tweet-photo.jpg",
            preview_path: "tweet-photo.jpg",
            width: 1200,
            height: 628,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).toHaveAttribute(
      "src",
      expect.stringContaining(`${VAULT}/tweet-photo.jpg`),
    );
  });

  it("renders social preview text with the same article line-height contract", () => {
    const b = block({
      block_type: "article",
      url: "https://x.com/a/status/1",
      body: "Social preview body text",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("Social preview body text")).toHaveStyle({
      lineHeight: "20px",
    });
  });

  // ── Video card ────────────────────────────────────────────────────────

  it("renders video card with autoplay video in feed", () => {
    const b = block({
      block_type: "video",
      title: "Demo Video",
      media_file: "demo.mp4",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test-block.jpg",
        width: 1280,
        height: 720,
        tiles: [
          { src: "demo.mp4", width: 1280, height: 720, is_video: true, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
      feed_playback: JSON.stringify({
        kind: "single_video",
        source_path: "demo.mp4",
        poster_preview_path: "test-block.jpg",
        width: 1280,
        height: 720,
        container: "mp4",
        profile: "standard",
      }),
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeInTheDocument();
    expect(container.querySelector("svg path[d]")).toBeNull();
  });

  it("renders poster-only video cards from preview metadata with play affordance", () => {
    const b = block({
      block_type: "video",
      title: "YouTube Video",
      media_file: "poster.jpg",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test-block.jpg",
        width: 1280,
        height: 720,
        tiles: [
          { source_path: "poster.jpg", preview_path: "test-block.jpg", width: 1280, height: 720, is_video: false, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("svg path[d]")).toBeInTheDocument();
  });

  it("keeps dedicated video cards poster-only when feed_playback is absent", () => {
    const b = block({
      block_type: "video",
      title: "Poster Only Video",
      media_file: "demo.mp4",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test-block.jpg",
        width: 1280,
        height: 720,
        tiles: [
          { src: "demo.mp4", width: 1280, height: 720, is_video: true, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
      feed_playback: null,
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("svg path[d]")).toBeInTheDocument();
  });

  it("uses the playback poster contract for dedicated video poster-only branches", () => {
    const b = block({
      block_type: "video",
      title: "Poster Contract Video",
      media_file: "demo.mp4",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "video-poster.jpg",
        width: 1280,
        height: 720,
        tiles: [
          { src: "demo.mp4", preview_path: "clip-frame.jpg", width: 1280, height: 720, is_video: true, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
      feed_playback: JSON.stringify({
        kind: "single_video",
        source_path: "demo.mp4",
        poster_preview_path: "video-poster.jpg",
        width: 1280,
        height: 720,
        container: "mp4",
        profile: "standard",
      }),
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} allowPlayback={false} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("/video-poster.jpg"),
    );
  });

  it("falls back from missing dedicated video poster preview to the block thumb", () => {
    const b = block({
      block_type: "video",
      title: "Poster Fallback Video",
      media_file: "demo.mp4",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "missing-video-poster.jpg",
        width: 1280,
        height: 720,
        tiles: [
          { src: "demo.mp4", preview_path: "missing-clip-frame.jpg", width: 1280, height: 720, is_video: true, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
      feed_playback: null,
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    fireEvent.error(img!);
    expect(img).toHaveAttribute(
      "src",
      expect.stringContaining(`${VAULT}/.arena/cache/thumbs/test-block.jpg`),
    );
  });

  it("renders article single-video preview as autoplay video in feed", () => {
    const b = block({
      block_type: "article",
      title: "Video Article",
      body: "Body text",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test-block.jpg",
        width: 1280,
        height: 720,
        tiles: [
          { src: "clip.mp4", width: 1280, height: 720, is_video: true, is_video_poster: true },
        ],
        overflow_count: 0,
      }),
      feed_playback: JSON.stringify({
        kind: "single_video",
        source_path: "clip.mp4",
        poster_preview_path: "test-block.jpg",
        width: 1280,
        height: 720,
        container: "mp4",
        profile: "standard",
      }),
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeInTheDocument();
    expect(screen.getByText("Video Article")).toBeInTheDocument();
    expect(container.querySelector("svg path[d]")).toBeNull();
  });

  it("keeps gallery video tiles preview-only and uses block poster fallback", () => {
    const b = block({
      block_type: "article",
      title: "Mixed Gallery",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test-block.jpg",
        width: 1,
        height: 1,
        tiles: [
          { source_path: "clip.mp4", preview_path: "clip.jpg", width: 1280, height: 720, is_video: true, is_video_poster: true },
          { source_path: "still.jpg", preview_path: "still.jpg", width: 1280, height: 720, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeNull();
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toContain("/test-block.jpg");
    expect(images[1]?.getAttribute("src")).toContain("/still.jpg");
  });

  // ── File card ─────────────────────────────────────────────────────────

  it("renders file card with extension badge", () => {
    const b = block({
      block_type: "file",
      title: "Document",
      media_file: "document.pdf",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("Document")).toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText("document.pdf")).toBeInTheDocument();
  });

  it("renders FILE when no extension", () => {
    const b = block({
      block_type: "file",
      title: "Unknown",
      url: null,
      media_file: null,
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("FILE")).toBeInTheDocument();
  });

  it("renders media by card_kind and image metadata when legacy type is article", () => {
    const b = block({
      card_kind: "media",
      block_type: "article",
      title: "Photo",
      media_file: "photo.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      expect.stringContaining("photo.jpg"),
    );
    expect(screen.queryByText("Photo")).not.toBeInTheDocument();
  });

  it("keeps singleton media embeds on the article renderer", () => {
    const b = block({
      card_kind: "article",
      block_type: "image",
      title: "Embedded note",
      body: "![[photo.jpg]]",
      media_file: "photo.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("Embedded note")).toBeInTheDocument();
  });
});
