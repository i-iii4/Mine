import { describe, expect, it } from "vitest";
import { cardSlugOfPreviewPath, previewAssetUrl, thumbnailLevelUrl, thumbnailUrl } from "@/lib/assets";
import { cardPicturesVersion, noteSpaceShown } from "@/lib/pictureVersions";

// SPEC_THUMBNAILS.md, «Адрес картинки»: the address of every picture of a
// card moves once its pictures were written again, and no address names two
// versions of a file within a page.

const announce = (slug: string) => {
  window.dispatchEvent(new CustomEvent("thumb:updated", { detail: { payload: { slug, is_text: false } } }));
};

describe("the version of a card's pictures", () => {
  it("leaves the addresses as they were until the pictures change", () => {
    expect(cardPicturesVersion("Cards/Gallery")).toBe("");
    expect(thumbnailUrl("/thumbs", "Cards/Gallery")).toBe("asset://localhost//thumbs/Cards/Gallery.jpg");
  });

  it("moves every address of the card on thumb:updated, and only of that card", () => {
    const before = [
      thumbnailUrl("/thumbs", "Cards/Gallery"),
      thumbnailLevelUrl("/thumbs", "Cards/Gallery", "micro"),
      previewAssetUrl("/thumbs", "Cards/Gallery.jpg"),
      previewAssetUrl("/thumbs", "Cards/Gallery.preview-1.jpg"),
      previewAssetUrl("/thumbs", "Cards/Gallery.preview-4.jpg"),
    ];
    const other = previewAssetUrl("/thumbs", "Cards/Other.preview-1.jpg");

    announce("Cards/Gallery");

    const after = [
      thumbnailUrl("/thumbs", "Cards/Gallery"),
      thumbnailLevelUrl("/thumbs", "Cards/Gallery", "micro"),
      previewAssetUrl("/thumbs", "Cards/Gallery.jpg"),
      previewAssetUrl("/thumbs", "Cards/Gallery.preview-1.jpg"),
      previewAssetUrl("/thumbs", "Cards/Gallery.preview-4.jpg"),
    ];
    after.forEach((address, index) => {
      const previous = before[index] ?? "";
      expect(address).not.toBe(previous);
      expect(address.startsWith(previous)).toBe(true);
    });
    expect(previewAssetUrl("/thumbs", "Cards/Other.preview-1.jpg")).toBe(other);

    announce("Cards/Gallery");
    expect(previewAssetUrl("/thumbs", "Cards/Gallery.preview-1.jpg")).not.toBe(after[3]);
  });

  it("moves every address when the page comes back to a space it showed before", () => {
    noteSpaceShown("/spaces/A/thumbs");
    const first = previewAssetUrl("/spaces/A/thumbs", "Cards/Gallery.preview-2.jpg");
    noteSpaceShown("/spaces/A/thumbs");
    expect(previewAssetUrl("/spaces/A/thumbs", "Cards/Gallery.preview-2.jpg")).toBe(first);

    noteSpaceShown("/spaces/B/thumbs");
    noteSpaceShown("/spaces/A/thumbs");

    expect(previewAssetUrl("/spaces/A/thumbs", "Cards/Gallery.preview-2.jpg")).not.toBe(first);
  });

  it("finds the card of a preview by the name the backend gives it", () => {
    expect(cardSlugOfPreviewPath("Cards/Gallery.jpg")).toBe("Cards/Gallery");
    expect(cardSlugOfPreviewPath("Cards/Gallery.preview-12.jpg")).toBe("Cards/Gallery");
    expect(cardSlugOfPreviewPath("Cards/What does it mean, maybe. Yes.jpg")).toBe("Cards/What does it mean, maybe. Yes");
  });
});
