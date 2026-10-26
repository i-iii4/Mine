import { afterEach, describe, expect, it } from "vitest";
import { detailPeekMediaFrames, readFeedPeekSource } from "./cardPeekSource";
import type { PeekRect } from "./cardPeek";

function place(element: Element, rect: PeekRect) {
  element.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height);
}

function picture(rect: PeekRect, loaded = true): HTMLImageElement {
  const image = document.createElement("img");
  Object.defineProperty(image, "complete", { value: loaded });
  Object.defineProperty(image, "naturalWidth", { value: loaded ? 600 : 0 });
  Object.defineProperty(image, "naturalHeight", { value: loaded ? 400 : 0 });
  place(image, rect);
  return image;
}

const SLOT: PeekRect = { x: 100, y: 50, width: 201, height: 201 };

/** A feed card with a four-tile gallery (Card.tsx, `GalleryTiles`): tiles
 *  100 px square, 1 px seams, in the order of `sources`. */
function galleryCard(sources: readonly string[], options: { lift?: PeekRect; unloaded?: string } = {}) {
  const frame = document.createElement("div");
  frame.setAttribute("data-feed-card-frame", "");
  place(frame, { x: 99, y: 49, width: 203, height: 260 });
  const slot = document.createElement("div");
  slot.setAttribute("data-card-media-clip", "");
  place(slot, SLOT);
  const lift = document.createElement("div");
  lift.setAttribute("data-card-lift", "window");
  place(lift, options.lift ?? SLOT);
  const grid = document.createElement("div");
  grid.style.backgroundColor = "rgb(10, 20, 30)";
  place(grid, SLOT);
  const tiles = sources.map((source, index) => {
    const tile = document.createElement("div");
    tile.setAttribute("data-card-media-tile", "");
    tile.dataset.cardMediaSource = source;
    const box = { x: SLOT.x + (index % 2) * 101, y: SLOT.y + Math.floor(index / 2) * 101, width: 100, height: 100 };
    place(tile, box);
    tile.append(picture(box, source !== options.unloaded));
    grid.append(tile);
    return tile;
  });
  lift.append(grid);
  slot.append(lift);
  frame.append(slot);
  document.body.append(frame);
  return { frame, tiles };
}

afterEach(() => {
  document.body.replaceChildren();
});

const SOURCES = ["Media/a.jpg", "Media/b.jpg", "Media/c.jpg", "Media/d.jpg"];

describe("a gallery card as the window's source (SPEC_CARD_PEEK.md, О10, п. 3)", () => {
  it("gives every tile on its own, by its file, cropped as the tile crops it, and no single picture", () => {
    const { frame, tiles } = galleryCard(SOURCES);
    const source = readFeedPeekSource(frame);
    expect(source.media).toBeNull();
    const gallery = source.gallery!;
    expect(gallery.clip).toEqual(SLOT);
    expect(gallery.seams).toBe("rgb(10, 20, 30)");
    expect(gallery.tiles.map((tile) => tile.source)).toEqual(SOURCES);
    const last = gallery.tiles[3]!;
    expect(last.clip).toEqual({ x: 201, y: 151, width: 100, height: 100 });
    // A 3:2 picture covering a square tile: as tall as it, wider by half.
    expect(last.image).toEqual({ x: 176, y: 151, width: 150, height: 100 });
    expect([last.naturalWidth, last.naturalHeight]).toEqual([600, 400]);
    // A copy of the tile's own picture to carry, shown at once.
    expect(last.picture).not.toBe(tiles[3]!.querySelector("img"));
    expect([last.picture.loading, last.picture.decoding]).toEqual(["eager", "sync"]);
  });

  it("gives each tile its halves of the seams it borders, none on the gallery's outer sides", () => {
    const { frame } = galleryCard(SOURCES);
    const tiles = readFeedPeekSource(frame).gallery!.tiles;
    expect(tiles.map((tile) => tile.edges)).toEqual([
      [{ side: "right", width: 0.5, across: [1] }, { side: "bottom", width: 0.5, across: [2] }],
      [{ side: "left", width: 0.5, across: [0] }, { side: "bottom", width: 0.5, across: [3] }],
      [{ side: "right", width: 0.5, across: [3] }, { side: "top", width: 0.5, across: [0] }],
      [{ side: "left", width: 0.5, across: [2] }, { side: "top", width: 0.5, across: [1] }],
    ]);
  });

  it("leaves out a tile whose picture is not drawn yet", () => {
    const { frame } = galleryCard(SOURCES, { unloaded: "Media/b.jpg" });
    expect(readFeedPeekSource(frame).gallery?.tiles.map((tile) => tile.source)).toEqual(["Media/a.jpg", "Media/c.jpg", "Media/d.jpg"]);
  });

  it("keeps to the part a lifted card shows (С8), and leaves out a tile it hides whole", () => {
    const lift = { x: SLOT.x, y: SLOT.y, width: SLOT.width, height: 140 };
    const shown = readFeedPeekSource(galleryCard(SOURCES, { lift }).frame).gallery!;
    expect(shown.clip).toEqual(lift);
    expect(shown.tiles[2]?.clip).toEqual({ x: 100, y: 151, width: 100, height: 39 });
    // The lift hides the bottom row's lower part: no seam there; the seam
    // over it shows.
    expect(shown.tiles[2]?.edges).toEqual([{ side: "right", width: 0.5, across: [3] }, { side: "top", width: 0.5, across: [0] }]);
    const hidden = readFeedPeekSource(galleryCard(SOURCES, { lift: { ...lift, height: 90 } }).frame).gallery!;
    expect(hidden.tiles.map((tile) => tile.source)).toEqual(["Media/a.jpg", "Media/b.jpg"]);
  });
});

describe("the card's line under its media", () => {
  it("is the row its bottom edge stands on, and its colour, as the card has them", () => {
    const { frame } = galleryCard(SOURCES);
    const ring = document.createElement("span");
    ring.setAttribute("data-card-media-outline", "under-text");
    ring.style.border = "1px solid rgb(1, 2, 3)";
    place(ring, { x: 99, y: 250, width: 203, height: 2 });
    frame.append(ring);
    expect(readFeedPeekSource(frame).underline).toEqual({ y: 251, height: 1, colour: "rgb(1, 2, 3)" });
  });

  it("is none for a card with no picture to carry", () => {
    const frame = document.createElement("div");
    frame.innerHTML = `<span data-card-media-outline="under-text" style="border: 1px solid red"></span>`;
    document.body.append(frame);
    expect(readFeedPeekSource(frame).underline).toBeUndefined();
  });
});

describe("the open card's media frames", () => {
  it("are read in the article's order with the file each shows", () => {
    const content = document.createElement("div");
    content.innerHTML = `<div data-detail-article-column><div data-detail-image data-detail-media-source="Media/c.jpg"></div><p></p><div data-detail-video data-detail-media-source="Media/v.mp4"></div><div data-detail-image></div></div>`;
    expect(detailPeekMediaFrames(content).map((entry) => entry.source)).toEqual(["Media/c.jpg", "Media/v.mp4", null]);
  });
});
