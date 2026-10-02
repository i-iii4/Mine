import { describe, expect, it } from "vitest";
import { cardPreviewState } from "./cardPreviewState";

describe("cardPreviewState (SPEC_CARD_MEDIA_GEOMETRY.md, «Карточка без превью»)", () => {
  const plain = { content_in_cloud: false, preview_unreadable: false };

  it("takes a card without a preview as waiting for it while the preview pass runs", () => {
    expect(cardPreviewState(plain, true)).toBe("pending");
  });

  it("takes the same card as missing once no pass is running", () => {
    expect(cardPreviewState(plain, false)).toBe("missing");
    expect(cardPreviewState({}, false)).toBe("missing");
  });

  it("keeps a broken preview file unreadable whatever the pass is doing", () => {
    const unreadable = { ...plain, preview_unreadable: true };
    expect(cardPreviewState(unreadable, true)).toBe("unreadable");
    expect(cardPreviewState(unreadable, false)).toBe("unreadable");
  });

  it("keeps content held by iCloud pending whatever the pass is doing (SPEC_CLOUD_STORAGE.md, Х6)", () => {
    const inCloud = { ...plain, content_in_cloud: true };
    expect(cardPreviewState(inCloud, true)).toBe("pending");
    expect(cardPreviewState(inCloud, false)).toBe("pending");
  });
});
