import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { LightBlock } from "@/types";
import { MeasureCard } from "./MeasureCard";

function block(overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id: 1,
    slug: "test-block",
    block_type: "image",
    title: "Test Block",
    url: null,
    media_file: "media.mp4",
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: 1920,
    height: 1080,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    ...overrides,
  };
}

describe("MeasureCard", () => {
  it("does not mount image elements for image previews", () => {
    const { container } = render(
      <MeasureCard
        block={block({ block_type: "image", media_file: "photo.jpg" })}
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });

  it("does not mount video elements for video previews", () => {
    const { container } = render(
      <MeasureCard
        block={block({ block_type: "video", media_file: "clip.mp4" })}
        vaultPath="/tmp/vault"
        thumbsRootPath="/tmp/thumbs"
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });
});
