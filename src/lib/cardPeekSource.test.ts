import { afterEach, describe, expect, it } from "vitest";
import { detailPeekMediaSource, readFeedPeekSource } from "./cardPeekSource";
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
  it("gives the tile of the window's own file, cropped as the tile crops it, and the gallery round it", () => {
    const { frame, tiles } = galleryCard(SOURCES);
    const media = readFeedPeekSource(frame, "Media/d.jpg").media!;
    expect(media.composite).toBe(false);
    expect(media.drawable).toBe(tiles[3]!.querySelector("img"));
    expect(media.clip).toEqual({ x: 201, y: 151, width: 100, height: 100 });
    // A 3:2 picture covering a square tile: as tall as it, wider by half.
    expect(media.image).toEqual({ x: 176, y: 151, width: 150, height: 100 });
    expect(media.rest?.rect).toEqual(SLOT);
  });

  it("copies the gallery round the tile as the feed shows it, the tile's place cut out", () => {
    const { frame, tiles } = galleryCard(SOURCES);
    const copy = readFeedPeekSource(frame, "Media/d.jpg").media!.rest!.element;
    expect(copy.style.backgroundColor).toBe("rgb(10, 20, 30)");
    expect([copy.style.left, copy.style.top, copy.style.width, copy.style.height]).toEqual(["0px", "0px", "201px", "201px"]);
    expect(copy.style.clipPath).toContain("M101 101H201V201H101Z");
    const copies = [...copy.children] as HTMLElement[];
    expect(copies.map((element) => element.style.visibility)).toEqual(["", "", "", "hidden"]);
    // No tile of the feed's: the feed's own tiles alone answer for the card.
    expect(copy.querySelector("[data-card-media-tile], [data-card-media-source]")).toBeNull();
    const pictures = [...copy.querySelectorAll("img")];
    expect(pictures.map((picture) => [picture.loading, picture.decoding])).toEqual(Array(4).fill(["eager", "sync"]));
    expect(tiles[0]!.querySelector("img")?.loading).not.toBe("eager");
  });

  it("finds the tile by its file, never by its place in the gallery", () => {
    const { frame } = galleryCard(["Media/b.jpg", "Media/c.jpg", "Media/a.jpg", "Media/d.jpg"]);
    expect(readFeedPeekSource(frame, "Media/a.jpg").media?.clip).toEqual({ x: 100, y: 151, width: 100, height: 100 });
  });

  it("gives the whole gallery as one picture when no tile shows the window's file", () => {
    const { frame } = galleryCard(SOURCES);
    for (const source of ["Media/e.jpg", null]) {
      const media = readFeedPeekSource(frame, source).media!;
      expect(media.composite).toBe(true);
      expect(media.clip).toEqual(SLOT);
      expect(media.image).toEqual(SLOT);
      expect(media.rest).toBeUndefined();
      // No canvas: a copy of every tile, none cut out.
      expect(media.drawable).toBeNull();
      const copy = media.copy!;
      expect([copy.style.left, copy.style.top, copy.style.width, copy.style.height]).toEqual(["0px", "0px", "201px", "201px"]);
      expect(copy.style.clipPath).toBe("");
      expect([...copy.children].map((element) => (element as HTMLElement).style.visibility)).toEqual(["", "", "", ""]);
      expect(copy.querySelectorAll("img")).toHaveLength(4);
      expect(copy.querySelector("[data-card-media-tile], [data-card-media-source]")).toBeNull();
    }
  });

  it("gives the whole gallery when the tile's picture is not drawn yet", () => {
    const { frame } = galleryCard(SOURCES, { unloaded: "Media/b.jpg" });
    expect(readFeedPeekSource(frame, "Media/b.jpg").media?.composite).toBe(true);
  });

  it("keeps to the part a lifted card shows (С8), the whole gallery when the tile is out of it", () => {
    const lift = { x: SLOT.x, y: SLOT.y, width: SLOT.width, height: 140 };
    const { frame } = galleryCard(SOURCES, { lift });
    const media = readFeedPeekSource(frame, "Media/c.jpg").media!;
    expect(media.clip).toEqual({ x: 100, y: 151, width: 100, height: 39 });
    expect(media.rest?.rect).toEqual(lift);
    const hidden = galleryCard(SOURCES, { lift: { ...lift, height: 90 } });
    expect(readFeedPeekSource(hidden.frame, "Media/c.jpg").media?.composite).toBe(true);
  });
});

describe("the card's line under its media", () => {
  it("is copied with the card's own values and box, to land on the card with it", () => {
    const { frame } = galleryCard(SOURCES);
    const ring = document.createElement("span");
    ring.setAttribute("data-card-media-outline", "under-text");
    ring.style.border = "1px solid rgb(1, 2, 3)";
    ring.style.borderRadius = "8px";
    ring.style.clipPath = "inset(8px 0px 0px)";
    place(ring, { x: 99, y: 235, width: 203, height: 16 });
    frame.append(ring);
    const outline = readFeedPeekSource(frame, "Media/b.jpg").outline!;
    expect(outline.rect).toEqual({ x: 99, y: 235, width: 203, height: 16 });
    expect(outline.element.hasAttribute("data-card-media-outline")).toBe(false);
    expect(outline.element.style.borderTop).toBe("1px solid rgb(1, 2, 3)");
    expect(outline.element.style.clipPath).toBe("inset(8px 0px 0px)");
  });

  it("is none for a card with no picture to carry", () => {
    const frame = document.createElement("div");
    frame.innerHTML = `<span data-card-media-outline="under-text"></span>`;
    document.body.append(frame);
    expect(readFeedPeekSource(frame).outline).toBeUndefined();
  });
});

describe("the open card's own picture file", () => {
  it("is read from its media frame in the article column", () => {
    const content = document.createElement("div");
    content.innerHTML = `<div data-detail-article-column><div data-detail-image data-detail-media-source="Media/c.jpg"></div></div>`;
    expect(detailPeekMediaSource(content)).toBe("Media/c.jpg");
    content.innerHTML = `<div data-detail-article-column><div data-detail-image></div></div>`;
    expect(detailPeekMediaSource(content)).toBeNull();
  });
});
