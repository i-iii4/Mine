import { CLOUD_BADGE_DELAY_MS, CLOUD_STATE_LABEL } from "@/lib/cloudContent";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, DragCardStackPreview, ReadOnlyCardPreview } from "./Card";
import { FeedShowContext, setFeedShow, type FeedShow } from "@/lib/feedDisplay";
import { publishCollectionOrder } from "@/lib/cardCollections";
import { CARD_HOVER_ACTION_MIN_HEIGHT, computeCardHeight } from "@/lib/cardHeight";
import { PROVISIONAL_MEDIA_ASPECT, clampCardAspect } from "@/lib/cardAspect";
import { PreviewsPendingContext } from "@/lib/cardPreviewState";
import {
  EDGE_TEXT_SIDE_PX,
  EDGE_VISUAL_GAP_PX,
  cardTextGap,
  edgeTextBottom,
  edgeTextTop,
} from "@/lib/cardTypography";
import type { LightBlock } from "@/types";
import type { WordWidths } from "@/types/fontMetrics";

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
    : blockType === "link"
      ? "link"
    : blockType === "channel"
      ? "channel"
      : "media";
}

it("sizes a dragged portrait from artifact geometry and loads it eagerly", () => {
  const row = block({ block_type: "image", media_file: "photo.jpg",
    preview_manifest: JSON.stringify({ kind: "image", primary_preview_path: "preview.jpg",
      preview_width: 480, preview_height: 640, tiles: [], overflow_count: 0 }) });
  const { container } = render(<DragCardStackPreview blocks={[row]} vaultPath="/vault"
    thumbsRootPath="/thumbs" thumbVersions={new Map([[row.slug, 3]])} width={240} />);
  expect(container.querySelector("[data-feed-card-frame]")).toHaveStyle({ height: "319px" });
  expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
  expect(container.querySelector("img")?.getAttribute("src")).toContain("3");
});

it("retries a transient preview failure with a new URL and stops after two retries", async () => {
  vi.useFakeTimers();
  const row = block({ block_type: "image", media_file: "photo.jpg",
    preview_manifest: JSON.stringify({ kind: "image", primary_preview_path: "preview.jpg",
      preview_width: 480, preview_height: 640, tiles: [], overflow_count: 0 }) });
  const { container, unmount } = render(<ReadOnlyCardPreview block={row} vaultPath="/vault" thumbsRootPath="/thumbs" />);
  try {
    fireEvent.error(container.querySelector("img")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(container.querySelector("img")?.getAttribute("src")).toContain("retry=1");
    fireEvent.error(container.querySelector("img")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.querySelector("img")?.getAttribute("src")).toContain("retry=2");
    fireEvent.error(container.querySelector("img")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.querySelector("img")).toBeNull();
  } finally { unmount(); vi.useRealTimers(); }
});

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
    collections: [],
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

  it("reports the Connect menu opening, not just the keyboard overflow menu", async () => {
    // The feed holds a card in place while its menu is open. The pre-existing
    // notification only fired for the overflow menu opened from the keyboard,
    // which misses the case this exists for: unchecking the current collection
    // in Connect, by pointer.
    const onMenuOpenChange = vi.fn();
    const { container } = render(
      <Card
        block={block()}
        vaultPath={VAULT}
        onClick={vi.fn()}
        onMenuOpenChange={onMenuOpenChange}
        tags={[{ tag: "Красивый веб", count: 1 }]}
        currentTag="Красивый веб"
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    // Connect is the plus at the end of the card's bottom row of collections.
    const connect = container.querySelector<HTMLElement>("[data-card-hover-connect]");
    expect(connect).toHaveAttribute("aria-label", "Connect");
    fireEvent.pointerDown(connect!, { button: 0, ctrlKey: false });
    fireEvent.click(connect!);
    await waitFor(() => expect(onMenuOpenChange).toHaveBeenCalledWith(true));
  });

  it("renders a text post preview as the feed does: no picture, its text and author", () => {
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
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Авторка задает хороший вопрос")).toBeInTheDocument();
    expect(screen.getByText("@fish_elysium")).toBeInTheDocument();
  });

  it("uses the feed card surface for read-only hover previews", () => {
    const { container } = render(
      <ReadOnlyCardPreview
        block={block()}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
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
      />,
    );

    // Every card stands on the card surface, in both themes (06.10.2026).
    expect(container.querySelector("[data-feed-card-frame]")).toHaveClass("bg-card");
  });

  it("a preview renders the search excerpt with the highlighter mark, as the feed card does", () => {
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
      />,
    );

    expect(screen.queryByText("Regular preview")).not.toBeInTheDocument();
    const mark = screen.getByText("match");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveClass("bg-search-mark");
  });

  it("a preview keeps the card's own title when search names the result by file name", () => {
    const titleMatch = (excerpt: string) => ({
      field: "title" as const,
      kind: "prefix" as const,
      excerpt,
      ranges: [{ start: 0, end: 5 }],
      score: 8,
    });
    const { rerender } = render(
      <ReadOnlyCardPreview
        block={block({
          block_type: "article",
          card_kind: "article",
          slug: "Cards/Radio notes",
          title: null,
          content_heading: "Radio tower",
          display_title: "Radio tower",
          preview_text: "Regular preview",
          search_match: titleMatch("Radio notes"),
        })}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
      />,
    );

    // The file name matched, the card shows its heading: no mark over text
    // the ranges do not index, and the preview text stays.
    expect(screen.getByText("Radio tower")).toBeInTheDocument();
    expect(screen.queryByText("Radio notes")).not.toBeInTheDocument();
    expect(screen.getByText("Regular preview")).toBeInTheDocument();
    expect(document.querySelector("mark")).toBeNull();

    rerender(
      <ReadOnlyCardPreview
        block={block({
          block_type: "article",
          card_kind: "article",
          slug: "Cards/Radio tower",
          title: null,
          content_heading: "Radio tower",
          display_title: "Radio tower",
          preview_text: "Regular preview",
          search_match: titleMatch("Radio tower"),
        })}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
      />,
    );

    // The heading is the file name itself: the match marks it.
    expect(screen.getByText("Radio").tagName).toBe("MARK");
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

  it("enforces the hover-action height without changing the card frame", () => {
    render(<Card block={block()} vaultPath={VAULT} onClick={vi.fn()} />);
    const card = screen.getByRole("button");
    expect(card).toHaveStyle({
      minHeight: `${CARD_HOVER_ACTION_MIN_HEIGHT}px`,
    });
    expect(card).toHaveClass("border-border");
    expect(card).not.toHaveClass(
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
    // The fill belongs to the window that moves on a lift, never to the slot
    // that stays: a slot fill showed behind the risen text (С8.3).
    expect(graphicSurface).not.toHaveClass("bg-card");
    expect(graphicSurface?.querySelector("[data-card-lift='window']")).toHaveClass("bg-card");
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
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(screen.getByRole("img")).toHaveClass("object-cover");
    expect(container.querySelector("[data-card-graphic-surface]")).toHaveClass("h-full");
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

  it("shows the page picture that loaded, and only that one", () => {
    const pictureLink = (path: string) => block({
      block_type: "link", title: "Linked page", url: "https://example.com/page",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: path, width: 1200, height: 630,
        preview_width: 600, preview_height: 315, tiles: [], overflow_count: 0,
      }),
    });
    const { container, rerender } = render(
      <ReadOnlyCardPreview block={pictureLink("page.jpg")} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    const picture = () => container.querySelector<HTMLImageElement>("[data-card-graphic-surface] img")!;
    expect(picture()).toHaveClass("opacity-0");
    // A picture from the cache can load before the card's effects run: the
    // loaded state belongs to that picture, so nothing resets it afterwards.
    fireEvent.load(picture());
    expect(picture()).toHaveClass("opacity-100");
    rerender(
      <ReadOnlyCardPreview block={pictureLink("page.jpg")} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    expect(picture()).toHaveClass("opacity-100");
    // A new picture is not the loaded one until it loads in turn.
    rerender(
      <ReadOnlyCardPreview block={pictureLink("other.jpg")} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    expect(picture()).toHaveClass("opacity-0");
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

  it.each([1, 2, 3, 4])("rounds only the enclosing media surface for %i tiles in content cards", (count) => {
    for (const social of [false, true]) {
      const sources = Array.from({ length: count }, (_, index) => `photo-${index}.jpg`);
      const b = block({ block_type: "article", body: sources.map(src => `![](${src})`).join("\n"),
        url: social ? "https://x.com/a/status/1" : null,
        media_urls: JSON.stringify(sources),
      });
      const { container, unmount } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
      const surface = container.querySelector('[data-card-graphic-surface]');
      expect(surface).toHaveClass('overflow-hidden', 'rounded-b-[var(--radius-card)]');
      expect(surface?.querySelectorAll('img')).toHaveLength(count);
      for (const tile of container.querySelectorAll('[data-card-media-tile]')) {
        expect(tile.className).not.toContain('rounded');
        expect(surface).toContainElement(tile as HTMLElement);
      }
      unmount();
    }
  });

  it.each([1, 2])("uses the same rounded outer surface for %i video posters", (count) => {
    const sources = Array.from({ length: count }, (_, index) => `clip-${index}.mp4`);
    const b = block({ block_type: "article", url: "https://x.com/a/status/1",
      body: sources.map(src => `![](${src})`).join("\n"), media_urls: JSON.stringify(sources) });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(container.querySelector('[data-card-graphic-surface]')).toHaveClass('overflow-hidden', 'rounded-b-[var(--radius-card)]');
    for (const tile of container.querySelectorAll('[data-card-media-tile]')) expect(tile.className).not.toContain('rounded');
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
      collections: [],
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

  it("draws a square video square, not in a 16:9 slot (30.09.2026)", () => {
    const b = block({
      block_type: "video",
      media_file: "square.mp4",
      preview_manifest: JSON.stringify({
        kind: "video_poster",
        primary_preview_path: "test-block.jpg",
        width: 1080,
        height: 1080,
        preview_width: 640,
        preview_height: 640,
        tiles: [{
          source_path: "square.mp4", preview_path: "test-block.preview-1.jpg",
          width: 1080, height: 1080, preview_width: 640, preview_height: 640,
          is_video: true, is_video_poster: true,
        }],
        overflow_count: 0,
      }),
    });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const surface = container.querySelector<HTMLElement>("[data-card-graphic-surface]")!;
    // jsdom drops a unitless aspect-ratio; the ratio itself is pinned in
    // cardLayout.test.ts, and the grid reads the same descriptor.
    expect(surface).not.toHaveClass("aspect-video");
    expect(surface).not.toHaveAttribute("data-card-preview-geometry");
  });

  it("keeps a video without a poster in the marked provisional envelope", () => {
    const b = block({ block_type: "video", media_file: "fresh.mp4" });
    const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const surface = container.querySelector<HTMLElement>("[data-card-graphic-surface]")!;
    expect(surface).toHaveAttribute("data-card-preview-geometry", "pending");
  });

  it("marks a video card whose file is still in iCloud (SPEC_CLOUD_STORAGE.md, Х6)", () => {
    vi.useFakeTimers();
    try {
      const b = block({
        block_type: "video",
        title: "Cloud Video",
        media_file: "cloud.mp4",
        content_in_cloud: true,
        preview_manifest: JSON.stringify({
          kind: "video_poster",
          primary_preview_path: "test-block.jpg",
          width: 1280,
          height: 720,
          tiles: [
            { src: "cloud.mp4", width: 1280, height: 720, is_video: true, is_video_poster: true },
          ],
          overflow_count: 0,
        }),
      });
      const { container } = render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
      expect(container.querySelector("[data-card-cloud-badge]")).toBeNull();
      act(() => { vi.advanceTimersByTime(CLOUD_BADGE_DELAY_MS); });
      expect(container.querySelector("[data-card-cloud-badge]")).toHaveAttribute("title", CLOUD_STATE_LABEL);
    } finally {
      vi.useRealTimers();
    }
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
      collections: [],
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
      collections: [],
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
      collections: [],
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
      collections: [],
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

// The damaged-cache state is named on the card, not folded into "not ready".
describe("unreadable preview artifact", () => {
  it("names the state when the flag rides the wire", () => {
    const { container } = render(
      <Card
        block={block({
          block_type: "image",
          card_kind: "media",
          media_file: "photo.jpg",
          title: null,
          url: null,
          preview_manifest: JSON.stringify({
            kind: "image",
            primary_preview_path: null,
            width: null,
            height: null,
            tiles: [],
            overflow_count: 0,
          }),
          preview_unreadable: true,
        })}
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        onClick={() => {}}
        tags={[]}
        onToggleTag={() => {}}
        onCreateAndAssign={() => {}}
        onRequestRename={() => {}}
        onRequestDelete={() => {}}
      />,
    );

    expect(container.querySelector("[data-card-preview-unreadable]")).toHaveTextContent(
      "Preview file can’t be read",
    );
  });

  it("stays silent for an ordinary not-yet-ready preview", () => {
    const { container } = render(
      <Card
        block={block({
          block_type: "image",
          card_kind: "media",
          media_file: "photo.jpg",
          title: null,
          url: null,
          preview_manifest: JSON.stringify({
            kind: "image",
            primary_preview_path: null,
            width: null,
            height: null,
            tiles: [],
            overflow_count: 0,
          }),
        })}
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
        onClick={() => {}}
        tags={[]}
        onToggleTag={() => {}}
        onCreateAndAssign={() => {}}
        onRequestRename={() => {}}
        onRequestDelete={() => {}}
      />,
    );

    expect(container.querySelector("[data-card-preview-unreadable]")).toBeNull();
  });
});

describe("Card presentation in the feed (SPEC_FEED_DISPLAY.md, Д11 to Д13)", () => {
  const imageManifest = JSON.stringify({
    kind: "image",
    primary_preview_path: "test-block.jpg",
    width: 1280,
    height: 960,
    preview_width: 640,
    preview_height: 480,
    tiles: [{
      source_path: "photo.jpg", preview_path: "test-block.preview-1.jpg",
      width: 1280, height: 960, preview_width: 640, preview_height: 480,
      is_video: false, is_video_poster: false,
    }],
    overflow_count: 0,
  });
  const inFeed = (show: FeedShow, value: LightBlock) =>
    render(
      <FeedShowContext.Provider value={show}>
        <Card block={value} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    );

  it("Cards frames a picture as a post card with its name", () => {
    const picture = block({
      block_type: "image", title: null, url: null, media_file: "Media/Sunset.jpg",
      content_heading: "Sunset", fallback_label: "Sunset", preview_manifest: imageManifest,
    });
    const { container } = inFeed("cards", picture);
    expect(screen.getByText("Sunset")).toBeInTheDocument();
    expect(container.querySelector("[data-card-graphic-surface]")).not.toBeNull();
  });

  it("Cards names a picture only by a heading of its own, never by its file", () => {
    const picture = block({
      block_type: "image", title: "Sunset title", url: null, media_file: "Media/Sunset.jpg",
      content_heading: null, fallback_label: "Sunset", preview_manifest: imageManifest,
    });
    inFeed("cards", picture);
    expect(screen.queryByText("Sunset")).not.toBeInTheDocument();
    expect(screen.queryByText("Sunset title")).not.toBeInTheDocument();
    expect(screen.queryByText("Media/Sunset.jpg")).not.toBeInTheDocument();
  });

  it("Cards shows a picture's text and author under its name (Д12, В5.3)", () => {
    const picture = block({
      block_type: "image", title: null, url: null, media_file: "Media/Sunset.jpg",
      content_heading: "Sunset", fallback_label: "Sunset", author: "@someone",
      preview_text: "Evening over the bay", preview_manifest: imageManifest,
    });
    inFeed("cards", picture);
    expect(screen.getByText("Sunset")).toBeInTheDocument();
    expect(screen.getByText("Evening over the bay")).toBeInTheDocument();
    expect(screen.getByText("@someone")).toBeInTheDocument();
  });

  /// A link whose page picture came from a source of one shape, with a
  /// preview artifact of another shape, or not measured yet.
  const pageLink = (source: [number, number], artifact: [number, number] | null) => block({
    block_type: "link", title: "A page", url: "https://example.com/page",
    preview_manifest: JSON.stringify({
      kind: "image", primary_preview_path: "page.jpg",
      width: source[0], height: source[1],
      preview_width: artifact?.[0] ?? null, preview_height: artifact?.[1] ?? null,
      tiles: [{ source_path: "https://example.com/og.jpg", preview_path: "page.preview-1.jpg",
        width: source[0], height: source[1],
        preview_width: artifact?.[0] ?? null, preview_height: artifact?.[1] ?? null,
        is_video: false, is_video_poster: false }],
      overflow_count: 0,
    }),
  });
  /// The surface Media paints for a card. jsdom drops a unitless aspect-ratio
  /// from the style it keeps, so it is read from the markup React writes.
  const mediaSurface = (value: LightBlock) => {
    const markup = renderToStaticMarkup(
      <FeedShowContext.Provider value="media">
        <Card block={value} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    );
    const surface = new DOMParser().parseFromString(markup, "text/html")
      .querySelector("[data-card-graphic-surface]");
    const aspect = Number(/aspect-ratio:([0-9.]+)/.exec(surface?.getAttribute("style") ?? "")?.[1]);
    return { surface, aspect };
  };
  /// Height of a full-width surface of that aspect in a 320px column, inside
  /// the card's 1px border: what the browser paints for it.
  const paintedHeight = (aspect: number) => Math.round((320 - 2) / aspect) + 2;

  it("Media paints a link's tall page picture at the clamped shape it is laid out at (В5.2)", () => {
    const tallPage = pageLink([100, 1000], [100, 1000]);
    const { aspect } = mediaSurface(tallPage);
    expect(aspect).toBe(0.5);
    expect(computeCardHeight(tallPage, 320, null, "media")).toBe(paintedHeight(aspect));
  });

  it("Media paints a link's page picture at its artifact's shape, not its source's (В5.7)", () => {
    const link = pageLink([1200, 630], [600, 900]);
    const { surface, aspect } = mediaSurface(link);
    expect(aspect).toBeCloseTo(600 / 900);
    expect(surface?.getAttribute("data-card-preview-geometry")).toBeNull();
    expect(computeCardHeight(link, 320, null, "media")).toBe(paintedHeight(aspect));
  });

  it("Media paints an unmeasured page picture in the marked provisional envelope (В5.7)", () => {
    const link = pageLink([1200, 630], null);
    const { surface, aspect } = mediaSurface(link);
    expect(aspect).toBe(PROVISIONAL_MEDIA_ASPECT);
    expect(surface?.getAttribute("data-card-preview-geometry")).toBe("pending");
    expect(computeCardHeight(link, 320, null, "media")).toBe(paintedHeight(aspect));
  });

  it("Mixed keeps a picture bare, as before", () => {
    const picture = block({
      block_type: "image", title: null, url: null, media_file: "Media/Sunset.jpg",
      fallback_label: "Sunset", preview_manifest: imageManifest,
    });
    const { container } = inFeed("mixed", picture);
    expect(screen.queryByText("Sunset")).not.toBeInTheDocument();
    expect(container.querySelector("[data-card-graphic-surface]")).not.toBeNull();
  });

  it("Media shows a post's picture alone: no title, no text, no author", () => {
    const post = block({
      block_type: "article", title: "A post", url: null,
      body: "Some words\n\n![](photo.jpg)", media_urls: "[\"photo.jpg\"]",
      author: "@someone", preview_manifest: imageManifest,
    });
    const { container } = inFeed("media", post);
    expect(screen.queryByText("A post")).not.toBeInTheDocument();
    expect(screen.queryByText("@someone")).not.toBeInTheDocument();
    expect(container.querySelector("[data-card-graphic-surface]")).not.toBeNull();
  });
});

describe("Card geometry, author and name (SPEC_AUDIT_FIXES.md, Г4.5 to Г4.7)", () => {
  const COLUMN = 320;
  const CARD_BORDER = 2;
  const AUTHOR_LINE = 16;
  /// The frame's inner width: a post's media runs across it, from the
  /// frame's top edge (SPEC_FEED_DISPLAY.md, Д20).
  const INNER_WIDTH = COLUMN - CARD_BORDER;

  /// A single-picture post from X or Instagram whose preview artifact is a
  /// 100×1000 strip: ten times taller than wide, far past the card's 1:2.
  const tallPost = (url: string, author: string | null = null) => block({
    block_type: "article", card_kind: "article", title: null, description: null, url,
    body: "![](tall.jpg)", media_urls: "[\"tall.jpg\"]", author,
    preview_manifest: JSON.stringify({
      kind: "image", primary_preview_path: "tall.jpg", width: 100, height: 1000,
      preview_width: 100, preview_height: 1000,
      tiles: [{ source_path: "tall.jpg", preview_path: "tall.preview-1.jpg",
        width: 100, height: 1000, preview_width: 100, preview_height: 1000,
        is_video: false, is_video_poster: false }],
      overflow_count: 0,
    }),
  });

  /// The card as the feed renders it in a presentation. jsdom drops a unitless
  /// aspect-ratio from the style it keeps, so the card is read from the markup
  /// React writes.
  const renderedMarkup = (show: FeedShow, value: LightBlock) => new DOMParser().parseFromString(
    renderToStaticMarkup(
      <FeedShowContext.Provider value={show}>
        <Card block={value} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    ),
    "text/html",
  );
  const paintedAspect = (doc: Document) => Number(
    /aspect-ratio:([0-9.]+)/.exec(
      doc.querySelector("[data-card-graphic-surface]")?.getAttribute("style") ?? "",
    )?.[1],
  );

  it.each([
    ["X", "https://x.com/someone/status/1"],
    ["Instagram", "https://instagram.com/p/1"],
  ])("paints a tall single %s picture at 1:2 and reserves the height it paints (Г4.5)", (_network, url) => {
    const post = tallPost(url);
    for (const show of ["mixed", "cards", "media"] as const) {
      const aspect = paintedAspect(renderedMarkup(show, post));
      expect(aspect).toBe(0.5);
      // With no text under it, the picture across the frame's inner width is
      // the whole card inside its border, in every presentation.
      expect(computeCardHeight(post, COLUMN, null, show))
        .toBe(Math.round(INNER_WIDTH / aspect) + CARD_BORDER);
    }
  });

  // Д1.2: the card's whole preview is built from `thumbnail`, here a 16:9
  // video poster the helper kept for a video too large to save, while the card
  // paints the body's own picture, an 800×1200 tile.
  it.each([
    ["X", "https://x.com/someone/status/1"],
    ["Instagram", "https://instagram.com/p/1"],
  ])("shapes a single %s picture by the tile it paints, not by the poster in its preview (Д1.2)", (_network, url) => {
    const post = block({
      block_type: "article", card_kind: "article", title: null, description: null, url,
      thumbnail: "Media/post-poster.jpg",
      body: "![](Media/post-1.jpg)", media_urls: "[\"Media/post-1.jpg\"]",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: "post.jpg", width: 1600, height: 900,
        preview_width: 1600, preview_height: 900,
        tiles: [{ source_path: "Media/post-1.jpg", preview_path: "post.preview-1.jpg",
          width: 800, height: 1200, preview_width: 800, preview_height: 1200,
          is_video: false, is_video_poster: false }],
        overflow_count: 0,
      }),
    });
    const tileAspect = clampCardAspect(800 / 1200);
    for (const show of ["mixed", "cards", "media"] as const) {
      const doc = renderedMarkup(show, post);
      // The tile is what the surface paints, and its shape is the surface's.
      expect(doc.querySelector("[data-card-graphic-surface] img")?.getAttribute("src"))
        .toContain("post.preview-1.jpg");
      const aspect = paintedAspect(doc);
      expect(aspect).toBeCloseTo(tileAspect, 4);
      // The picture across the frame's inner width is the whole card.
      expect(computeCardHeight(post, COLUMN, null, show))
        .toBe(Math.round(INNER_WIDTH / aspect) + CARD_BORDER);
    }
  });

  /// A post or an article with one media whose whole preview, `post.jpg`, is
  /// built from `thumbnail` at 1600×900, and whose one tile, from the body, is
  /// 800×1200.
  const oneMediaCard = (url: string, media: "picture" | "video") => block({
    block_type: "article", card_kind: "article", title: null, description: null, url,
    thumbnail: "Media/page-picture.jpg",
    body: media === "picture" ? "![](Media/body-1.jpg)" : "![](Media/body-1.mp4)",
    media_urls: media === "picture" ? "[\"Media/body-1.jpg\"]" : "[\"Media/body-1.mp4\"]",
    collections: [],
    feed_playback: null,
    preview_manifest: JSON.stringify({
      kind: media === "picture" ? "image" : "video_poster",
      primary_preview_path: "post.jpg", width: 1600, height: 900,
      preview_width: 1600, preview_height: 900,
      tiles: [{ source_path: media === "picture" ? "Media/body-1.jpg" : "Media/body-1.mp4",
        preview_path: "post.preview-1.jpg",
        width: 800, height: 1200, preview_width: 800, preview_height: 1200,
        is_video: media === "video", is_video_poster: media === "video" }],
      overflow_count: 0,
    }),
  });
  /// Height of a card that paints one media at `aspect` and no text: the
  /// media across the frame's inner width is the whole card inside its
  /// border, in every presentation.
  const oneMediaHeight = (aspect: number) => Math.round(INNER_WIDTH / aspect) + CARD_BORDER;

  it.each([
    ["an article", "https://example.com/piece"],
    ["an X post", "https://x.com/someone/status/1"],
  ])("shapes %s's one picture by the tile it paints, not by its page picture (Д1.6)", (_card, url) => {
    const card = oneMediaCard(url, "picture");
    for (const show of ["mixed", "cards", "media"] as const) {
      const doc = renderedMarkup(show, card);
      expect(doc.querySelector("[data-card-graphic-surface] img")?.getAttribute("src"))
        .toContain("post.preview-1.jpg");
      const aspect = paintedAspect(doc);
      expect(aspect).toBeCloseTo(clampCardAspect(800 / 1200), 4);
      expect(computeCardHeight(card, COLUMN, null, show)).toBe(oneMediaHeight(aspect));
    }
  });

  it.each([
    ["an article", "https://example.com/piece"],
    ["an X post", "https://x.com/someone/status/1"],
  ])("shapes %s's one video by the poster it paints, the whole preview (Д1.6)", (_card, url) => {
    const card = oneMediaCard(url, "video");
    for (const show of ["mixed", "cards", "media"] as const) {
      const doc = renderedMarkup(show, card);
      const poster = doc.querySelector("[data-card-graphic-surface] img")?.getAttribute("src") ?? "";
      expect(poster).toContain("post.jpg");
      expect(poster).not.toContain("preview-1");
      const aspect = paintedAspect(doc);
      expect(aspect).toBeCloseTo(clampCardAspect(1600 / 900), 4);
      expect(computeCardHeight(card, COLUMN, null, show)).toBe(oneMediaHeight(aspect));
    }
  });

  const longAuthor = "An author whose name runs on far past the width of any column in the feed, and then some more";
  /// The author line a card paints in Mixed, found by its text.
  const authorLine = (value: LightBlock, text: string) => {
    render(
      <FeedShowContext.Provider value="mixed">
        <Card block={value} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    );
    return screen.getByText(text);
  };

  it("keeps a long post author on one truncated line inside the height it reserves (Г4.6)", () => {
    const post = tallPost("https://x.com/someone/status/1", longAuthor);
    const author = authorLine(post, `by ${longAuthor}`);
    // One line of 16px that ends in an ellipsis, never a second line.
    expect(author).toHaveClass("truncate");
    expect(author).toHaveStyle({ lineHeight: "16px" });
    // The picture, then the author's one line 14px from it and from the
    // bottom edge, letter to letter (Д25).
    expect(computeCardHeight(post, COLUMN, null, "mixed")).toBe(
      CARD_BORDER + Math.round(INNER_WIDTH / 0.5)
        + edgeTextTop("author") + AUTHOR_LINE + edgeTextBottom("author"),
    );
  });

  it("keeps a long article author on one truncated line inside the height it reserves (Г4.6)", () => {
    // The tall picture puts the card above the hover-action minimum, so the
    // author's share of the height is visible in the total.
    const article = { ...tallPost("https://example.com/piece", longAuthor), title: "A piece" };
    const author = authorLine(article, longAuthor);
    expect(author).toHaveClass("truncate");
    expect(author).toHaveStyle({ lineHeight: "16px" });
    // The author adds exactly one line and its gap under the title, however
    // long it is; the gap to the bottom edge reads the same under either.
    const withoutAuthor = computeCardHeight({ ...article, author: null }, COLUMN, null, "mixed");
    expect(edgeTextBottom("author")).toBe(edgeTextBottom("title"));
    expect(computeCardHeight(article, COLUMN, null, "mixed"))
      .toBe(withoutAuthor + cardTextGap("title", "author") + AUTHOR_LINE);
  });

  it("names a Media card after its card, not only its actions (Г4.7)", () => {
    const post = block({
      block_type: "article", card_kind: "article", title: "Harbour at dusk", url: null,
      body: "Some words\n\n![](photo.jpg)", media_urls: "[\"photo.jpg\"]",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: "test-block.jpg", width: 1280, height: 960,
        preview_width: 640, preview_height: 480,
        tiles: [{ source_path: "photo.jpg", preview_path: "test-block.preview-1.jpg",
          width: 1280, height: 960, preview_width: 640, preview_height: 480,
          is_video: false, is_video_poster: false }],
        overflow_count: 0,
      }),
    });
    render(
      <FeedShowContext.Provider value="media">
        <Card block={post} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    );
    expect(screen.queryByText("Harbour at dusk")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Harbour at dusk" }))
      .toHaveAttribute("data-feed-card-frame");
  });

  it("names a video card in Mixed after its card (Г4.7)", () => {
    const video = block({
      block_type: "video", title: null, url: null, media_file: "Media/Clip.mp4",
      fallback_label: "Clip", preview_manifest: JSON.stringify({
        kind: "video_poster", primary_preview_path: "clip.jpg", width: null, height: null,
        preview_width: 640, preview_height: 360,
        tiles: [{ source_path: "Media/Clip.mp4", preview_path: "clip.jpg", width: null, height: null,
          preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true }],
        overflow_count: 0,
      }),
    });
    render(
      <FeedShowContext.Provider value="mixed">
        <Card block={video} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Clip" })).toHaveAttribute("data-feed-card-frame");
  });
});

// ─── Painted geometry ───────────────────────────────────────────────────────
//
// jsdom lays nothing out, so the tests below lay a card's markup out the way
// the browser lays out the card body's block flow, from the classes and styles
// React writes: the frame's 1px border, Tailwind padding and top margins,
// surfaces as tall as their aspect-ratio makes them across the width they get,
// and text lines at their line height. By default every paragraph is one line:
// the fixtures' text fits on one line at the test column, and the word widths
// handed to `computeCardHeight` say the same. Given a `TextMeasure`, the
// painter breaks a paragraph's words into lines at the width its box gets, as
// the browser does, so a test can prove the height wraps text at that width.

/// How the painter sets text: the width of every word and of the space
/// between two words.
interface TextMeasure {
  wordWidth: (word: string) => number;
  spaceWidth: number;
}

/// Lines a paragraph takes at `width`: words fill a line while they fit, and
/// `truncate` or `line-clamp-N` caps the count. Without a measure, one line.
function paragraphLines(element: Element, width: number, measure: TextMeasure | undefined): number {
  const words = (element.textContent ?? "").split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return 0;
  let lines = 1;
  if (measure) {
    let lineWidth = measure.wordWidth(words[0]!);
    for (const word of words.slice(1)) {
      const next = lineWidth + measure.spaceWidth + measure.wordWidth(word);
      if (next <= width) {
        lineWidth = next;
      } else {
        lines += 1;
        lineWidth = measure.wordWidth(word);
      }
    }
  }
  if (element.classList.contains("truncate")) return 1;
  for (const name of Array.from(element.classList)) {
    const clamp = /^line-clamp-(\d+)$/.exec(name);
    if (clamp) return Math.min(lines, Number(clamp[1]));
  }
  return lines;
}

interface PaintedBox {
  element: Element;
  top: number;
  left: number;
  width: number;
  height: number;
}

/// Tailwind's spacing unit: `p-4` is 16px, `mt-1.5` is 6px.
const SPACING_UNIT_PX = 4;
/// The frame's `border`, 1px on every side.
const FRAME_BORDER_PX = 1;

function spacingPx(element: Element, utility: string): number {
  const prefix = `${utility}-`;
  for (const name of Array.from(element.classList)) {
    if (!name.startsWith(prefix)) continue;
    const value = Number(name.slice(prefix.length));
    if (Number.isFinite(value)) return value * SPACING_UNIT_PX;
  }
  return 0;
}

/// A length the card sets inline, in px, or null: the text stack's gaps come
/// from the typography module as numbers, not as utility classes.
function stylePx(element: Element, property: string): number | null {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([0-9.]+)px`).exec(element.getAttribute("style") ?? "");
  return match ? Number(match[1]) : null;
}

function marginTopPx(element: Element): number {
  return stylePx(element, "margin-top") ?? spacingPx(element, "mt");
}

function paddingPx(element: Element) {
  const all = spacingPx(element, "p");
  const x = stylePx(element, "padding-inline") ?? (spacingPx(element, "px") || all);
  const y = spacingPx(element, "py") || all;
  return {
    top: stylePx(element, "padding-top") ?? (spacingPx(element, "pt") || y),
    bottom: stylePx(element, "padding-bottom") ?? (spacingPx(element, "pb") || y),
    left: spacingPx(element, "pl") || x,
    right: spacingPx(element, "pr") || x,
  };
}

function aspectRatioOf(element: Element): number | null {
  if (element.classList.contains("aspect-video")) return 16 / 9;
  const match = /aspect-ratio:\s*([0-9.]+)/.exec(element.getAttribute("style") ?? "");
  return match ? Number(match[1]) : null;
}

function lineHeightPx(element: Element): number {
  const match = /line-height:\s*([0-9.]+)px/.exec(element.getAttribute("style") ?? "");
  if (!match) throw new Error(`Text without a line height: ${element.outerHTML}`);
  return Number(match[1]);
}

function layOutBox(
  element: Element,
  top: number,
  left: number,
  width: number,
  boxes: PaintedBox[],
  measure?: TextMeasure,
): number {
  const padding = paddingPx(element);
  const aspectRatio = aspectRatioOf(element);
  let height: number;
  if (aspectRatio !== null) {
    // The layout reserves whole pixels, as `computeCardHeight` does.
    height = Math.round(width / aspectRatio);
  } else if (element.tagName === "P") {
    const lines = paragraphLines(element, width - padding.left - padding.right, measure);
    height = padding.top + lines * lineHeightPx(element) + padding.bottom;
  } else {
    let cursor = padding.top;
    for (const child of Array.from(element.children)) {
      // Badges and overlays sit over the flow, not in it.
      if (child.classList.contains("absolute")) continue;
      cursor += marginTopPx(child);
      cursor += layOutBox(
        child,
        top + cursor,
        left + padding.left,
        width - padding.left - padding.right,
        boxes,
        measure,
      );
    }
    height = cursor + padding.bottom;
  }
  boxes.push({ element, top, left, width, height });
  return height;
}

/// A feed card in a presentation, laid out at a column. With `measure`, its
/// paragraphs wrap at the width they get.
function paintCard(
  value: LightBlock,
  show: FeedShow,
  column: number,
  measure?: TextMeasure,
) {
  const markup = renderToStaticMarkup(
    <FeedShowContext.Provider value={show}>
      <Card block={value} vaultPath={VAULT} onClick={vi.fn()} />
    </FeedShowContext.Provider>,
  );
  const frame = new DOMParser().parseFromString(markup, "text/html")
    .querySelector("[data-feed-card-frame]");
  if (!frame) throw new Error("The card painted no frame");
  const boxes: PaintedBox[] = [];
  let contentHeight = 0;
  for (const child of Array.from(frame.children)) {
    if (child.classList.contains("absolute")) continue;
    contentHeight += layOutBox(
      child,
      FRAME_BORDER_PX + contentHeight,
      FRAME_BORDER_PX,
      column - FRAME_BORDER_PX * 2,
      boxes,
      measure,
    );
  }
  const height = Math.max(CARD_HOVER_ACTION_MIN_HEIGHT, contentHeight + FRAME_BORDER_PX * 2);
  const boxOf = (element: Element | null) => boxes.find((box) => box.element === element);
  const surface = boxOf(frame.querySelector("[data-card-graphic-surface]"));
  const text = boxes
    .filter((box) => box.element.tagName === "P" && box.height > 0)
    .sort((a, b) => a.top - b.top);
  return { frame, height, surface, text };
}

describe("Media edge to edge (SPEC_FEED_DISPLAY.md, Д20 to Д25)", () => {
  const COLUMN = 320;
  const INNER = COLUMN - FRAME_BORDER_PX * 2;
  /// The text's inset at the frame's sides, and the gap every vertical seam
  /// of the text reads as, letter to letter (Д25).
  const EDGE_PADDING = EDGE_TEXT_SIDE_PX;
  const EDGE_VISUAL_GAP = EDGE_VISUAL_GAP_PX;
  /// Every fixture's title and text fit on one line at this column.
  const ONE_LINE: WordWidths = {
    title: [60],
    preview: [60],
    titleSpace: 4,
    previewSpace: 4,
    titleNoSpaceBefore: [false],
    previewNoSpaceBefore: [false],
  };
  /// The air a 12px line keeps above and below its letters inside its box.
  const air = (box: PaintedBox) => (lineHeightPx(box.element) - 12) / 2;

  const imageManifest = (width: number, height: number) => JSON.stringify({
    kind: "image", primary_preview_path: "test-block.jpg", width, height,
    preview_width: width, preview_height: height,
    tiles: [{ source_path: "photo.jpg", preview_path: "test-block.preview-1.jpg",
      width, height, preview_width: width, preview_height: height,
      is_video: false, is_video_poster: false }],
    overflow_count: 0,
  });
  const galleryManifest = (count: number) => JSON.stringify({
    kind: "composite", primary_preview_path: "test-block.jpg", width: 1, height: 1,
    preview_width: 640, preview_height: 640,
    tiles: Array.from({ length: count }, (_unused, index) => ({
      source_path: `photo-${index + 1}.jpg`, preview_path: `test-block.preview-${index + 1}.jpg`,
      width: 640, height: 480, preview_width: 640, preview_height: 480,
      is_video: false, is_video_poster: false,
    })),
    overflow_count: 0,
  });
  const videoManifest = JSON.stringify({
    kind: "video_poster", primary_preview_path: "clip.jpg", width: null, height: null,
    preview_width: 640, preview_height: 360,
    tiles: [{ source_path: "Media/Clip.mp4", preview_path: "clip.jpg", width: null, height: null,
      preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true }],
    overflow_count: 0,
  });

  const article = (manifest: string) => block({
    block_type: "article", card_kind: "article", title: "A piece", description: null, url: null,
    body: "Short words\n\n![](photo.jpg)", media_urls: "[\"photo.jpg\"]",
    preview_text: "Short words", author: "Ann", preview_manifest: manifest,
  });
  const xPost = (manifest: string) => block({
    block_type: "article", card_kind: "article", title: null, description: null,
    url: "https://x.com/someone/status/1", body: "Hello there\n\n![](photo.jpg)",
    media_urls: "[\"photo.jpg\"]", preview_text: "Hello there", author: "@someone",
    preview_manifest: manifest,
  });
  /// A picture whose body opens with its own heading: the name `Cards` sets
  /// under it.
  const picture = () => block({
    block_type: "image", title: null, url: null, media_file: "Media/Sunset.jpg",
    content_heading: "Sunset", fallback_label: "Sunset", preview_manifest: imageManifest(640, 480),
  });
  const video = () => block({
    block_type: "video", title: null, url: null, media_file: "Media/Clip.mp4",
    fallback_label: "Clip", author: "@filmmaker", preview_manifest: videoManifest,
  });
  const pageLink = () => block({
    block_type: "link", title: "A page", url: "https://example.com/page",
    preview_manifest: imageManifest(1200, 630),
  });

  const framedCards: Array<[string, () => LightBlock, FeedShow]> = [
    ["an article with one picture", () => article(imageManifest(800, 600)), "mixed"],
    ["an article with a gallery", () => article(galleryManifest(2)), "mixed"],
    ["an X post with one picture", () => xPost(imageManifest(800, 1000)), "mixed"],
    ["an X post with a two-tile gallery", () => xPost(galleryManifest(2)), "mixed"],
    ["an X post with a four-tile gallery", () => xPost(galleryManifest(4)), "mixed"],
    ["a picture Cards frames as a post", picture, "cards"],
    ["a video Cards frames as a post", video, "cards"],
  ];

  it.each(framedCards)("reserves exactly the height %s paints", (_card, make, show) => {
    expect(paintCard(make(), show, COLUMN).height)
      .toBe(computeCardHeight(make(), COLUMN, ONE_LINE, show));
  });

  it.each(framedCards)("runs the media of %s to the frame's top and sides (Д20)", (_card, make, show) => {
    const { surface } = paintCard(make(), show, COLUMN);
    // Right under the frame's top border, across its whole inner width.
    expect(surface).toMatchObject({ top: FRAME_BORDER_PX, left: FRAME_BORDER_PX, width: INNER });
    // The frame's rounded clip gives the media the card's top corners; the
    // media rounds its own bottom corners with the same card radius where the
    // text starts (01.10.2026), and has no outline of its own.
    const classes = surface?.element.className.split(/\s+/) ?? [];
    expect(classes).toContain("rounded-b-[var(--radius-card)]");
    expect(classes.some((name) => name.startsWith("rounded-[") || name.startsWith("rounded-t-"))).toBe(false);
  });

  it.each(framedCards)("spaces the text of %s 14px from letter to letter under the media (Д25)", (_card, make, show) => {
    const painted = paintCard(make(), show, COLUMN);
    expect(painted.text.length).toBeGreaterThan(0);
    // Every line starts 8px inside the frame's border and spans the inner
    // width less 8px on each side.
    for (const line of painted.text) {
      expect(line.left).toBe(FRAME_BORDER_PX + EDGE_PADDING);
      expect(line.width).toBe(INNER - EDGE_PADDING * 2);
    }
    const first = painted.text[0]!;
    const last = painted.text[painted.text.length - 1]!;
    const surface = painted.surface!;
    // 14px from the media to the first letters, between every two groups,
    // and from the last letters to the frame's bottom border.
    expect(first.top + air(first) - (surface.top + surface.height)).toBe(EDGE_VISUAL_GAP);
    painted.text.slice(1).forEach((line, index) => {
      const above = painted.text[index]!;
      expect(line.top + air(line) - (above.top + above.height - air(above))).toBe(EDGE_VISUAL_GAP);
    });
    expect(painted.height - FRAME_BORDER_PX - (last.top + last.height - air(last))).toBe(EDGE_VISUAL_GAP);
    expect(painted.height).toBe(computeCardHeight(make(), COLUMN, ONE_LINE, show));
  });

  it("reserves an article with one picture at its painted 333px", () => {
    // Border 2 + media 318 × 3/4 (239) + 12 + title 16 + 8 + text 20 + 8
    // + author 16 + 12: every gap 14px from letter to letter (Д25).
    const post = article(imageManifest(800, 600));
    expect(computeCardHeight(post, COLUMN, ONE_LINE, "mixed")).toBe(333);
    expect(paintCard(post, "mixed", COLUMN).height).toBe(333);
  });

  it.each([
    ["a link with a picture and a domain", () => block({
      block_type: "link",
      url: "https://example.com/page",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: "link.jpg", width: 1600, height: 900,
        preview_width: 1600, preview_height: 900, tiles: [], overflow_count: 0,
      }),
    })],
    ["a post with a picture and an author only", () => block({
      block_type: "article",
      title: null,
      description: null,
      body: "![](photo.jpg)",
      preview_text: null,
      author: "@someone",
      media_urls: "[\"photo.jpg\"]",
      preview_manifest: imageManifest(800, 600),
    })],
    ["a text post without a title", () => block({
      block_type: "article",
      title: null,
      description: null,
      body: "Just a few words",
      preview_text: "Just a few words",
      url: null,
    })],
  ] as const)("reserves exactly what %s paints, its bottom gap included (01.10.2026)", (_name, make) => {
    expect(paintCard(make(), "mixed", COLUMN).height)
      .toBe(computeCardHeight(make(), COLUMN, ONE_LINE, "mixed"));
  });

  describe("text that wraps at the text column, 8px inside each side", () => {
    /// Every character 6px wide, a space 3px.
    const MEASURE: TextMeasure = { wordWidth: (word) => word.length * 6, spaceWidth: 3 };
    /// The text column: 318 − 16 = 302px. 144 + 3 + 144 = 291px fits on one
    /// line; 156 + 3 + 150 = 309px takes two.
    const FITS = `${"W".repeat(24)} ${"M".repeat(24)}`;
    const WRAPS = `${"W".repeat(26)} ${"M".repeat(25)}`;
    const widthsOf = (title: string, preview: string): WordWidths => {
      const words = (text: string) => text.split(" ").filter((word) => word.length > 0);
      return {
        title: words(title).map(MEASURE.wordWidth),
        preview: words(preview).map(MEASURE.wordWidth),
        titleSpace: MEASURE.spaceWidth,
        previewSpace: MEASURE.spaceWidth,
        titleNoSpaceBefore: words(title).map(() => false),
        previewNoSpaceBefore: words(preview).map(() => false),
      };
    };

    const cases: Array<[string, (text: string) => LightBlock, (text: string) => WordWidths, number]> = [
      [
        "an article's title",
        (text) => ({ ...article(imageManifest(800, 600)), title: text }),
        (text) => widthsOf(text, "Short words"),
        16,
      ],
      [
        "an X post's text",
        (text) => ({ ...xPost(galleryManifest(2)), preview_text: text, body: `${text}\n\n![](photo.jpg)` }),
        (text) => widthsOf("", text),
        20,
      ],
    ];

    it.each(cases)("counts %s at the width the column gives it", (_text, make, widths, lineHeight) => {
      for (const [text, lines] of [[FITS, 1], [WRAPS, 2]] as const) {
        const painted = paintCard(make(text), "mixed", COLUMN, MEASURE);
        const paragraph = painted.text.find((box) => box.element.textContent === text)!;
        expect(paragraph.width).toBe(INNER - EDGE_PADDING * 2);
        expect(paragraph.height).toBe(lineHeight * lines);
        expect(computeCardHeight(make(text), COLUMN, widths(text), "mixed")).toBe(painted.height);
      }
    });
  });

  it("lays a gallery's tiles across the frame with 1px straight seams (Д21)", () => {
    const painted = paintCard(xPost(galleryManifest(4)), "mixed", COLUMN);
    const tiles = painted.frame.querySelectorAll("[data-card-media-tile]");
    expect(tiles).toHaveLength(4);
    // No rounding of its own on any tile; the seams are the grid's 1px gap.
    for (const tile of Array.from(tiles)) {
      expect(tile.className).not.toMatch(/rounded/);
    }
    const grid = tiles[0]!.closest(".grid");
    expect(grid?.classList.contains("gap-px")).toBe(true);
    expect(painted.surface).toMatchObject({ width: INNER, height: INNER });
  });

  it("runs a link's page picture across the frame's top, as it always was", () => {
    for (const show of ["mixed", "cards"] as const) {
      const painted = paintCard(pageLink(), show, COLUMN);
      expect(painted.surface).toMatchObject({ top: FRAME_BORDER_PX, left: FRAME_BORDER_PX, width: INNER });
      expect(painted.height).toBe(computeCardHeight(pageLink(), COLUMN, null, show));
    }
  });

  it("fills the card with frameless media and Media cards from the frame's top (Д22)", () => {
    const filling: Array<[LightBlock, FeedShow]> = [
      [picture(), "mixed"],
      [video(), "mixed"],
      [picture(), "media"],
      [article(imageManifest(800, 600)), "media"],
      [xPost(galleryManifest(4)), "media"],
    ];
    for (const [value, show] of filling) {
      const painted = paintCard(value, show, COLUMN);
      expect(painted.surface).toMatchObject({ top: FRAME_BORDER_PX, left: FRAME_BORDER_PX, width: INNER });
      expect(painted.text).toHaveLength(0);
    }
  });

  it("sets a text post 8px from the sides and 14px from both edges, letter to letter (Д25)", () => {
    const textOnly: LightBlock[] = [
      block({
        block_type: "article", card_kind: "article", title: "A piece", description: null, url: null,
        body: "Short words", preview_text: "Short words", author: "Ann",
      }),
      block({
        block_type: "article", card_kind: "article", title: null, description: null,
        url: "https://x.com/someone/status/2", body: "Hello there", preview_text: "Hello there",
        author: "@someone",
      }),
    ];
    for (const value of textOnly) {
      const painted = paintCard(value, "mixed", COLUMN);
      expect(painted.surface).toBeUndefined();
      for (const line of painted.text) {
        expect(line.left).toBe(FRAME_BORDER_PX + EDGE_PADDING);
        expect(line.width).toBe(INNER - EDGE_PADDING * 2);
      }
      const first = painted.text[0]!;
      const last = painted.text[painted.text.length - 1]!;
      expect(first.top + air(first) - FRAME_BORDER_PX).toBe(EDGE_VISUAL_GAP);
      painted.text.slice(1).forEach((line, index) => {
        const above = painted.text[index]!;
        expect(line.top + air(line) - (above.top + above.height - air(above))).toBe(EDGE_VISUAL_GAP);
      });
      const bottomGap = painted.height - FRAME_BORDER_PX - (last.top + last.height - air(last));
      if (painted.height > CARD_HOVER_ACTION_MIN_HEIGHT) {
        expect(bottomGap).toBe(EDGE_VISUAL_GAP);
      } else {
        // A short card is held at the hover actions' minimum height.
        expect(bottomGap).toBeGreaterThan(EDGE_VISUAL_GAP);
      }
      expect(computeCardHeight(value, COLUMN, ONE_LINE, "mixed")).toBe(painted.height);
    }
  });

  it("keeps the hover controls over the card, out of its body's flow (Д24)", () => {
    const post = article(imageManifest(800, 600));
    const { container } = render(
      <Card
        block={post}
        vaultPath={VAULT}
        onClick={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );
    const frame = container.querySelector("[data-feed-card-frame]")!;
    const surface = frame.querySelector("[data-card-graphic-surface]");
    // Everything but the body: the hover menu and what it positions.
    const overlay = Array.from(frame.children).filter((child) => !child.contains(surface));
    expect(overlay.length).toBeGreaterThan(0);
    for (const child of overlay) {
      expect(child.classList.contains("absolute")).toBe(true);
    }
  });
});

describe("Card titles differ from their text by color alone (01.10.2026)", () => {
  /// Any utility that sets a weight; a title carries none and paints at the
  /// regular body weight its font metrics are measured with.
  const WEIGHT_UTILITY = /(?:^|\s)font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?:\s|$)/;

  const expectBodySizedTitle = (title: HTMLElement) => {
    expect(title).toHaveClass("text-sm", "text-foreground");
    expect(title.className).not.toMatch(WEIGHT_UTILITY);
    expect(title).not.toHaveClass("text-base");
    expect(title).not.toHaveClass("text-lg");
  };

  const article = block({
    block_type: "article", card_kind: "article", title: "Article title",
    body: "Article text under the title.", preview_text: "Article text under the title.", url: null,
  });
  const pictureLink = block({
    block_type: "link", title: "Linked page", url: "https://example.com/page",
    preview_manifest: JSON.stringify({
      kind: "image", primary_preview_path: "page.jpg", width: 1200, height: 630,
      preview_width: 600, preview_height: 315, tiles: [], overflow_count: 0,
    }),
  });
  const bareLink = block({ block_type: "link", title: "Bare page", url: "https://bare.example.com" });
  const file = block({ block_type: "file", title: "Quarterly report", media_file: "report.pdf", url: null });

  it.each([
    ["an article card", article, "Article title", false],
    ["a link card with its page picture", pictureLink, "Linked page", true],
    ["a link card without a picture", bareLink, "Bare page", false],
    ["a file card", file, "Quarterly report", false],
  ])("sets the title of %s in the card text size and weight", (_surface, value, title, hasPicture) => {
    const { container } = render(<Card block={value} vaultPath={VAULT} onClick={vi.fn()} />);
    // Each case reaches its own title branch: the picture link is not the
    // compact one.
    expect(container.querySelector("[data-card-graphic-surface]") !== null).toBe(hasPicture);
    expectBodySizedTitle(screen.getByText(title));
  });

  it("sets a picture's name in Cards like any other title", () => {
    const picture = block({
      block_type: "image", title: null, url: null, media_file: "Media/Sunset.jpg",
      content_heading: "Sunset", fallback_label: "Sunset",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: "test-block.jpg", width: 1280, height: 960,
        preview_width: 640, preview_height: 480, tiles: [], overflow_count: 0,
      }),
    });
    render(
      <FeedShowContext.Provider value="cards">
        <Card block={picture} vaultPath={VAULT} onClick={vi.fn()} />
      </FeedShowContext.Provider>,
    );
    expectBodySizedTitle(screen.getByText("Sunset"));
  });

  it("sets the title in a card preview exactly as in the feed", () => {
    render(
      <ReadOnlyCardPreview
        block={article}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
      />,
    );
    expectBodySizedTitle(screen.getByText("Article title"));
    // The text under it has the same size; brightness alone tells them apart.
    const text = screen.getByText("Article text under the title.");
    expect(text).toHaveClass("text-sm", "text-muted-foreground");
    expect(text.className).not.toMatch(WEIGHT_UTILITY);
  });
});

describe("Card lift on hover (SPEC_CARD_STATES.md, С8)", () => {
  const menuProps = {
    tags: [],
    onToggleTag: vi.fn(),
    onCreateAndAssign: vi.fn(),
    onRequestRename: vi.fn(),
    onRequestDelete: vi.fn(),
  };
  const frameOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-feed-card-frame]")!;

  it("lifts a card with hover actions, never one without them", () => {
    const withMenu = render(<Card block={block()} vaultPath={VAULT} onClick={vi.fn()} {...menuProps} />);
    expect(frameOf(withMenu.container)).toHaveAttribute("data-card-lift-hover");
    withMenu.unmount();

    const bare = render(<Card block={block()} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(frameOf(bare.container)).not.toHaveAttribute("data-card-lift-hover");
  });

  it("does not lift while hover is disabled, as in keyboard mode", () => {
    const { container } = render(
      <Card block={block()} vaultPath={VAULT} onClick={vi.fn()} hoverEnabled={false} {...menuProps} />,
    );
    expect(frameOf(container)).not.toHaveAttribute("data-card-lift-hover");
  });

  it("answers hover only on a card the pointer has arrived on (С8.6)", () => {
    const unarmed = render(
      <Card block={block()} vaultPath={VAULT} onClick={vi.fn()} hoverArmed={false} {...menuProps} />,
    );
    expect(frameOf(unarmed.container)).not.toHaveAttribute("data-card-lift-hover");
    expect(frameOf(unarmed.container)).not.toHaveClass("group");
    unarmed.unmount();

    const armed = render(<Card block={block()} vaultPath={VAULT} onClick={vi.fn()} {...menuProps} />);
    expect(frameOf(armed.container)).toHaveAttribute("data-card-lift-hover");
    expect(frameOf(armed.container)).toHaveClass("group");
  });

  it("rises by the row of collections' reach less the card's own space under its last letters", () => {
    /// The --card-lift a card sets on its frame, as React writes it.
    const liftOf = (value: LightBlock) => {
      const markup = renderToStaticMarkup(
        <Card block={value} vaultPath={VAULT} onClick={vi.fn()} {...menuProps} />,
      );
      const frame = new DOMParser().parseFromString(markup, "text/html")
        .querySelector("[data-feed-card-frame]");
      const match = /--card-lift:\s*([0-9.]+)px/.exec(frame?.getAttribute("style") ?? "");
      return match ? Number(match[1]) : null;
    };
    // The row stands 8px above the bottom edge and is 24px tall, its 12px
    // letters centred: from the edge to 14px above them is 8 + 24 − 6 + 14.
    const reach = 8 + 24 - 6 + EDGE_VISUAL_GAP_PX;
    // A post's last letters stand 14px above the edge already.
    expect(liftOf(block({ block_type: "article", body: "Some words" }))).toBe(reach - EDGE_VISUAL_GAP_PX);
    // Media with no text under it ends at the edge: the whole reach.
    expect(liftOf(block({
      block_type: "article", title: null, description: null, body: "![](photo.jpg)",
      media_urls: "[\"photo.jpg\"]",
    }))).toBe(reach);
    // A link's footer: p-3 under its last 16px line, 2px of it air.
    expect(liftOf(block())).toBe(reach - 12 - 2);
    // A file card: p-4 under its 16px name.
    expect(liftOf(block({ block_type: "file", media_file: "report.pdf", url: null }))).toBe(reach - 16 - 2);
    // A bare picture rises by its caption's height, which the caption sets.
    const pictureMarkup = renderToStaticMarkup(
      <Card block={block({ block_type: "image", media_file: "photo.jpg" })} vaultPath={VAULT} onClick={vi.fn()} {...menuProps} />,
    );
    expect(pictureMarkup).toContain('data-card-lift="caption"');
    expect(liftOf(block({ block_type: "image", media_file: "photo.jpg" }))).toBeNull();
  });

  it("moves the media window and its picture plane, and keeps the cloud badge outside them", () => {
    const { container } = render(
      <Card block={block({ block_type: "image", media_file: "photo.jpg" })} vaultPath={VAULT} onClick={vi.fn()} {...menuProps} />,
    );
    const surface = container.querySelector("[data-card-graphic-surface]")!;
    const windowLayer = surface.querySelector(":scope > [data-card-lift='window']");
    expect(windowLayer).not.toBeNull();
    expect(windowLayer!.querySelector(":scope > [data-card-lift='plane']")).not.toBeNull();
    expect(container.querySelector("[data-card-lift='tray']")).not.toBeNull();
  });

  it("styles the lift in global.css: text and window up, picture only hinting, row up from under the edge", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const rules = css.split("}");
    const ruleFor = (selectorPart: string, declaration: string) =>
      rules.some((rule) => rule.includes(selectorPart) && rule.includes(declaration));
    expect(ruleFor('[data-card-lift-hover]:hover [data-card-lift="text"]', "translateY(calc(-1 * var(--card-lift)))")).toBe(true);
    expect(ruleFor('[data-card-lift-pinned] [data-card-lift="window"]', "translateY(calc(-1 * var(--card-lift)))")).toBe(true);
    expect(ruleFor('[data-card-lift-hover]:hover [data-card-lift="plane"]', "translateY(calc(var(--card-lift) - var(--card-lift-drift)))")).toBe(true);
    expect(ruleFor("[data-feed-card-frame]", "--card-lift-drift: 8px")).toBe(true);
    expect(ruleFor('[data-card-lift="tray"]', "transform: translateY(var(--card-lift))")).toBe(true);
    expect(ruleFor('[data-card-lift-hover]:hover [data-card-lift-fade]', "mask-position: 0 0")).toBe(true);
    // The lift is the card's own, never a depth class.
    expect(css).not.toContain("data-card-lift-depth");
  });
});

describe("Card previews show the feed card in its final hover state (SPEC_CARD_STATES.md, С10)", () => {
  const menuProps = {
    tags: [],
    onToggleTag: vi.fn(),
    onCreateAndAssign: vi.fn(),
    onRequestRename: vi.fn(),
    onRequestDelete: vi.fn(),
  };
  const imageManifest = (path: string) => JSON.stringify({
    kind: "image", primary_preview_path: path, width: 1280, height: 960,
    preview_width: 640, preview_height: 480, tiles: [], overflow_count: 0,
  });
  const picture = (overrides: Partial<LightBlock> = {}) => block({
    block_type: "image", url: null, title: null, media_file: "Media/Sunset.jpg",
    content_heading: "Sunset", display_title: "Sunset", fallback_label: "Sunset",
    preview_manifest: imageManifest("sunset.jpg"), collections: ["Art", "Web"], ...overrides,
  });
  const textPost = () => block({
    block_type: "article", card_kind: "article", title: "A post", url: null,
    body: "Words of the post.", preview_text: "Words of the post.", author: "Author",
    collections: ["Art"],
  });
  const mediaPost = () => block({
    block_type: "article", card_kind: "article", title: "A post with media", url: null,
    body: "Words\n\n![](Media/one.jpg)", preview_text: "Words", collections: ["Web"],
    preview_manifest: JSON.stringify({
      kind: "image", primary_preview_path: "post.jpg", width: 800, height: 600,
      preview_width: 800, preview_height: 600,
      tiles: [{ source_path: "Media/one.jpg", preview_path: "post.preview-1.jpg",
        width: 800, height: 600, preview_width: 800, preview_height: 600,
        is_video: false, is_video_poster: false }],
      overflow_count: 0,
    }),
  });
  const pictureLink = () => block({
    block_type: "link", title: "Linked page", url: "https://example.com/page",
    preview_manifest: imageManifest("page.jpg"), collections: [],
  });
  const samples = [
    ["a picture", picture],
    ["a text post", textPost],
    ["a post with media", mediaPost],
    ["a link", pictureLink],
  ] as const;
  const shows: FeedShow[] = ["mixed", "cards", "media"];

  afterEach(() => {
    setFeedShow("mixed");
    publishCollectionOrder([]);
  });

  const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
  const frameIn = (document: Document) => document.querySelector<HTMLElement>("[data-feed-card-frame]")!;
  /// What the frame holds without its own pieces: the feed card's hover
  /// actions or the preview's row of collections, and the image loading
  /// hint (a preview loads at once, a feed card as it scrolls in).
  const contentOf = (frame: HTMLElement, own: string) => {
    frame.querySelectorAll(own).forEach((node) => node.remove());
    frame.querySelectorAll("[loading]").forEach((node) => node.removeAttribute("loading"));
    return frame.innerHTML;
  };
  const feedMarkup = (value: LightBlock, show: FeedShow) => renderToStaticMarkup(
    <FeedShowContext.Provider value={show}>
      <Card block={value} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" onClick={vi.fn()} {...menuProps} />
    </FeedShowContext.Provider>,
  );
  const previewMarkup = (value: LightBlock) => renderToStaticMarkup(
    <ReadOnlyCardPreview block={value} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" width={288} />,
  );

  it.each(shows)("draws the feed's own card for every kind in %s", (show) => {
    setFeedShow(show);
    for (const [, make] of samples) {
      const value = make();
      const feed = contentOf(
        frameIn(parse(feedMarkup(value, show))),
        "[data-card-hover-overlay], [data-card-hover-more-action], [data-card-hover-bottom-actions]",
      );
      const preview = contentOf(frameIn(parse(previewMarkup(value))), "[data-card-preview-collections]");
      expect(preview).toBe(feed);
    }
  });

  it.each(samples)("stands %s lifted from its first frame, by the feed card's lift", (_kind, make) => {
    const value = make();
    const feedFrame = frameIn(parse(feedMarkup(value, "mixed")));
    const previewFrame = frameIn(parse(previewMarkup(value)));
    expect(previewFrame.hasAttribute("data-card-preview")).toBe(true);
    expect(previewFrame.hasAttribute("data-card-lift-pinned")).toBe(true);
    // Pinned, not hovered: it needs no pointer to stay up.
    expect(previewFrame.hasAttribute("data-card-lift-hover")).toBe(false);
    const liftOf = (frame: HTMLElement) => /--card-lift:\s*([0-9.]+)px/.exec(frame.getAttribute("style") ?? "")?.[1] ?? null;
    expect(liftOf(previewFrame)).toBe(liftOf(feedFrame));
  });

  it("has nothing to press: no buttons, collections as text in the sidebar's order", () => {
    publishCollectionOrder([{ tag: "Web", count: 1 }, { tag: "Art", count: 1 }]);
    const { container } = render(
      <ReadOnlyCardPreview block={picture()} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-card-hover-more-action], [data-card-hover-connect]")).toBeNull();
    expect(frameIn(document)).toHaveClass("pointer-events-none");
    const row = container.querySelector("[data-card-preview-collections]")!;
    expect(Array.from(row.querySelectorAll("[data-card-collection-name]"), (name) => name.textContent))
      .toEqual(["Web", "Art"]);
    expect(row.querySelector("[data-card-collection-name]")).toHaveClass("font-mono", "text-sm", "text-muted-foreground");
  });

  it("says when a card is in no collection, as the feed card's row does", () => {
    const { container } = render(
      <ReadOnlyCardPreview block={pictureLink()} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    expect(container.querySelector("[data-card-preview-collections] [data-card-no-collections]"))
      .toHaveTextContent("No collections");
  });

  it("brings up a bare picture's caption with the feed's title rule: its own H1, never a legacy title or the file", () => {
    const { container, rerender } = render(
      <ReadOnlyCardPreview block={picture()} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    expect(container.querySelector("[data-card-lift='caption']")).toHaveTextContent("Sunset");

    rerender(
      <ReadOnlyCardPreview
        block={picture({ content_heading: null, display_title: "Legacy title", title: "Legacy title" })}
        vaultPath={VAULT}
        thumbsRootPath="/tmp/thumbs"
      />,
    );
    const caption = container.querySelector("[data-card-lift='caption']")!;
    expect(caption).not.toHaveTextContent("Legacy title");
    expect(caption).not.toHaveTextContent("Sunset");
  });

  it("reserves a bare picture's height exactly as the feed does at the preview's width", () => {
    setFeedShow("media");
    const value = mediaPost();
    const { container } = render(
      <ReadOnlyCardPreview block={value} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" width={288} />,
    );
    expect(frameIn(document)).toHaveStyle({ height: `${computeCardHeight(value, 288, null, "media")}px` });
    // `Media` shows the post's media alone and lifts its text as the caption.
    expect(container.querySelector("[data-card-lift='caption']")).toHaveTextContent("A post with media");
  });

  it("leaves a dragged card at rest, as the feed card under a drag (С8.5)", () => {
    const { container } = render(
      <DragCardStackPreview blocks={[picture()]} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" />,
    );
    const frame = container.querySelector("[data-feed-card-frame]")!;
    expect(frame).toHaveAttribute("data-card-preview");
    expect(frame).not.toHaveAttribute("data-card-lift-pinned");
    expect(container.querySelector("[data-card-lift='caption']")).toBeNull();
    expect(container.querySelector("[data-card-preview-collections]")).toBeNull();
  });

  it("stops every lift transition inside a preview in global.css", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    const rule = css.split("}").find((part) => part.includes("[data-card-preview] [data-card-lift],"));
    expect(rule).toContain("[data-card-preview] [data-card-lift-fade]");
    expect(rule).toContain("transition: none");
  });
});

describe("Card without a preview: pending, missing, unreadable (SPEC_CARD_MEDIA_GEOMETRY.md, «Карточка без превью»)", () => {
  const COLUMN = 320;
  const CARD_BORDER = 2;

  /// The card as the feed paints it, inside or outside a running preview pass.
  const tree = (value: LightBlock, previewsPending: boolean, show: FeedShow = "mixed") => (
    <PreviewsPendingContext.Provider value={previewsPending}>
      <FeedShowContext.Provider value={show}>
        <Card block={value} vaultPath={VAULT} thumbsRootPath="/tmp/thumbs" onClick={vi.fn()} />
      </FeedShowContext.Provider>
    </PreviewsPendingContext.Provider>
  );
  const renderCard = (value: LightBlock, previewsPending: boolean, show: FeedShow = "mixed") =>
    render(tree(value, previewsPending, show));
  const markupOf = (value: LightBlock, previewsPending: boolean) =>
    new DOMParser().parseFromString(renderToStaticMarkup(tree(value, previewsPending)), "text/html");

  /// A picture the index knows, before any preview of it exists: the row
  /// carries no manifest and no flag, exactly like one whose file is gone.
  const freshPicture = (overrides: Partial<LightBlock> = {}) => block({
    block_type: "image", url: null, title: "Strategist Index Cards",
    media_file: "Media/Strategist Index Cards.jpg", preview_manifest: null, ...overrides,
  });
  /// A picture whose preview is measured but whose file is not there to paint.
  const measuredPicture = () => block({
    block_type: "image", url: null, title: "Tall", media_file: "Media/Tall.jpg",
    preview_manifest: JSON.stringify({
      kind: "image", primary_preview_path: null, width: 1200, height: 1600,
      preview_width: 480, preview_height: 640, tiles: [], overflow_count: 0,
    }),
  });
  const pendingFill = (container: ParentNode) =>
    container.querySelector("[data-card-graphic-surface] [data-card-preview-pending]");

  describe("image card", () => {
    it("names the picture and its file when no preview is coming", () => {
      const { container } = renderCard(freshPicture(), false);
      expect(screen.getByText("Strategist Index Cards")).toBeInTheDocument();
      expect(container.querySelector("[data-card-missing-media]"))
        .toHaveTextContent("Media/Strategist Index Cards.jpg");
      expect(pendingFill(container)).toBeNull();
    });

    it("draws a picture whose preview is being built as the skeleton fill, with no name and no file", () => {
      const { container } = renderCard(freshPicture(), true);
      const fill = pendingFill(container);
      expect(fill).not.toBeNull();
      expect(fill).toHaveClass("absolute", "inset-0", "bg-accent");
      const surface = container.querySelector("[data-card-graphic-surface]")!;
      expect(surface).toHaveTextContent("");
      expect(surface).toHaveAttribute("data-card-preview-geometry", "pending");
      expect(screen.queryByText("Strategist Index Cards")).not.toBeInTheDocument();
      expect(container.querySelector("[data-card-missing-media]")).toBeNull();
      expect(container.querySelector("[data-card-preview-unreadable]")).toBeNull();
    });

    it("keeps the unreadable wording while the pass runs: a broken file is a recorded fact", () => {
      const { container } = renderCard(freshPicture({ preview_unreadable: true }), true);
      expect(container.querySelector("[data-card-preview-unreadable]"))
        .toHaveTextContent("Preview file can’t be read");
      expect(screen.getByText("Strategist Index Cards")).toBeInTheDocument();
      expect(pendingFill(container)).toBeNull();
    });

    it("treats content held by iCloud as pending with no pass, and marks it with the cloud (Х6)", () => {
      vi.useFakeTimers();
      try {
        const { container } = renderCard(freshPicture({ content_in_cloud: true }), false);
        expect(pendingFill(container)).not.toBeNull();
        expect(container.querySelector("[data-card-missing-media]")).toBeNull();
        expect(screen.queryByText("Strategist Index Cards")).not.toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(CLOUD_BADGE_DELAY_MS); });
        expect(container.querySelector("[data-card-cloud-badge]")).toHaveAttribute("title", CLOUD_STATE_LABEL);
      } finally {
        vi.useRealTimers();
      }
    });

    it("paints the fill in exactly the box the named surface takes, the height the layout reserved", () => {
      const picture = measuredPicture();
      const pending = markupOf(picture, true).querySelector("[data-card-graphic-surface]");
      const missing = markupOf(picture, false).querySelector("[data-card-graphic-surface]");
      expect(pending?.querySelector("[data-card-preview-pending]")).not.toBeNull();
      expect(missing?.querySelector("[data-card-missing-media]")).not.toBeNull();
      expect(pending?.getAttribute("class")).toBe(missing?.getAttribute("class"));
      expect(pending?.getAttribute("style")).toBe(missing?.getAttribute("style"));
      const aspect = Number(/aspect-ratio:([0-9.]+)/.exec(pending?.getAttribute("style") ?? "")?.[1]);
      expect(aspect).toBe(0.75);
      expect(computeCardHeight(picture, COLUMN, null))
        .toBe(Math.round((COLUMN - CARD_BORDER) / aspect) + CARD_BORDER);
    });

    it("turns a preview file that fails to load into the fill while the pass runs, and back into the name after it", () => {
      const picture = block({ block_type: "image", url: null, title: "Sunset", media_file: "Media/Sunset.jpg" });
      const { container, rerender } = renderCard(picture, true);
      fireEvent.error(screen.getByRole("img"));
      expect(pendingFill(container)).not.toBeNull();
      expect(screen.queryByText("Sunset")).not.toBeInTheDocument();

      rerender(tree(picture, false));
      expect(pendingFill(container)).toBeNull();
      expect(screen.getByText("Sunset")).toBeInTheDocument();
      expect(container.querySelector("[data-card-missing-media]")).toHaveTextContent("Media/Sunset.jpg");
    });
  });

  describe("post media", () => {
    const oneImagePost = () => block({
      block_type: "article", title: "A post", url: null, body: "Words\n\n![](Media/one.jpg)",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: "post.jpg", width: 800, height: 600,
        preview_width: 800, preview_height: 600,
        tiles: [{ source_path: "Media/one.jpg", preview_path: "post.preview-1.jpg",
          width: 800, height: 600, preview_width: 800, preview_height: 600,
          is_video: false, is_video_poster: false }],
        overflow_count: 0,
      }),
    });

    it("fills a post's picture slot while its preview is on the way, keeps the neutral surface otherwise", () => {
      const pending = renderCard(oneImagePost(), true);
      fireEvent.error(pending.container.querySelector("[data-card-graphic-surface] img")!);
      expect(pendingFill(pending.container)).not.toBeNull();
      expect(pending.container.querySelector("[data-preview-unavailable]")).toBeNull();
      expect(screen.getByText("A post")).toBeInTheDocument();
      pending.unmount();

      const missing = renderCard(oneImagePost(), false);
      fireEvent.error(missing.container.querySelector("[data-card-graphic-surface] img")!);
      expect(pendingFill(missing.container)).toBeNull();
      expect(missing.container.querySelector("[data-preview-unavailable]")).toHaveClass("bg-card");
    });

    it("fills the slot of a picture `Cards` frames before its preview exists", () => {
      const pending = renderCard(freshPicture(), true, "cards");
      expect(pendingFill(pending.container)).not.toBeNull();
      expect(pending.container.querySelector("[data-preview-unavailable]")).toBeNull();
      pending.unmount();

      const missing = renderCard(freshPicture(), false, "cards");
      expect(pendingFill(missing.container)).toBeNull();
      expect(missing.container.querySelector("[data-preview-unavailable]")).not.toBeNull();
    });
  });

  describe("gallery tiles", () => {
    const gallery = () => block({
      block_type: "article", title: "Gallery", url: null, body: "Three pictures",
      preview_manifest: JSON.stringify({
        kind: "composite", primary_preview_path: "gallery.jpg", width: 1, height: 1,
        tiles: ["a", "b", "c"].map((name) => ({
          source_path: `Media/${name}.jpg`, preview_path: `${name}.jpg`, width: 800, height: 600,
          is_video: false, is_video_poster: false,
        })),
        overflow_count: 0,
      }),
    });
    const failEveryTile = (container: HTMLElement) => {
      for (const image of Array.from(container.querySelectorAll("[data-card-media-tile] img"))) {
        fireEvent.error(image);
      }
    };

    it("fills every tile whose preview is on the way, and only those", () => {
      const { container } = renderCard(gallery(), true);
      const tiles = Array.from(container.querySelectorAll("[data-card-media-tile]"));
      expect(tiles).toHaveLength(3);
      fireEvent.error(tiles[0]!.querySelector("img")!);
      expect(tiles[0]!.querySelector("[data-card-preview-pending]")).not.toBeNull();
      expect(tiles[1]!.querySelector("img")).not.toBeNull();
      failEveryTile(container);
      for (const tile of tiles) {
        expect(tile.querySelector("[data-card-preview-pending]")).toHaveClass("bg-accent");
        expect(tile.querySelector("[data-preview-unavailable]")).toBeNull();
      }
    });

    it("keeps the neutral tile surface when no preview is coming", () => {
      const { container } = renderCard(gallery(), false);
      failEveryTile(container);
      const tiles = Array.from(container.querySelectorAll("[data-card-media-tile]"));
      for (const tile of tiles) {
        expect(tile.querySelector("[data-card-preview-pending]")).toBeNull();
        expect(tile.querySelector("[data-preview-unavailable]")).toHaveClass("bg-card");
      }
    });
  });

  describe("video poster", () => {
    const freshVideo = () => block({
      block_type: "video", url: null, title: "Clip", media_file: "Media/clip.mp4", preview_manifest: null,
    });

    it("fills a video whose poster is being built, keeping its play badge and its envelope", () => {
      const { container } = renderCard(freshVideo(), true);
      const surface = container.querySelector("[data-card-graphic-surface]")!;
      expect(pendingFill(container)).not.toBeNull();
      expect(surface).toHaveAttribute("data-card-preview-geometry", "pending");
      expect(surface.querySelector("svg")).not.toBeNull();
      expect(screen.queryByText("Clip")).not.toBeInTheDocument();
    });

    it("leaves a video without a poster on its own surface when no poster is coming", () => {
      const { container } = renderCard(freshVideo(), false);
      expect(pendingFill(container)).toBeNull();
      expect(container.querySelector("[data-card-graphic-surface] svg")).not.toBeNull();
    });

    it("fills the slot once every poster candidate has failed during the pass", () => {
      const video = block({
        block_type: "video", url: null, title: "Clip", media_file: "Media/clip.mp4",
        preview_manifest: JSON.stringify({
          kind: "video_poster", primary_preview_path: "clip.jpg", width: 1280, height: 720,
          preview_width: 640, preview_height: 360,
          tiles: [{ source_path: "Media/clip.mp4", preview_path: "clip.preview-1.jpg", width: 1280,
            height: 720, preview_width: 640, preview_height: 360, is_video: true, is_video_poster: true }],
          overflow_count: 0,
        }),
      });
      const { container } = renderCard(video, true);
      expect(pendingFill(container)).toBeNull();
      let poster = container.querySelector("[data-feed-video-poster]");
      while (poster) {
        fireEvent.error(poster);
        poster = container.querySelector("[data-feed-video-poster]");
      }
      expect(pendingFill(container)).not.toBeNull();
    });
  });

  describe("link thumbnail", () => {
    const pageLink = () => block({
      block_type: "link", title: "A page", url: "https://example.com/page",
      preview_manifest: JSON.stringify({
        kind: "image", primary_preview_path: "page.jpg", width: 1200, height: 630,
        preview_width: 600, preview_height: 315,
        tiles: [{ source_path: "https://example.com/og.jpg", preview_path: "page.preview-1.jpg",
          width: 1200, height: 630, preview_width: 600, preview_height: 315,
          is_video: false, is_video_poster: false }],
        overflow_count: 0,
      }),
    });

    it("holds the reserved picture slot with the fill above the text while the picture is on the way", () => {
      const { container } = renderCard(pageLink(), true);
      fireEvent.error(container.querySelector("img")!);
      const surface = container.querySelector("[data-card-graphic-surface]");
      expect(surface).toHaveClass("aspect-video");
      expect(surface?.querySelector("[data-card-preview-pending]")).not.toBeNull();
      expect(surface).toHaveTextContent("");
      expect(screen.getByText("A page")).toBeInTheDocument();
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    it("falls back to the compact card when no picture is coming", () => {
      const { container } = renderCard(pageLink(), false);
      fireEvent.error(container.querySelector("img")!);
      expect(container.querySelector("[data-card-graphic-surface]")).toBeNull();
      expect(screen.getByText("A page")).toBeInTheDocument();
    });

    it("stays compact without a manifest even during the pass: the layout reserved no slot", () => {
      const link = block({ block_type: "link", title: "Bare page", url: "https://example.com/bare" });
      const { container } = renderCard(link, true);
      expect(container.querySelector("[data-card-graphic-surface]")).toBeNull();
      expect(computeCardHeight(link, COLUMN, null)).toBe(CARD_HOVER_ACTION_MIN_HEIGHT);
    });
  });
});
