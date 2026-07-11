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
  const value: LightBlock = {
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
  if (overrides.preview_manifest !== undefined) {
    return value;
  }

  const indexedSources = (() => {
    if (value.media_urls) {
      try {
        const parsed = JSON.parse(value.media_urls) as unknown;
        if (Array.isArray(parsed)) {
          const sources = parsed.filter((item): item is string => typeof item === "string");
          if (sources.length > 0) return sources;
        }
      } catch {
        // Malformed metadata represents a text-only projection in tests too.
      }
    }
    return [value.media_file, value.thumbnail, value.first_image].filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  })();
  const visualSources = indexedSources.filter((source) =>
    /\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|mp4|webm|m4v|mov)$/i.test(source),
  );
  if (visualSources.length === 0) {
    return value;
  }
  const dimensions = value.media_dimensions
    ? JSON.parse(value.media_dimensions) as Record<string, [number, number]>
    : {};
  const tiles = visualSources.slice(0, 4).map((source, index) => {
    const [width, height] = dimensions[source] ?? [value.width, value.height];
    const isVideo = /\.(?:mp4|webm|m4v|mov)$/i.test(source);
    return {
      source_path: source,
      preview_path: `${value.slug}.preview-${index + 1}.jpg`,
      width,
      height,
      is_video: isVideo,
      is_video_poster: isVideo,
    };
  });
  value.preview_manifest = JSON.stringify({
    kind: tiles.length > 1 ? "composite" : tiles[0]?.is_video ? "video_poster" : "image",
    primary_preview_path: `${value.slug}.jpg`,
    width: tiles.length > 1 ? 1 : tiles[0]?.width ?? value.width,
    height: tiles.length > 1 ? 1 : tiles[0]?.height ?? value.height,
    tiles,
    overflow_count: Math.max(0, visualSources.length - tiles.length),
  });
  return value;
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

  it("uses the feed card surface for read-only hover previews", () => {
    const { container } = render(
      <ReadOnlyCardPreview
        block={block()}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
        previewMode="micro"
      />,
    );

    expect(container.querySelector("[data-feed-card-frame]")).toHaveClass("bg-card");
  });

  it("uses the article feed fill for read-only article hover previews", () => {
    const { container } = render(
      <ReadOnlyCardPreview
        block={block({ block_type: "article", card_kind: "article" })}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
        previewMode="micro"
      />,
    );

    expect(container.querySelector("[data-feed-card-frame]")).toHaveClass(
      "bg-card",
      "feed-article-card",
    );
  });

  it("micro preview renders the search excerpt with the highlighter mark", () => {
    render(
      <ReadOnlyCardPreview
        block={block({
          block_type: "article",
          card_kind: "article",
          title: "Card title",
          preview_text: "Regular preview",
          search_match: {
            field: "body",
            kind: "exact",
            excerpt: "around the match here",
            ranges: [{ start: 11, end: 16 }],
            score: 100,
          },
        })}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
        previewMode="micro"
      />,
    );

    expect(screen.queryByText("Regular preview")).not.toBeInTheDocument();
    const mark = screen.getByText("match");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveClass("bg-search-mark");
  });

  it("uses search match excerpt and mark for article body matches", () => {
    render(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          title: "Greek philosophy",
          body: "Regular body",
          preview_text: "Regular preview",
          search_match: {
            field: "body",
            kind: "exact",
            excerpt: "Plato and Aristotle in one paragraph",
            ranges: [{ start: 10, end: 19 }],
            score: 1,
          },
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByText("Regular preview")).not.toBeInTheDocument();
    const mark = screen.getByText("Aristotle");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveClass("bg-search-mark");
  });

  it("uses search match excerpt and mark for social cards with media", () => {
    render(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          url: "https://x.com/a/status/1",
          author: "@artist",
          body: "Social body text\n![](tweet-photo.jpg)",
          media_urls: "[\"tweet-photo.jpg\"]",
          preview_text: "Regular social preview",
          search_match: {
            field: "body",
            kind: "exact",
            excerpt: "Introducing Claude Managed Agents",
            ranges: [{ start: 12, end: 18 }],
            score: 1,
          },
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByText("Regular social preview")).not.toBeInTheDocument();
    const mark = screen.getByText("Claude");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveClass("bg-search-mark");
  });

  it("highlights only the matched prefix in search excerpts", () => {
    render(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          title: "Postcards",
          body: "Regular body",
          preview_text: "Regular preview",
          search_match: {
            field: "body",
            kind: "prefix",
            excerpt: "someone called Zizako Mindo inked over blank postcards",
            ranges: [{ start: 22, end: 24 }],
            score: 1,
          },
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    const mark = screen.getByText("Mi");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveClass("bg-search-mark");
    expect(mark).toHaveClass("p-0");
    expect(mark.className).not.toContain("px-");
    expect(mark.className).not.toContain("rounded");
    expect(screen.queryByText("Mindo")).not.toBeInTheDocument();
  });

  it("uses semantic search excerpts without fake highlight ranges", () => {
    render(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          title: "Neural archive",
          body: "Regular body",
          preview_text: "Regular preview",
          search_match: {
            field: "semantic",
            kind: "semantic",
            excerpt: "A neural archive keeps experience available for later recall.",
            ranges: [],
            score: 0.72,
            explanation: "semantic: intfloat/multilingual-e5-small (0.720)",
          },
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByText("Regular preview")).not.toBeInTheDocument();
    expect(screen.getByText("A neural archive keeps experience available for later recall.")).toBeInTheDocument();
    expect(document.querySelector("mark")).toBeNull();
  });

  it("keeps author-only search matches searchable but visually hidden", () => {
    render(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          title: "Visible title",
          body: "Regular body",
          preview_text: "Regular preview",
          author: "@poetengineer__",
          search_match: {
            field: "author",
            kind: "prefix",
            excerpt: "@poetengineer__",
            ranges: [],
            score: 1,
          },
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Regular preview")).toBeInTheDocument();
    expect(screen.getByText("@poetengineer__")).toBeInTheDocument();
    expect(document.querySelector("mark")).toBeNull();
  });

  it("keeps url-only search matches searchable but visually hidden", () => {
    render(
      <Card
        block={block({
          block_type: "article",
          card_kind: "article",
          title: "Visible title",
          body: "Regular body",
          preview_text: "Regular preview",
          url: "https://example.com/memory-lab",
          search_match: {
            field: "url",
            kind: "exact",
            excerpt: "https://example.com/memory-lab",
            ranges: [],
            score: 1,
          },
        })}
        vaultPath={VAULT}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByText("Regular preview")).toBeInTheDocument();
    expect(screen.queryByText("https://example.com/memory-lab")).not.toBeInTheDocument();
    expect(document.querySelector("mark")).toBeNull();
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
    expect(card).toHaveClass(
      "hover:border-component-fill-hover",
      "focus-visible:border-component-fill-hover",
      "transition-colors",
    );
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
    expect(graphicSurface).toHaveClass("bg-card");
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

  it("prefers the generated thumbnail over the source media file", () => {
    // Feed cards should visually match the sidebar strip: the generated
    // thumbnail/poster is the first visual surface, while the original media is
    // only a fallback for missing derived previews.
    const b = block({
      block_type: "image",
      media_file: "sunset.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).not.toHaveClass("feed-article-card");
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute(
      "src",
      expect.stringContaining("/.mine/cache/thumbs/test-block.jpg"),
    );
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).not.toHaveAttribute("src", expect.stringContaining("sunset.jpg"));
  });

  it("renders image cards as a single generated thumbnail surface", () => {
    const b = block({ block_type: "image", title: "Sunset", media_file: "sunset.jpg" });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" onClick={vi.fn()} />,
    );

    expect(container.querySelector("[data-card-image-base]")).not.toBeInTheDocument();

    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain("/tmp/thumbs/test-block.jpg");
    expect(img).toHaveClass("object-cover");
    expect(img.className).not.toContain("opacity-");
  });

  it("does not fall through to the original image when a derived preview fails", () => {
    const b = block({ block_type: "image", title: "Sunset", media_file: "sunset.jpg" });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" onClick={vi.fn()} />,
    );

    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      expect.stringContaining("/tmp/thumbs/test-block.jpg"),
    );

    fireEvent.error(screen.getByRole("img"));

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Sunset")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(`${VAULT}/sunset.jpg`);
    expect(container.querySelector("[data-card-image-base]")).not.toBeInTheDocument();
  });

  it("renders a neutral surface when the ready derived preview becomes unavailable", () => {
    const b = block({
      block_type: "image",
      media_file: "sunset.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const img = screen.getByRole("img");
    fireEvent.error(img);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Test Block")).toBeInTheDocument();
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

  it("renders the broken-image surface after the derived preview fails", () => {
    const b = block({
      block_type: "image",
      media_file: "missing.jpg",
      title: "Missing Image",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
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

  it("renders a compact link card when no ready preview exists", () => {
    const b = block({
      block_type: "link",
      title: "No Image Site",
      url: "https://noimage.example.com",
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
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

  it("renders a single-image article from its derived tile", () => {
    const b = block({
      block_type: "article",
      title: "Single Image Article",
      body: "![[hero.webp]]\n\nArticle body.",
      first_image: "hero.webp",
      media_urls: "[\"hero.webp\"]",
      media_dimensions: "{\"hero.webp\":[1200,800]}",
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toContain("test-block.preview-1.jpg");
    expect(img!.getAttribute("src")).not.toContain(`${VAULT}/hero.webp`);
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
    expect(images[0]?.getAttribute("src")).toContain("/a.jpg");
    expect(images[1]?.getAttribute("src")).toContain("/b.jpg");
    expect(images[2]?.getAttribute("src")).toContain("/c.jpg");
    expect(screen.queryByText("+2")).not.toBeInTheDocument();
  });

  it("renders video gallery tiles from per-video posters, not one shared block thumbnail", () => {
    // Regression: each gallery video tile must show its OWN generated poster
    // (preview_path = <video-stem>.jpg). A video cannot be drawn into an <img>,
    // so without per-tile posters every tile falls back to the single
    // <slug>.jpg and repeats the same frame.
    const b = block({
      block_type: "article",
      url: "https://www.instagram.com/p/X/",
      author: "@a",
      body: "![[clip (video 1).mp4]]\n![[clip (video 2).mp4]]",
      media_urls: "[\"clip (video 1).mp4\",\"clip (video 2).mp4\"]",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test-block.jpg",
        width: 1,
        height: 1,
        tiles: [
          { source_path: "clip (video 1).mp4", preview_path: "clip (video 1).jpg", width: 860, height: 720, is_video: true, is_video_poster: false },
          { source_path: "clip (video 2).mp4", preview_path: "clip (video 2).jpg", width: 860, height: 720, is_video: true, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const srcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
    expect(srcs.length).toBeGreaterThanOrEqual(2);
    // Distinct posters, not the same image repeated, and not the shared thumb.
    expect(srcs[0]).not.toEqual(srcs[1]);
    expect(srcs.some((s) => s.includes("video"))).toBe(true);
    expect(srcs.every((s) => !s.includes("test-block"))).toBe(true);
  });

  it("rejects legacy gallery tiles that have no derived preview path", () => {
    const b = block({
      block_type: "article",
      url: "https://www.instagram.com/p/Y/",
      author: "@a",
      body: "![[a (video 1).mp4]]\n![[b (video 2).mp4]]",
      media_urls: "[\"a (video 1).mp4\",\"b (video 2).mp4\"]",
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "test-block.jpg",
        width: 1,
        height: 1,
        tiles: [
          { source_path: "a (video 1).mp4", preview_path: null, width: 800, height: 600, is_video: true, is_video_poster: false },
          { source_path: "b (video 2).mp4", preview_path: null, width: 800, height: 600, is_video: true, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const srcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
    expect(srcs).toEqual([]);
  });

  it("renders backfilled article galleries from unique derived tiles", () => {
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
    expect(images[0]?.getAttribute("src")).toContain("/test-block.preview-1.jpg");
    expect(images[1]?.getAttribute("src")).toContain("/test-block.preview-2.jpg");
  });

  it("renders social galleries from distinct derived tiles", () => {
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
    expect(images[0]?.getAttribute("src")).toContain("/test-block.preview-1.jpg");
    expect(images[1]?.getAttribute("src")).toContain("/test-block.preview-2.jpg");
    expect(images[2]?.getAttribute("src")).toContain("/test-block.preview-3.jpg");
    expect(images[3]?.getAttribute("src")).toContain("/test-block.preview-4.jpg");
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

  it("renders social single-image cards from the manifest-derived path", () => {
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
      expect.stringContaining(`${VAULT}/.mine/cache/thumbs/tweet-photo.jpg`),
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

  it("does not fall back from a missing video preview to an unverified block thumb", () => {
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
    expect(img).not.toHaveAttribute("src", expect.stringContaining("test-block.jpg"));
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
          { src: "clip.mp4", preview_path: "test-block.preview-1.jpg", width: 1280, height: 720, is_video: true, is_video_poster: true },
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

  it("renders gallery tiles preview-only: video tile uses its own poster, image tile its source", () => {
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
    // Video tile shows its own generated poster, not the shared block thumbnail.
    expect(images[0]?.getAttribute("src")).toContain("clip.jpg");
    expect(images[0]?.getAttribute("src")).not.toContain("test-block");
    // Image tile renders its real source directly.
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
      expect.stringContaining("/.mine/cache/thumbs/test-block.jpg"),
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
