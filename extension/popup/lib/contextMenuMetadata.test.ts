import { describe, expect, it } from "vitest";
import { applySaveImageContextMenu } from "./contextMenuMetadata";
import type { PageMetadata } from "./messaging";

function meta(overrides: Partial<PageMetadata> = {}): PageMetadata {
  return {
    url: "https://x.com/previous/status/123",
    title: "Previous tweet",
    description: "",
    image: null,
    author: null,
    ogType: null,
    favicon: null,
    selection: "",
    detectedType: "article",
    isArticle: true,
    ...overrides,
  };
}

describe("context menu metadata overrides", () => {
  it("uses the selected image URL as Source for Save image", () => {
    const metadata = meta();

    applySaveImageContextMenu(
      { srcUrl: "https://pbs.twimg.com/media/image.jpg?format=jpg&name=large" },
      metadata,
    );

    expect(metadata.detectedType).toBe("image");
    expect(metadata.imageToSave).toBe("https://pbs.twimg.com/media/image.jpg?format=jpg&name=large");
    expect(metadata.url).toBe("https://pbs.twimg.com/media/image.jpg?format=jpg&name=large");
  });

  it("clears stale page Source for non-durable image URLs", () => {
    const metadata = meta();

    applySaveImageContextMenu({ srcUrl: "blob:https://x.com/local-image" }, metadata);

    expect(metadata.detectedType).toBe("image");
    expect(metadata.imageToSave).toBe("blob:https://x.com/local-image");
    expect(metadata.url).toBe("");
  });
});
