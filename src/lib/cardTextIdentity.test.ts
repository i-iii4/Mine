import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LightBlock } from "@/types";

const { font, reads } = vi.hoisted(() => ({ font: { hash: "font-a" }, reads: { count: 0 } }));

vi.mock("@/lib/fontMetrics", () => ({
  getFontHash: () => font.hash,
  createFontMetricsCacheIdentity: (block: LightBlock) => {
    reads.count += 1;
    return {
      blockId: block.id,
      fontHash: font.hash,
      textHash: `${block.title}|${block.preview_text}`,
      cacheKey: `${font.hash}:${block.id}:${block.title}|${block.preview_text}`,
      title: block.title ?? "",
      preview: block.preview_text ?? "",
    };
  },
}));

import { lightBlock } from "@/test/blocks";
import { cardTextIdentity } from "./cardTextIdentity";

beforeEach(() => {
  font.hash = "font-a";
  reads.count = 0;
});

// SPEC_GRID.md, «Кэш при карточке и продолжение раскладки».
describe("cardTextIdentity", () => {
  it("reads a row's text once under one font", () => {
    const block = lightBlock({ id: 1, title: "Title", preview_text: "Text" });
    const identity = cardTextIdentity(block);
    expect(cardTextIdentity(block)).toBe(identity);
    expect(reads.count).toBe(1);
    expect(identity.cacheKey).toBe("font-a:1:Title|Text");
  });

  it("reads a changed row anew and leaves the row it replaced as it was", () => {
    const block = lightBlock({ id: 1, title: "Title", preview_text: "Text" });
    const before = cardTextIdentity(block);
    const changed = { ...block, preview_text: "Other text" };
    expect(cardTextIdentity(changed).textHash).toBe("Title|Other text");
    expect(cardTextIdentity(block)).toBe(before);
    expect(reads.count).toBe(2);
  });

  it("reads the same row again under another font", () => {
    const block = lightBlock({ id: 1, title: "Title", preview_text: "Text" });
    cardTextIdentity(block);
    font.hash = "font-b";
    expect(cardTextIdentity(block).cacheKey).toBe("font-b:1:Title|Text");
    expect(cardTextIdentity(block).fontHash).toBe("font-b");
    expect(reads.count).toBe(2);
  });
});
