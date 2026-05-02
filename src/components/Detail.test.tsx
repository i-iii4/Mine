import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Detail } from "./Detail";
import type { IndexedBlock } from "@/types";
import { getBlock } from "@/lib/commands";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("./ArticleAudioControls", () => ({
  ArticleAudioControls: () => <div data-testid="article-audio-controls" />,
}));

vi.mock("./VideoFromBlob", () => ({
  VideoFromBlob: ({
    src,
    controls,
    autoPlay,
    muted,
    loop,
  }: {
    src: string;
    controls?: boolean;
    autoPlay?: boolean;
    muted?: boolean;
    loop?: boolean;
  }) => (
    <div
      data-src={src}
      data-controls={controls ? "true" : "false"}
      data-autoplay={autoPlay ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-loop={loop ? "true" : "false"}
      data-testid="video-from-blob"
    />
  ),
}));

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(),
}));

function block(overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  return {
    id: 1,
    slug: "test-block",
    block_type: "article",
    title: "Test Block",
    description: null,
    url: "https://example.com/article",
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    related_notes: [],
    body_hash: null,
    tags: [],
    ...overrides,
  };
}

const getBlockMock = vi.mocked(getBlock);

describe("Detail", () => {
  beforeEach(() => {
    getBlockMock.mockReset();
    getBlockMock.mockResolvedValue(null);
  });

  it("renders the selected top menu mode", () => {
    const props = {
      block: block(),
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
    };

    const { container, rerender } = render(
      <Detail {...props} detailTopMenuMode="classic" />,
    );

    expect(container.querySelector('[data-detail-top-menu="classic"]')).not.toBeNull();

    rerender(<Detail {...props} detailTopMenuMode="island" />);

    const islandMenu = container.querySelector('[data-detail-top-menu="island"]');
    expect(islandMenu).not.toBeNull();
    expect(islandMenu).toHaveClass("bg-accent/80");
    expect(islandMenu).toHaveClass("backdrop-blur-sm");
    expect(islandMenu).toHaveClass("backdrop-saturate-150");
    expect(islandMenu).toHaveClass("detail-top-pill-enter");
    expect(islandMenu).toHaveClass("pl-3");
    expect(islandMenu).toHaveClass("pr-1");
  });

  it("animates the classic header and its separator as separate chrome layers", () => {
    const { container } = render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        detailTopMenuMode="classic"
      />,
    );

    const classicMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(classicMenu).toHaveClass("detail-top-bar-enter");
    expect(classicMenu).not.toHaveClass("border-b");
    const line = classicMenu?.querySelector("span[aria-hidden='true']");
    expect(line).toHaveClass("detail-top-bar-line-enter");
    expect(line).toHaveClass("bg-border");
  });

  it("reverses the top chrome enter state while closing", () => {
    const props = {
      block: block(),
      vaultPath: "/tmp/test-vault",
      thumbsRootPath: "/tmp/thumbs",
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      tags: [],
      onToggleTag: vi.fn(),
      onCreateAndAssign: vi.fn(),
      onTagsChanged: vi.fn(),
      onRequestRename: vi.fn(),
      onRequestDelete: vi.fn(),
      onOpenRelatedNote: vi.fn(),
    };

    const { container, rerender } = render(
      <Detail {...props} detailTopMenuMode="classic" />,
    );

    rerender(<Detail {...props} detailTopMenuMode="classic" isClosing />);

    const classicMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(classicMenu).toHaveAttribute("data-entered", "false");
    expect(classicMenu?.querySelector("span[aria-hidden='true']")).toHaveAttribute(
      "data-entered",
      "false",
    );
  });

  it("keeps bottom safe space inside the scroll content", () => {
    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const scrollEl = container.querySelector("[data-detail-scroll]");
    expect(scrollEl).not.toHaveClass("pb-20");
    expect(scrollEl?.firstElementChild).toHaveClass("pb-20");
  });

  it("shows article author only in metadata, not above the opened article body", () => {
    render(
      <Detail
        block={block({
          author: "Author Name",
          body: "# Heading\n\nArticle body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Author")).toBeInTheDocument();
    expect(screen.getAllByText("Author Name")).toHaveLength(1);
  });

  it("truncates identifier metadata values instead of wrapping them", () => {
    render(
      <Detail
        block={block({
          author: "@meanwhile_really_long_handle",
          body: "Article body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("@meanwhile_really_long_handle")).toHaveClass(
      "min-w-0",
      "truncate",
    );
    expect(screen.getByText("@meanwhile_really_long_handle")).toHaveAttribute(
      "title",
      "@meanwhile_really_long_handle",
    );
  });

  it("wraps warning metadata while keeping the shared rail layout", () => {
    render(
      <Detail
        block={block({
          body: "Article body",
          index_warning: "malformed_frontmatter",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Malformed frontmatter, shown as Markdown")).toHaveClass(
      "min-w-0",
      "break-words",
      "[overflow-wrap:anywhere]",
    );
  });

  it("renders metadata as a shared two-column grid", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "Article body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const metadataTable = container.querySelector("[data-metadata-table]");
    expect(metadataTable).toHaveClass(
      "w-full",
      "grid",
      "grid-cols-[max-content_minmax(0,1fr)]",
      "gap-x-4",
      "gap-y-2",
    );

    const dateLabel = screen.getByText("Date");
    expect(dateLabel).toHaveClass("font-sans", "text-sm", "leading-4");
    expect(dateLabel).not.toHaveClass("font-semibold", "uppercase", "tracking-widest");
    expect(dateLabel).toHaveClass("whitespace-nowrap");
    expect(dateLabel.closest("[data-metadata-row]")?.tagName).toBe("DIV");
    expect(dateLabel.closest("[data-metadata-row]")).toHaveClass("contents");
    const metadataRows = container.querySelectorAll("[data-metadata-row]");
    expect(metadataRows.length).toBeGreaterThan(0);
    expect(dateLabel.closest("[data-metadata-row]")?.lastElementChild?.firstElementChild).toHaveClass(
      "text-sm",
      "leading-4",
    );
  });

  it("uses a fixed right rail without horizontal overflow", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "Article body",
          author: "@meanwhile_really_long_handle",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const rail = container.querySelector("[data-metadata-scroll]");
    expect(rail).toHaveClass(
      "w-72",
      "min-w-0",
      "shrink-0",
      "overflow-y-auto",
      "overflow-x-hidden",
    );
    const spacer = container.querySelector("[data-detail-metadata-spacer]");
    expect(spacer).toHaveClass("w-72", "min-w-0", "shrink-0");
  });

  it("keeps related notes as a separate block below the metadata table", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "Related Note Title",
          display_title: "Related Note Title",
          title: null,
          related_notes: [],
        });
      }
      return null;
    });

    render(
      <Detail
        block={block({ related_notes: ["related-note"] })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await waitFor(() => {
      const label = screen.getByText("Related notes");
      expect(label.closest("[data-metadata-row]")).toBeNull();
      expect(label.parentElement).toHaveAttribute("data-related-notes-block");
      expect(label.parentElement).toHaveClass("flex", "flex-col", "gap-1");
      expect(label.parentElement?.parentElement).toHaveAttribute("data-metadata-sections");
      expect(label.parentElement?.parentElement).toHaveClass("gap-6");
    });
  });

  it("places the detail action row between metadata and related notes with intrinsic button widths", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          fallback_label: "Related Note",
          related_notes: [],
        });
      }
      return null;
    });

    const { container } = render(
      <Detail
        block={block({ related_notes: ["related-note"] })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Related Note")).toBeInTheDocument();
    });

    const sections = container.querySelector("[data-metadata-sections]");
    const actionRow = container.querySelector("[data-detail-action-row]");
    const relatedNotesBlock = container.querySelector("[data-related-notes-block]");
    expect(sections).toHaveClass("gap-6");
    expect(actionRow).toHaveClass(
      "min-w-0",
      "grid",
      "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]",
      "items-center",
      "gap-2",
      "px-2",
      "pb-2",
    );
    const metadataCard = actionRow?.closest("[data-detail-metadata-card]");
    expect(metadataCard?.querySelector("[data-metadata-table]")).not.toBeNull();
    expect(metadataCard?.nextElementSibling).toBe(relatedNotesBlock);

    const sourceButton = screen.getByRole("button", { name: /Source/i });
    const connectButton = screen.getByRole("button", { name: /Connect/i });
    expect(sourceButton).toHaveClass("min-w-0");
    expect(connectButton).toHaveClass("min-w-0");
    expect(sourceButton).not.toHaveClass("w-full");
    expect(connectButton).not.toHaveClass("w-full");
  });

  it("frames metadata and detail actions as one rounded card", () => {
    const { container } = render(
      <Detail
        block={block({ body: "Article body" })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const metadataCard = container.querySelector("[data-detail-metadata-card]");
    expect(metadataCard).toHaveClass(
      "min-w-0",
      "overflow-hidden",
      "rounded-[var(--radius-card)]",
      "border",
      "border-border",
      "bg-background",
    );
    const metadataContent = metadataCard?.querySelector("[data-detail-metadata-card-content]");
    expect(metadataContent).toHaveClass("p-4");
    expect(metadataCard?.querySelector("[data-metadata-table]")).not.toBeNull();
    expect(metadataCard?.querySelector("[data-detail-action-row]")).not.toBeNull();
  });

  it("keeps a stable top inset for article content after author removal", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "# Heading\n\nArticle body",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const articleBody = container.querySelector("[data-article-body]");
    expect(articleBody).toHaveClass(
      "prose",
      "prose-sm",
      "max-w-none",
      "[&>:first-child]:mt-0",
      "[&_p]:leading-5",
      "[&_li]:leading-5",
    );
  });

  it("does not attach Mine behavior to native selected-text drag", () => {
    const { container } = render(
      <Detail
        block={block({
          body: "Alpha beta gamma",
          body_hash: "body-hash-1",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const article = container.querySelector<HTMLElement>("[data-article-body]");
    const paragraph = article?.querySelector("p");
    const textNode = paragraph?.firstChild;
    expect(article).not.toHaveAttribute("role", "button");
    expect(textNode?.textContent).toBe("Alpha beta gamma");

    const range = document.createRange();
    range.setStart(textNode!, "Alpha ".length);
    range.setEnd(textNode!, "Alpha beta".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.dragStart(paragraph!);
    expect(article).not.toHaveAttribute("data-dnd-kit-draggable");
    expect(screen.queryByRole("button", {
      name: "Drag selected text to a collection",
    })).not.toBeInTheDocument();
    selection?.removeAllRanges();
  });

  it("shows a separate drag handle for selected text without hijacking article pointer input", async () => {
    const onTextSelectionDrop = vi.fn();
    const { container } = render(
      <Detail
        block={block({
          body: "Alpha beta gamma",
          body_hash: "body-hash-1",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onTextSelectionDrop={onTextSelectionDrop}
      />,
    );

    const paragraph = container.querySelector("p")!;
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, "Alpha ".length);
    range.setEnd(textNode, "Alpha beta".length);
    Object.defineProperty(range, "getClientRects", {
      value: vi.fn(() => [
        { left: 40, right: 140, top: 20, bottom: 40, width: 100, height: 20 },
      ]),
    });
    Object.defineProperty(paragraph, "getBoundingClientRect", {
      value: vi.fn(() => ({ left: 40, right: 200, top: 20, bottom: 40, width: 160, height: 20 })),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const row = document.createElement("div");
    row.dataset.sidebarTextDropTag = "alpha";
    document.body.appendChild(row);
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => row),
    });

    document.dispatchEvent(new Event("selectionchange"));
    const handle = await screen.findByRole("button", {
      name: "Drag selected text to a collection",
    });
    expect(handle).toBeInTheDocument();

    fireEvent.pointerDown(paragraph, {
      button: 0,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });

    expect(row).not.toHaveAttribute("data-selected-text-over");

    fireEvent.pointerUp(window, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 10,
    });

    expect(onTextSelectionDrop).not.toHaveBeenCalled();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
    row.remove();
    selection?.removeAllRanges();
  });

  it("marks duplicate rendered markdown blocks with source offsets for deterministic anchoring", () => {
    const body = "Repeat\n\nRepeat";
    const { container } = render(
      <Detail
        block={block({
          body,
          body_hash: "body-hash-1",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const paragraphs = container.querySelectorAll("p");
    const secondParagraph = paragraphs[1];
    const textNode = secondParagraph.firstChild!;
    expect(secondParagraph).toHaveAttribute("data-mine-md-start", "8");
    expect(secondParagraph).toHaveAttribute("data-mine-md-end", "14");

    expect(textNode.textContent).toBe("Repeat");
  });

  it("decodes local wikilink image paths for original media and preview lookup", () => {
    const b = block({
      body: "![[Title (image 1).jpg]]",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "test-block.jpg",
        width: 1200,
        height: 628,
        tiles: [
          {
            source_path: "Title (image 1).jpg",
            preview_path: "Title (image 1)-preview.jpg",
            width: 1200,
            height: 628,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const imageSrcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(imageSrcs).toContain("asset://localhost//tmp/test-vault/Title (image 1).jpg");
    expect(imageSrcs).toContain("asset://localhost//tmp/thumbs/Title (image 1)-preview.jpg");
  });

  it("uses resolved backend tile path for bare Obsidian attachment embeds", () => {
    const b = block({
      body: "![[01.jpg]]",
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "test-block.jpg",
        width: 1200,
        height: 628,
        tiles: [
          {
            source_path: "Библиотека/images/images/01.jpg",
            preview_path: null,
            width: 1200,
            height: 628,
            is_video: false,
            is_video_poster: false,
          },
        ],
        overflow_count: 0,
      }),
    });

    const { container } = render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    const imageSrcs = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(imageSrcs).toContain("asset://localhost//tmp/test-vault/Библиотека/images/images/01.jpg");
  });

  it("decodes local wikilink video paths before handing them to VideoFromBlob", () => {
    const b = block({
      body: "![[Clip (video 1).mp4]]",
    });

    render(
      <Detail
        block={b}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    expect(screen.getByTestId("video-from-blob")).toHaveAttribute(
      "data-src",
      "asset://localhost//tmp/test-vault/Clip (video 1).mp4",
    );
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-controls", "true");
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-autoplay", "true");
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-muted", "true");
    expect(screen.getByTestId("video-from-blob")).toHaveAttribute("data-loop", "true");
  });

  it("renders article headings with design-system typography instead of prose defaults", () => {
    render(
      <Detail
        block={block({
          body: "# Heading\n\n## Section",
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toHaveClass(
      "text-lg",
      "leading-6",
      "font-semibold",
    );
    expect(screen.getByRole("heading", { level: 2, name: "Section" })).toHaveClass(
      "text-base",
      "leading-5",
      "font-semibold",
    );
  });

  it("renders related notes as sidebar-sized rows with thumbnail and filename", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "First line from note body",
          display_title: "First line from note body",
          fallback_label: "Related Note",
          title: null,
        });
      }
      return null;
    });

    const onOpenRelatedNote = vi.fn();
    render(
      <Detail
        block={block({
          related_notes: ["related-note"],
        })}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Related Note")).toBeInTheDocument();
    });
    expect(screen.queryByText("First line from note body")).not.toBeInTheDocument();

    const row = screen.getByRole("button", { name: "Related Note" });
    expect(row).toHaveAttribute("data-related-note-item", "button");
    expect(row).toHaveClass(
      "rounded-1",
      "border",
      "border-border",
      "bg-component-fill",
      "p-[3px]",
      "cursor-pointer",
      "font-mono",
      "text-base",
      "text-muted-foreground",
    );
    expect(row).toHaveClass(
      "hover:outline-1",
      "hover:-outline-offset-1",
      "hover:outline-component-fill-hover",
      "focus-visible:outline-1",
      "focus-visible:-outline-offset-1",
      "focus-visible:outline-component-fill-hover",
    );

    const img = row.querySelector("img");
    expect(img).toHaveAttribute("src", "asset://localhost//tmp/thumbs/related-note.jpg");
    expect(row.querySelector("div.flex.h-8.w-full.items-center.gap-2.overflow-hidden")).not.toBeNull();

    fireEvent.mouseEnter(row);
    await waitFor(() => {
      expect(document.querySelector("[data-related-note-hover-preview]")).not.toBeNull();
    });

    fireEvent.click(row);
    expect(onOpenRelatedNote).toHaveBeenCalledWith("related-note");
  });

  it("refreshes related notes in-place after a vault snapshot refresh", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "test-block") {
        return block({
          related_notes: ["related-note"],
        });
      }
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "First line from note body",
          display_title: "First line from note body",
          fallback_label: "Related Note",
          title: null,
        });
      }
      return null;
    });

    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    expect(screen.queryByText("Related notes")).not.toBeInTheDocument();

    window.dispatchEvent(new Event("vault-refreshed"));

    await waitFor(() => {
      expect(screen.getByText("Related notes")).toBeInTheDocument();
      expect(screen.getByText("Related Note")).toBeInTheDocument();
    });
    expect(screen.queryByText("First line from note body")).not.toBeInTheDocument();
  });
});
