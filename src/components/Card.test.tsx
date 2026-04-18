import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Card } from "./Card";
import type { LightBlock } from "@/types";

function block(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "test-block",
    block_type: "link",
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

  // ── Image card ────────────────────────────────────────────────────────

  it("renders image card from the generated preview thumbnail", () => {
    const b = block({
      block_type: "image",
      media_file: "sunset.jpg",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", expect.stringContaining("/.arena/cache/thumbs/test-block.jpg"));
  });

  it("renders image card alt text from the title", () => {
    const b = block({ block_type: "image", title: "Sunset" });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveAttribute("alt", "Sunset");
  });

  it("renders broken image fallback on error", () => {
    const b = block({
      block_type: "image",
      media_file: "missing.jpg",
      title: "Missing Image",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    const img = screen.getByRole("img");
    fireEvent.error(img);
    // After error, the fallback should show the title
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

  it("renders article composite overlay for multiple embedded images", () => {
    const b = block({
      block_type: "article",
      title: "Gallery Article",
      body: "One\n![](a.jpg)\n![](b.jpg)\n![](c.jpg)",
      first_image: "a.jpg",
      media_urls: "[\"a.jpg\",\"b.jpg\",\"c.jpg\"]",
      media_dimensions: "{\"a.jpg\":[800,600],\"b.jpg\":[600,800],\"c.jpg\":[900,900]}",
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
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
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeInTheDocument();
    // Play button SVG
    const playIcon = container.querySelector("svg path[d]");
    expect(playIcon).toBeInTheDocument();
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
    });
    const { container } = render(
      <Card block={b} vaultPath={VAULT} onClick={vi.fn()} />,
    );
    expect(container.querySelector("video")).toBeInTheDocument();
    expect(screen.getByText("Video Article")).toBeInTheDocument();
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
      media_file: null,
    });
    render(<Card block={b} vaultPath={VAULT} onClick={vi.fn()} />);
    expect(screen.getByText("FILE")).toBeInTheDocument();
  });
});
