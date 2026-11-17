import { describe, expect, it } from "vitest";
import type { LightBlock } from "@/types";
import {
  blockLayoutSignatureHash,
  buildBlockLayoutSignature,
  buildFeedSignature,
  buildLayoutGenerationKey,
} from "./layoutGeneration";
import { getMasonryColumnCount, getMasonryColumnWidth } from "./masonryLayout";
import { lightBlock } from "@/test/blocks";

function makeBlock(id: number, overrides: Partial<LightBlock> = {}): LightBlock {
  return lightBlock({
    id,
    slug: `block-${id}`,
    block_type: "article",
    title: `Block ${id}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `Body text for block ${id}`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    ...overrides,
  });
}

function generationKey(blocks: LightBlock[], parentWidth = 1200): string {
  return buildLayoutGenerationKey({
    blocks,
    routeKey: "__all__",
    columnWidth: getMasonryColumnWidth(parentWidth, 220, 32),
    columnCount: getMasonryColumnCount(parentWidth, 220, 32),
  });
}

it("invalidates layout for artifact and tile geometry without source-size changes", () => {
  const manifest = { kind: "image", primary_preview_path: "photo.jpg", width: null,
    height: null, preview_width: 480, preview_height: 640, overflow_count: 0,
    tiles: [{ source_path: "photo.jpg", preview_path: "tile.jpg", preview_width: 480,
      preview_height: 640, is_video: false }] };
  const original = makeBlock(1, { preview_manifest: JSON.stringify(manifest) });
  const resized = { ...original, preview_manifest: JSON.stringify({ ...manifest, preview_height: 480 }) };
  const tileResized = { ...original, preview_manifest: JSON.stringify({ ...manifest,
    tiles: [{ ...manifest.tiles[0], preview_height: 480 }] }) };
  expect(generationKey([original])).not.toBe(generationKey([resized]));
  expect(generationKey([original])).not.toBe(generationKey([tileResized]));
});

describe("buildBlockLayoutSignature", () => {
  it("changes when preview manifest kind changes", () => {
    const base = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [],
        overflow_count: 0,
      }),
    });
    const changed = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [
          { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
          { source_path: "b.jpg", preview_path: "b.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });

    expect(buildBlockLayoutSignature(base)).not.toBe(buildBlockLayoutSignature(changed));
  });

  it("changes when title or body changes", () => {
    const base = makeBlock(1);
    expect(buildBlockLayoutSignature(base)).not.toBe(
      buildBlockLayoutSignature(makeBlock(1, { title: "Changed" })),
    );
    expect(buildBlockLayoutSignature(base)).not.toBe(
      buildBlockLayoutSignature(makeBlock(1, { body: "Updated body" })),
    );
  });
});

describe("buildLayoutGenerationKey", () => {
  it("changes when preview manifest tile count changes at same block id", () => {
    const oneTile = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [
          { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });
    const twoTiles = makeBlock(1, {
      preview_manifest: JSON.stringify({
        kind: "composite",
        primary_preview_path: "block-1.jpg",
        width: 480,
        height: 480,
        tiles: [
          { source_path: "a.jpg", preview_path: "a.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
          { source_path: "b.jpg", preview_path: "b.jpg", width: 480, height: 480, is_video: false, is_video_poster: false },
        ],
        overflow_count: 0,
      }),
    });

    expect(generationKey([oneTile])).not.toBe(generationKey([twoTiles]));
  });

  it("changes when author changes at same block id", () => {
    expect(generationKey([makeBlock(1, { author: "A" })])).not.toBe(
      generationKey([makeBlock(1, { author: "B" })]),
    );
  });

  it("changes with the presentation, so the cache never serves another one's heights (SPEC_FEED_DISPLAY.md, Д15)", () => {
    const blocks = [makeBlock(1), makeBlock(2)];
    const keyFor = (show: "cards" | "media" | undefined) => buildLayoutGenerationKey({
      blocks,
      routeKey: "__all__",
      columnWidth: getMasonryColumnWidth(1200, 220, 32),
      columnCount: getMasonryColumnCount(1200, 220, 32),
      layoutGap: 32,
      show,
    });
    expect(keyFor("media")).not.toBe(keyFor("cards"));
    // Cards is the default presentation: an unset one is the same layout.
    expect(keyFor(undefined)).toBe(keyFor("cards"));
  });
});

// SPEC_GRID.md, «Кэш при карточке и продолжение раскладки».
describe("buildFeedSignature", () => {
  const list = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => makeBlock(from + index, { preview_text: `Text ${from + index}` }));

  it("is the same whether folded anew or continued from another list's", () => {
    const base = list(1, 60);
    const held = buildFeedSignature(base);
    const changed = makeBlock(20, { title: "Changed" });
    const lists: LightBlock[][] = [
      [...base, ...list(100, 25)],
      base.map((block) => (block.id === 20 ? changed : block)),
      base.filter((block) => block.id !== 7),
      [base[3]!, ...base.slice(0, 3), ...base.slice(4)],
      base.slice(0, 10),
      [],
      list(500, 5),
    ];
    for (const blocks of lists) {
      const continued = buildFeedSignature(blocks, held);
      const anew = buildFeedSignature(blocks);
      expect(continued.hash).toBe(anew.hash);
      expect(continued.blocks).toBe(blocks);
      expect([...continued.card1]).toEqual([...anew.card1]);
      expect([...continued.card2]).toEqual([...anew.card2]);
      expect([...continued.fold1]).toEqual([...anew.fold1]);
      expect([...continued.fold2]).toEqual([...anew.fold2]);
      // A signature continued twice is still the list's own.
      expect(buildFeedSignature(base, continued).hash).toBe(held.hash);
    }
  });

  it("is the signature it was given for a list of the same cards", () => {
    const base = list(1, 30);
    const held = buildFeedSignature(base);
    expect(buildFeedSignature([...base], held)).toBe(held);
  });

  it("differs when a card changes, leaves, arrives or changes places", () => {
    const base = list(1, 30);
    const hash = buildFeedSignature(base).hash;
    const others = [
      base.map((block) => (block.id === 5 ? makeBlock(5, { preview_text: "Other text" }) : block)),
      base.slice(1),
      [...base, makeBlock(99)],
      [base[1]!, base[0]!, ...base.slice(2)],
    ];
    for (const blocks of others) expect(buildFeedSignature(blocks).hash).not.toBe(hash);
  });

  it("hashes a row once, and a changed row anew", () => {
    const block = makeBlock(1);
    expect(blockLayoutSignatureHash(block)).toBe(blockLayoutSignatureHash(block));
    expect(blockLayoutSignatureHash({ ...block })).toEqual(blockLayoutSignatureHash(block));
    expect(blockLayoutSignatureHash({ ...block, author: "Someone" })).not.toEqual(blockLayoutSignatureHash(block));
  });

  it("tells apart two rows whose neighbouring fields share their letters", () => {
    const first = makeBlock(1, { title: "ab", author: "c" });
    const second = makeBlock(1, { title: "a", author: "bc" });
    expect(buildBlockLayoutSignature(first)).not.toBe(buildBlockLayoutSignature(second));
  });
});

describe("the generation key and the list's signature", () => {
  const blocks = [makeBlock(1), makeBlock(2), makeBlock(3)];
  const keyAt = (parentWidth: number, signature?: ReturnType<typeof buildFeedSignature>) => buildLayoutGenerationKey({
    blocks,
    signature,
    routeKey: "__all__",
    columnWidth: getMasonryColumnWidth(parentWidth, 220, 32),
    columnCount: getMasonryColumnCount(parentWidth, 220, 32),
  });

  it("is the same with the signature handed in and computed", () => {
    expect(keyAt(1200, buildFeedSignature(blocks))).toBe(keyAt(1200));
  });

  it("keeps the cards' part for another width: only the columns' part changes", () => {
    const signature = buildFeedSignature(blocks);
    const wide = keyAt(1200, signature).split("|");
    const narrow = keyAt(700, signature).split("|");
    const part = (key: string[], name: string) => key.find((field) => field.startsWith(`${name}=`));
    expect(part(narrow, "sig")).toBe(part(wide, "sig"));
    expect(part(narrow, "sig")).toBe(`sig=${signature.hash}`);
    expect(part(narrow, "cw")).not.toBe(part(wide, "cw"));
  });
});
