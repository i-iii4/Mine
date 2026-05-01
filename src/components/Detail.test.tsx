import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Detail } from "./Detail";
import type { IndexedBlock } from "@/types";

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
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    related_notes: [],
    body_hash: null,
    tags: [],
    ...overrides,
  };
}

describe("Detail", () => {
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
    expect(islandMenu).toHaveClass("pl-3");
    expect(islandMenu).toHaveClass("pr-1");
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
});
