import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Detail } from "./Detail";
import type { IndexedBlock } from "@/types";
import { copyMediaAssetToClipboard, getBlock, prepareDeleteMediaAsset } from "@/lib/commands";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
} from "@/lib/hoverPreviewTiming";

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
  copyMediaAssetToClipboard: vi.fn(),
  prepareDeleteMediaAsset: vi.fn(),
}));

function cardKindForBlockType(blockType: IndexedBlock["block_type"]): IndexedBlock["card_kind"] {
  return blockType === "article"
    ? "article"
    : blockType === "channel"
      ? "channel"
      : "media";
}

function block(overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  const blockType = overrides.block_type ?? "article";
  const cardKind = overrides.card_kind ?? cardKindForBlockType(blockType);
  return {
    id: 1,
    slug: "test-block",
    card_kind: cardKind,
    block_type: blockType,
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
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
    ...overrides,
  };
}

const getBlockMock = vi.mocked(getBlock);
const copyMediaAssetToClipboardMock = vi.mocked(copyMediaAssetToClipboard);
const prepareDeleteMediaAssetMock = vi.mocked(prepareDeleteMediaAsset);

function setViewportWidth(value: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value,
  });
}

describe("Detail", () => {
  const initialViewportWidth = window.innerWidth;

  beforeEach(() => {
    getBlockMock.mockReset();
    getBlockMock.mockResolvedValue(null);
    copyMediaAssetToClipboardMock.mockReset();
    copyMediaAssetToClipboardMock.mockResolvedValue(undefined);
    prepareDeleteMediaAssetMock.mockReset();
    prepareDeleteMediaAssetMock.mockResolvedValue({
      media_ref: "photo.jpg",
      media_kind: "image",
      referenced_by: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setViewportWidth(initialViewportWidth);
  });

  it("renders the classic top menu", () => {
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

    const { container } = render(<Detail {...props} />);

    const topMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(topMenu).not.toBeNull();
    expect(topMenu).toHaveClass("detail-top-bar-enter");
    expect(topMenu).toHaveClass("h-8", "bg-accent", "px-8");
  });

  it("toggles the classic top overflow menu with Command-K", async () => {
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
      />,
    );

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByText("Rename…")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByText("Rename…")).not.toBeInTheDocument();
    });
  });

  it("names the detail dialog with the active filename", () => {
    render(
      <Detail
        block={block({ media_file: "article-cover.jpg" })}
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

    expect(screen.getByRole("dialog", { name: "article-cover.jpg" })).toBeInTheDocument();
  });

  it("keeps classic top chrome mounted and entered when switching active cards", async () => {
    const props = {
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
      <Detail
        {...props}
        block={block({ slug: "first-card", media_file: "first-card.jpg" })}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-detail-top-menu="classic"]')).toHaveAttribute(
        "data-entered",
        "true",
      );
    });

    const topMenu = container.querySelector('[data-detail-top-menu="classic"]');
    expect(topMenu).toHaveTextContent("first-card.jpg");

    rerender(
      <Detail
        {...props}
        block={block({ slug: "second-card", media_file: "second-card.jpg" })}
      />,
    );

    await waitFor(() => {
      expect(topMenu).toHaveTextContent("second-card.jpg");
    });
    expect(container.querySelector('[data-detail-top-menu="classic"]')).toBe(topMenu);
    expect(topMenu).toHaveAttribute("data-entered", "true");
  });

  it("does not close Detail when Escape belongs to a nested menu surface", () => {
    const onClose = vi.fn();
    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={onClose}
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
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);

    fireEvent.keyDown(menu, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    menu.remove();
  });

  it("does not navigate cards with arrow keys in Detail view", () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    render(
      <Detail
        block={block()}
        vaultPath="/tmp/test-vault"
        thumbsRootPath="/tmp/thumbs"
        onClose={onClose}
        onNavigate={onNavigate}
        tags={[]}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onTagsChanged={vi.fn()}
        onRequestRename={vi.fn()}
        onRequestDelete={vi.fn()}
        onOpenRelatedNote={vi.fn()}
      />,
    );

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
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

    const { container, rerender } = render(<Detail {...props} />);

    rerender(<Detail {...props} isClosing />);

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
    expect(metadataTable).toHaveClass("w-full");

    const dateLabel = screen.getByText("Date");
    expect(dateLabel).toHaveClass("font-mono", "text-sm", "leading-4");
    expect(dateLabel).not.toHaveClass("font-semibold", "uppercase", "tracking-widest");
    expect(dateLabel).toHaveClass("whitespace-nowrap");
    expect(dateLabel.closest("[data-metadata-row]")?.tagName).toBe("DIV");
    expect(dateLabel.closest("[data-metadata-row]")).toHaveClass(
      "relative",
      "grid",
      "w-full",
      "grid-cols-[max-content_minmax(0,1fr)]",
      "gap-x-4",
      "pb-2",
      "after:border-border",
    );
    const metadataRows = container.querySelectorAll("[data-metadata-row]");
    expect(metadataRows.length).toBeGreaterThan(0);
    expect(dateLabel.closest("[data-metadata-row]")?.lastElementChild?.firstElementChild).toHaveClass(
      "text-sm",
      "leading-4",
    );
  });

  it("uses one detail canvas grid for content spacer and fixed rail", () => {
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
    const articleColumn = container.querySelector("[data-detail-article-column]");
    expect(articleColumn).toHaveClass("col-start-2", "min-w-0");
    expect(articleColumn).not.toHaveClass("pl-2", "pl-4");
    expect(rail).toHaveClass(
      "col-start-4",
      "min-w-0",
      "overflow-y-auto",
      "overflow-x-hidden",
    );
    const spacer = container.querySelector("[data-detail-metadata-spacer]");
    expect(spacer).toHaveClass("col-start-4", "min-w-0");
    expect(spacer?.parentElement).toHaveClass(
      "w-full",
      "grid",
      "grid-cols-[minmax(2rem,1fr)_minmax(400px,48rem)_minmax(2rem,1fr)_20rem_2rem]",
      "pt-8",
    );
    expect(rail?.parentElement).toHaveClass(
      "w-full",
      "grid",
      "grid-cols-[minmax(2rem,1fr)_minmax(400px,48rem)_minmax(2rem,1fr)_20rem_2rem]",
      "pt-8",
    );
  });

  it("stacks metadata below content once the article would shrink under 400px", async () => {
    setViewportWidth(815);

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

    await waitFor(() => {
      expect(container.querySelector("[data-detail-layout-mode]")).toHaveAttribute(
        "data-detail-layout-mode",
        "stacked",
      );
    });

    const scrollGrid = container.querySelector('[data-detail-layout-grid="scroll"]');
    const articleColumn = container.querySelector("[data-detail-article-column]");
    const stackedMetadataRow = container.querySelector("[data-detail-stacked-metadata-row]");

    expect(scrollGrid).toHaveClass(
      "grid-cols-[2rem_minmax(240px,1fr)_2rem]",
      "pt-8",
      "pb-20",
    );
    expect(articleColumn).toHaveClass(
      "col-start-2",
      "mx-auto",
      "w-full",
      "max-w-[48rem]",
    );
    expect(stackedMetadataRow).toHaveClass("col-start-2", "mt-8", "min-w-0");
    expect(container.querySelector("[data-detail-fixed-metadata-layer]")).toBeNull();
    expect(container.querySelector("[data-detail-metadata-spacer]")).toBeNull();
  });

  it("compensates classic detail chrome so article and rail start at the 64px detail inset", () => {
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

    const articleColumn = container.querySelector("[data-detail-article-column]");
    const rail = container.querySelector("[data-metadata-scroll]");
    expect(articleColumn?.parentElement).toHaveClass("pt-8");
    expect(rail?.parentElement).toHaveClass("pt-8");
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
      "flex",
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
    expect(sourceButton).toHaveClass("min-w-0", "flex-1", "bg-component-fill-inner");
    expect(connectButton).toHaveClass("min-w-0", "flex-1", "bg-component-fill-inner");
    expect(sourceButton).not.toHaveClass("w-full");
    expect(connectButton).not.toHaveClass("w-full");
    expect(screen.queryByRole("button", { name: /More/i })).not.toBeInTheDocument();
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
      "overflow-hidden",
      "rounded-1",
      "border",
      "border-border",
      "bg-accent",
    );
    expect(metadataCard).toHaveStyle({ minWidth: "240px" });
    const metadataContent = metadataCard?.querySelector("[data-detail-metadata-card-content]");
    expect(metadataContent).toHaveClass("px-2", "pb-4", "pt-4");
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

    const dragSurface = container.querySelector<HTMLElement>(
      "[data-detail-inline-media-drag='true']",
    );
    expect(dragSurface).not.toBeNull();
    expect(dragSurface).toHaveClass("not-prose", "[&_img]:m-0", "[&_video]:m-0");
    expect(dragSurface).toHaveClass("select-none");
    expect(dragSurface).toHaveAttribute("draggable", "false");
    for (const img of Array.from(dragSurface!.querySelectorAll("img"))) {
      expect(img).toHaveClass("block", "max-w-full");
    }
    expect(dragSurface!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    )).toBe(false);
    expect(dragSurface!.dispatchEvent(
      new Event("dragstart", { bubbles: true, cancelable: true }),
    )).toBe(false);
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
      card_kind: "article",
      block_type: "image",
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

  it("renders media detail from card_kind instead of legacy block_type", () => {
    const b = block({
      card_kind: "media",
      block_type: "article",
      title: "Photo",
      media_file: "photo.jpg",
      body: "This markdown body must not drive media rendering.",
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

    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "asset://localhost//tmp/test-vault/photo.jpg");
    expect(container.querySelector("[data-article-body]")).toBeNull();
  });

  it("shows the standard overflow menu trigger on image media surfaces", async () => {
    const onRenameMediaAsset = vi.fn().mockResolvedValue(undefined);
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
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
        onRenameMediaAsset={onRenameMediaAsset}
      />,
    );

    const menu = container.querySelector("[data-detail-media-action-menu]");
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass(
      "right-2",
      "top-2",
      "opacity-0",
      "group-hover/detail-media:opacity-100",
    );
    const expandButton = menu!.querySelector("[data-detail-media-expand-button]");
    expect(expandButton).toHaveAttribute("aria-label", "Expand image");
    const trigger = menu!.querySelector("[data-detail-media-more-button]");
    expect(trigger).toHaveAttribute("data-variant", "default");
    expect(trigger).toHaveAttribute("data-size", "icon");
    expect(trigger).toHaveClass(
      "bg-component-fill",
      "hover:outline-component-fill-hover",
    );

    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);

    const dropdownMenu = await screen.findByRole("menu");
    expect(within(dropdownMenu).getByText("Create Card")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Reveal in Finder")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Copy Path")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Copy Media")).toBeInTheDocument();
    const renameItem = within(dropdownMenu).getByText("Rename Media...");
    expect(renameItem).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Remove from Card")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Delete")).toBeInTheDocument();

    fireEvent.click(renameItem);
    const dialog = await screen.findByRole("dialog", { name: "Rename media" });
    const input = within(dialog).getByLabelText("Filename");
    expect(input).toHaveValue("photo");
    fireEvent.change(input, { target: { value: "photo-renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(onRenameMediaAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          media_ref: "photo.jpg",
          media_kind: "image",
          source_slug: "test-block",
          reference_kind: "frontmatter_file",
        }),
        "photo-renamed",
      );
    });
  });

  it("keeps image left click inert, delegates Expand to app-level preview, and opens the media menu on right click", async () => {
    const onOpenImagePreview = vi.fn();
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
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
        onOpenImagePreview={onOpenImagePreview}
      />,
    );

    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "asset://localhost//tmp/test-vault/photo.jpg");

    fireEvent.click(image!);
    expect(onOpenImagePreview).not.toHaveBeenCalled();

    const expandButton = container.querySelector("[data-detail-media-expand-button]");
    expect(expandButton).toHaveAttribute("aria-label", "Expand image");
    fireEvent.click(expandButton!);
    expect(onOpenImagePreview).toHaveBeenCalledWith({
      src: "asset://localhost//tmp/test-vault/photo.jpg",
      mediaRef: "photo.jpg",
    });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();

    fireEvent.contextMenu(image!);
    const dropdownMenu = await screen.findByRole("menu");
    expect(within(dropdownMenu).getByText("Create Card")).toBeInTheDocument();
    expect(within(dropdownMenu).getByText("Rename Media...")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
  });

  it("shows delete media preview, affected cards, and deletes the media asset", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "Photo Card") {
        return block({
          id: 2,
          slug: "Photo Card",
          fallback_label: "Photo Card",
          display_title: "Photo Card",
          card_kind: "media",
          block_type: "image",
          media_file: "photo.jpg",
          thumb_format: "png",
          thumb_mtime: 111,
        });
      }
      if (slug === "Source Article") {
        return block({
          id: 3,
          slug: "Source Article",
          fallback_label: "Source Article",
          display_title: "Source Article",
          card_kind: "article",
          block_type: "article",
          body: "Article body",
          thumb_format: "jpeg",
          thumb_mtime: 222,
        });
      }
      return null;
    });
    prepareDeleteMediaAssetMock.mockResolvedValueOnce({
      media_ref: "photo.jpg",
      media_kind: "image",
      referenced_by: [
        {
          slug: "Photo Card",
          title: "Photo Card",
          display_title: "Photo Card",
          fallback_label: "Photo Card",
          card_kind: "media",
          reference_kinds: ["frontmatter_file"],
        },
        {
          slug: "Source Article",
          title: "Source Article",
          display_title: "Source Article",
          fallback_label: "Source Article",
          card_kind: "article",
          reference_kinds: ["body_embed"],
        },
      ],
    });
    const onDeleteMediaAsset = vi.fn().mockResolvedValue(undefined);
    const onOpenRelatedNote = vi.fn();
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
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
        onDeleteMediaAsset={onDeleteMediaAsset}
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    const trigger = container.querySelector("[data-detail-media-more-button]");
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);

    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Delete"));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete media file?" });
    const photoRow = await within(dialog).findByRole("button", { name: "Photo Card" });
    const sourceRow = within(dialog).getByRole("button", { name: "Source Article" });
    expect(within(dialog).getByText("Connected cards")).toBeInTheDocument();
    const connectedCardsScroll = dialog.querySelector("[data-delete-media-connected-cards-scroll]");
    expect(connectedCardsScroll).toHaveAttribute("data-visible-card-count", "5");
    expect(connectedCardsScroll).toHaveStyle({ maxHeight: "216px" });
    expect(within(dialog).queryByText("Primary media")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Inline media")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("2 cards reference this file.")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("photo.jpg")).not.toBeInTheDocument();
    expect(photoRow).toHaveAttribute("data-related-note-item", "button");
    expect(photoRow).toHaveClass("bg-component-fill", "cursor-pointer");
    expect(sourceRow).toHaveAttribute("data-related-note-item", "button");
    expect(dialog.querySelector("img")).toHaveAttribute(
      "src",
      "asset://localhost//tmp/test-vault/photo.jpg",
    );

    vi.useFakeTimers();
    fireEvent.mouseEnter(photoRow);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    const hoverPreview = document.querySelector("[data-related-note-hover-preview]");
    expect(hoverPreview).not.toBeNull();
    expect(hoverPreview?.parentElement).toBe(document.body);
    expect(dialog.contains(hoverPreview)).toBe(false);
    fireEvent.mouseLeave(photoRow);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    vi.useRealTimers();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete media" }));

    await waitFor(() => {
      expect(onDeleteMediaAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          media_ref: "photo.jpg",
          media_kind: "image",
          source_slug: "test-block",
          reference_kind: "frontmatter_file",
        }),
      );
    });
  });

  it("keeps long connected card titles inside the delete media confirmation width", async () => {
    const longTitle =
      "A very long connected card title that should be truncated inside the media delete confirmation instead of widening the dialog";
    getBlockMock.mockResolvedValueOnce(block({
      id: 4,
      slug: "Long Source Article",
      fallback_label: longTitle,
      display_title: longTitle,
      title: longTitle,
      card_kind: "article",
      block_type: "article",
      body: "Article body",
    }));
    prepareDeleteMediaAssetMock.mockResolvedValueOnce({
      media_ref: "photo.jpg",
      media_kind: "image",
      referenced_by: [
        {
          slug: "Long Source Article",
          title: longTitle,
          display_title: longTitle,
          fallback_label: longTitle,
          card_kind: "article",
          reference_kinds: ["body_embed"],
        },
      ],
    });
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
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
        onOpenRelatedNote={vi.fn()}
      />,
    );

    const trigger = container.querySelector("[data-detail-media-more-button]");
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);
    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Delete"));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete media file?" });
    const row = await within(dialog).findByRole("button", { name: longTitle });
    const scrollArea = dialog.querySelector("[data-delete-media-connected-cards-scroll]");
    const section = row.closest("[data-related-notes-block]");
    const list = row.closest("[data-related-notes-list]");
    const label = row.querySelector("span");

    expect(dialog).toHaveClass("min-w-0", "overflow-hidden");
    expect(scrollArea).toHaveClass("min-w-0", "overflow-y-auto");
    expect(section).toHaveClass("min-w-0");
    expect(list).toHaveClass("w-full", "min-w-0");
    expect(row).toHaveClass("w-full", "min-w-0", "overflow-hidden");
    expect(label).toHaveClass("min-w-0", "flex-1", "truncate");
  });

  it("opens referenced cards from the delete media confirmation", async () => {
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "Source Article") {
        return block({
          id: 3,
          slug: "Source Article",
          fallback_label: "Source Article",
          display_title: "Source Article",
          card_kind: "article",
          block_type: "article",
          body: "Article body",
        });
      }
      return null;
    });
    prepareDeleteMediaAssetMock.mockResolvedValueOnce({
      media_ref: "photo.jpg",
      media_kind: "image",
      referenced_by: [
        {
          slug: "Source Article",
          title: "Source Article",
          display_title: "Source Article",
          fallback_label: "Source Article",
          card_kind: "article",
          reference_kinds: ["body_embed"],
        },
      ],
    });
    const onOpenRelatedNote = vi.fn();
    const b = block({
      card_kind: "media",
      block_type: "image",
      title: "Photo",
      url: null,
      media_file: "photo.jpg",
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
        onOpenRelatedNote={onOpenRelatedNote}
      />,
    );

    const trigger = container.querySelector("[data-detail-media-more-button]");
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    fireEvent.click(trigger!);
    const dropdownMenu = await screen.findByRole("menu");
    fireEvent.click(within(dropdownMenu).getByText("Delete"));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete media file?" });
    const sourceRow = await within(dialog).findByRole("button", { name: "Source Article" });
    fireEvent.click(sourceRow);

    expect(onOpenRelatedNote).toHaveBeenCalledWith("Source Article");
    expect(screen.queryByRole("alertdialog", { name: "Delete media file?" })).not.toBeInTheDocument();
  });

  it("shows the standard overflow menu trigger on video media surfaces", () => {
    const b = block({
      card_kind: "media",
      block_type: "video",
      title: "Clip",
      url: null,
      media_file: "clip.mp4",
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

    expect(container.querySelector("video")).not.toBeNull();
    const menu = container.querySelector("[data-detail-media-action-menu]");
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass("right-2", "top-2");
    const trigger = menu!.querySelector("button");
    expect(trigger).toHaveAttribute("data-variant", "default");
    expect(trigger).toHaveAttribute("data-size", "icon");
    expect(trigger).toHaveClass("bg-component-fill");
  });

  it("renders non-image media files as a file shell even with article legacy type", () => {
    const b = block({
      card_kind: "media",
      block_type: "article",
      title: "Report",
      url: null,
      media_file: "report.pdf",
      body: "# Report body",
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

    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getAllByText("report.pdf").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector("[data-article-body]")).toBeNull();
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
    vi.useFakeTimers();
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          content_heading: "First line from note body",
          display_title: "First line from note body",
          fallback_label: "Related Note",
          title: null,
          thumb_format: "png",
          thumb_mtime: 123,
        });
      }
      if (slug === "second-note") {
        return block({
          id: 3,
          slug: "second-note",
          content_heading: "Second note body",
          display_title: "Second note body",
          fallback_label: "Second Note",
          title: null,
          thumb_format: "jpeg",
          thumb_mtime: 456,
        });
      }
      return null;
    });

    const onOpenRelatedNote = vi.fn();
    render(
      <Detail
        block={block({
          related_notes: ["related-note", "second-note"],
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

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Related Note")).toBeInTheDocument();
    expect(screen.getByText("Second Note")).toBeInTheDocument();
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
      "font-sans",
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
    expect(img).toHaveAttribute("src", "asset://localhost//tmp/thumbs/related-note.jpg?m=123");
    expect(img).toHaveClass("dark:invert");
    expect(row.querySelector("div.flex.h-8.w-full.items-center.gap-2.overflow-hidden")).not.toBeNull();

    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    const relatedPreview = document.querySelector("[data-related-note-hover-preview]");
    expect(relatedPreview).not.toBeNull();
    expect(relatedPreview).toHaveClass("pointer-events-none");
    expect(relatedPreview?.querySelector("button")).toBeNull();
    expect(relatedPreview).not.toHaveTextContent("Connect");
    expect(document.querySelector("[data-related-note-hover-bridge]")).not.toBeInTheDocument();

    const secondRow = screen.getByRole("button", { name: "Second Note" });
    fireEvent.mouseLeave(row);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    fireEvent.mouseEnter(secondRow);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const warmPreview = document.querySelector("[data-related-note-hover-preview]");
    expect(warmPreview).not.toBeNull();
    expect(warmPreview).toHaveTextContent("Second note body");
    expect(warmPreview?.querySelector("button")).toBeNull();

    fireEvent.mouseLeave(secondRow);
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS + 1);
      await Promise.resolve();
    });

    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).not.toBeNull();

    fireEvent.click(row);
    expect(onOpenRelatedNote).toHaveBeenCalledWith("related-note");
  });

  it("does not open related note preview on focus", async () => {
    vi.useFakeTimers();
    getBlockMock.mockImplementation(async (slug: string) => {
      if (slug === "related-note") {
        return block({
          id: 2,
          slug: "related-note",
          fallback_label: "Related Note",
          title: null,
        });
      }
      return null;
    });

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
        onOpenRelatedNote={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = screen.getByRole("button", { name: "Related Note" });
    fireEvent.focus(row);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector("[data-related-note-hover-preview]")).toBeNull();
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
