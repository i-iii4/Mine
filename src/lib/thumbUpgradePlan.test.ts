import { describe, expect, it } from "vitest";
import {
  blockThumbKey,
  planThumbUpgrade,
  tilePosterKey,
  type ThumbUpgradeInput,
} from "./thumbUpgradePlan";
import type { TilePosterUpgrade } from "@/lib/commands";

function tile(posterName: string, mediaPath: string): TilePosterUpgrade {
  return { posterName, mediaPath, kind: "video" };
}

describe("planThumbUpgrade", () => {
  it("routes an image block to a single image action keyed by slug", () => {
    const input: ThumbUpgradeInput = {
      slug: "sunset",
      mediaPath: "/vault/sunset.webp",
      kind: "image",
    };
    expect(planThumbUpgrade(input)).toEqual([
      { kind: "image", key: blockThumbKey("sunset"), slug: "sunset", mediaPath: "/vault/sunset.webp" },
    ]);
  });

  it("routes a video block to a single video action keyed by slug", () => {
    const input: ThumbUpgradeInput = {
      slug: "clip",
      mediaPath: "/vault/clip.mp4",
      kind: "video",
    };
    expect(planThumbUpgrade(input)).toEqual([
      { kind: "video", key: blockThumbKey("clip"), slug: "clip", mediaPath: "/vault/clip.mp4" },
    ]);
  });

  it("emits only tile actions when the block media path is empty", () => {
    const posters = [tile("a.jpg", "/vault/a.mp4"), tile("b.jpg", "/vault/b.mp4")];
    const input: ThumbUpgradeInput = {
      slug: "gallery",
      mediaPath: "",
      kind: "video",
      tilePosters: posters,
    };
    expect(planThumbUpgrade(input)).toEqual([
      { kind: "tile", key: tilePosterKey("a.jpg"), slug: "gallery", tile: posters[0] },
      { kind: "tile", key: tilePosterKey("b.jpg"), slug: "gallery", tile: posters[1] },
    ]);
  });

  it("emits the block action and every tile action together", () => {
    const posters = [tile("t.jpg", "/vault/t.mp4")];
    const input: ThumbUpgradeInput = {
      slug: "mixed",
      mediaPath: "/vault/mixed.mp4",
      kind: "video",
      tilePosters: posters,
    };
    expect(planThumbUpgrade(input)).toEqual([
      { kind: "video", key: blockThumbKey("mixed"), slug: "mixed", mediaPath: "/vault/mixed.mp4" },
      { kind: "tile", key: tilePosterKey("t.jpg"), slug: "mixed", tile: posters[0] },
    ]);
  });

  it("returns no actions when there is neither media nor tiles", () => {
    const input: ThumbUpgradeInput = { slug: "empty", mediaPath: "", kind: "image" };
    expect(planThumbUpgrade(input)).toEqual([]);
  });

  it("derives distinct namespaced keys for block thumbs and tile posters", () => {
    expect(blockThumbKey("x")).toBe("thumb:x");
    expect(tilePosterKey("x")).toBe("tile:x");
    expect(blockThumbKey("x")).not.toBe(tilePosterKey("x"));
  });
});
