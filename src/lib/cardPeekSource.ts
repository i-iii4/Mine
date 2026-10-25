// TRIAL (SPEC_CARD_PEEK.md, О10, О11, О14): where a card and its picture
// stand on screen, read from the page for the open card's window (CardPeek.tsx).
// The feed's cards are read from their frames (Card.tsx); the graph's from
// the graph itself (cardPeek.ts, `registerPeekGraphSource`). The open card's
// own picture is read from the window's content (Detail.tsx, Р6).

import {
  coverPeekRect,
  intersectPeekRect,
  peekRectsOverlap,
  readPeekGraphSource,
  recordPeekInput,
  type PeekRect,
  type PeekSource,
  type PeekSourceMedia,
} from "./cardPeek";

/** The feed's cards stand in its scroll (Grid.tsx). */
const FEED_ROOT_SELECTOR = "[data-grid-scroll]";

/** A card's frame in the feed, by its slug (Card.tsx, `CardFrame`). */
export function feedCardSelector(slug: string): string {
  // Inside a quoted attribute value only the quote and the backslash need
  // escaping.
  return `${FEED_ROOT_SELECTOR} [data-feed-card-frame][data-block-slug="${slug.replace(/["\\]/g, "\\$&")}"]`;
}

export function rectOf(element: Element): PeekRect {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/** The pixel size an image or a video draws at, when it has one to draw. */
function drawnSize(element: Element): { width: number; height: number } | null {
  if (element instanceof HTMLImageElement) {
    return element.complete && element.naturalWidth > 0
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : null;
  }
  if (element instanceof HTMLVideoElement) {
    return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && element.videoWidth > 0
      ? { width: element.videoWidth, height: element.videoHeight }
      : null;
  }
  return null;
}

/** Whether a picture of the card is drawn on screen now: laid out, shown,
 *  loaded. */
function painted(element: HTMLImageElement | HTMLVideoElement): boolean {
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
  return drawnSize(element) !== null;
}

/** Several pictures of a card that is no gallery drawn into one canvas as
 *  the feed shows them inside `clip`, each covering its own box. */
function compositeOf(pictures: readonly (HTMLImageElement | HTMLVideoElement)[], clip: PeekRect): HTMLCanvasElement | null {
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(clip.width * ratio));
  canvas.height = Math.max(1, Math.round(clip.height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(ratio, ratio);
  for (const picture of pictures) {
    const size = drawnSize(picture);
    if (!size) continue;
    const box = rectOf(picture);
    const cover = coverPeekRect(box, size.width, size.height);
    context.save();
    context.beginPath();
    context.rect(box.x - clip.x, box.y - clip.y, box.width, box.height);
    context.clip();
    context.drawImage(picture, cover.x - clip.x, cover.y - clip.y, cover.width, cover.height);
    context.restore();
  }
  return canvas;
}

/** The gallery tile of the media file `source` (Card.tsx, `GalleryTiles`),
 *  by the file's own name, never by its order. */
function galleryTileOf(slot: HTMLElement, source: string): HTMLElement | null {
  for (const tile of slot.querySelectorAll<HTMLElement>("[data-card-media-tile]")) {
    if (tile.dataset.cardMediaSource === source) return tile;
  }
  return null;
}

/** What a gallery `grid` shows: the seams in the frame's colour and the
 *  tiles with their pictures and marks, a copy of the feed's own (Card.tsx,
 *  `GalleryTiles`) laid out from `clip`'s origin; the place of the tile
 *  `cut`, when given, is left clear. The copy is elements, not a picture
 *  drawn once: its pictures are the feed's own files, painted as the feed
 *  paints them, with no canvas. */
function galleryCopyOf(grid: HTMLElement, clip: PeekRect, cut: HTMLElement | null, radius: string): HTMLElement {
  const gridBox = rectOf(grid);
  const copy = grid.cloneNode(true) as HTMLElement;
  Object.assign(copy.style, {
    left: `${gridBox.x - clip.x}px`,
    top: `${gridBox.y - clip.y}px`,
    width: `${gridBox.width}px`,
    height: `${gridBox.height}px`,
    // The seams take the frame's colour from the card (`--card-frame-color`),
    // which the copy stands outside of.
    backgroundColor: getComputedStyle(grid).backgroundColor,
    // The slot's corner, which clips the tiles in the card.
    borderRadius: radius,
    overflow: "hidden",
  });
  if (cut) {
    const tileBox = rectOf(cut);
    const x = tileBox.x - gridBox.x;
    const y = tileBox.y - gridBox.y;
    // The tile's place, seams' colour included, cut out of the copy.
    copy.style.clipPath = `path(evenodd, "M0 0H${gridBox.width}V${gridBox.height}H0Z M${x} ${y}H${x + tileBox.width}V${y + tileBox.height}H${x}Z")`;
  }
  const tiles = [...grid.querySelectorAll<HTMLElement>(":scope > [data-card-media-tile]")];
  const copies = [...copy.querySelectorAll<HTMLElement>(":scope > [data-card-media-tile]")];
  copies.forEach((element, index) => {
    if (tiles[index] === cut) element.style.visibility = "hidden";
    // A copy is no tile of the feed's.
    element.removeAttribute("data-card-media-tile");
    element.removeAttribute("data-card-media-source");
  });
  for (const picture of copy.querySelectorAll("img")) {
    // Shown in the frame it is put on the page in, not when the feed's
    // scroll would reach it.
    picture.loading = "eager";
    picture.decoding = "sync";
  }
  return copy;
}

/** A gallery's tile of the window's own picture: the picture alone, in the
 *  part of the tile the card shows, and the gallery round it (`rest`). */
function galleryTileMedia(tile: HTMLElement, clip: PeekRect, radius: string): PeekSourceMedia | null {
  const picture = [...tile.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")].find(painted);
  if (!picture) return null;
  const tileClip = intersectPeekRect(clip, rectOf(tile));
  if (tileClip.width <= 0 || tileClip.height <= 0) return null;
  // `painted` kept only pictures that have a size.
  const size = drawnSize(picture)!;
  const grid = tile.parentElement;
  const rest = grid ? galleryCopyOf(grid, clip, tile, radius) : null;
  // What flies when the window has no picture of its own to carry: the
  // tile's own file, not a canvas.
  const copy = picture instanceof HTMLImageElement ? picture.cloneNode() as HTMLImageElement : null;
  if (copy) {
    copy.loading = "eager";
    copy.decoding = "sync";
  }
  return {
    drawable: picture,
    ...(copy ? { copy } : {}),
    naturalWidth: size.width,
    naturalHeight: size.height,
    clip: tileClip,
    image: coverPeekRect(rectOf(picture), size.width, size.height),
    composite: false,
    ...(rest ? { rest: { element: rest, rect: clip } } : {}),
  };
}

/** A feed card's picture: the part of its media slot the card shows now (a
 *  lifted card shows less of it, SPEC_CARD_STATES.md, С8) and the whole
 *  picture as the slot crops it (`object-cover`). A gallery with a tile of
 *  `windowSource`, the window's own picture, gives that tile (О10, п. 3);
 *  any other gallery, all its pictures as one. */
function feedCardMedia(frame: HTMLElement, windowSource: string | null): PeekSourceMedia | null {
  const slot = frame.querySelector<HTMLElement>("[data-card-media-clip]");
  if (!slot) return null;
  const slotRect = rectOf(slot);
  const window = slot.querySelector("[data-card-lift='window']");
  const clip = window ? intersectPeekRect(slotRect, rectOf(window)) : slotRect;
  if (clip.width <= 0 || clip.height <= 0) return null;
  const radius = getComputedStyle(slot).borderTopLeftRadius;
  const tile = windowSource ? galleryTileOf(slot, windowSource) : null;
  const tileMedia = tile ? galleryTileMedia(tile, clip, radius) : null;
  if (tileMedia) return tileMedia;
  // Any other gallery flies whole, as a copy of its tiles.
  const grid = slot.querySelector("[data-card-media-tile]")?.parentElement ?? null;
  if (grid) {
    return {
      drawable: null,
      copy: galleryCopyOf(grid, clip, null, radius),
      naturalWidth: clip.width,
      naturalHeight: clip.height,
      clip,
      image: clip,
      composite: true,
    };
  }
  const pictures = [...slot.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")].filter(painted);
  if (pictures.length === 0) return null;
  if (pictures.length === 1) {
    const picture = pictures[0]!;
    // `painted` kept only pictures that have a size.
    const size = drawnSize(picture)!;
    return {
      drawable: picture,
      naturalWidth: size.width,
      naturalHeight: size.height,
      clip,
      image: coverPeekRect(rectOf(picture), size.width, size.height),
      composite: false,
    };
  }
  const canvas = compositeOf(pictures, clip);
  if (!canvas) return null;
  return {
    drawable: canvas,
    naturalWidth: canvas.width,
    naturalHeight: canvas.height,
    clip,
    image: clip,
    composite: true,
  };
}

/** The line a feed card draws under its media, the frame's line mirrored
 *  there (global.css, `[data-card-media-outline]`), copied with the card's
 *  own values: the copy stands outside the card, whose variables it reads. */
function feedCardOutline(frame: HTMLElement): { element: HTMLElement; rect: PeekRect } | null {
  const ring = frame.querySelector<HTMLElement>("[data-card-media-outline]");
  if (!ring) return null;
  const rect = rectOf(ring);
  if (rect.width <= 0 || rect.height <= 0) return null;
  const style = getComputedStyle(ring);
  const line = document.createElement("span");
  Object.assign(line.style, {
    position: "absolute",
    inset: "0",
    boxSizing: "border-box",
    border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    borderRadius: `${style.borderTopLeftRadius} ${style.borderTopRightRadius} ${style.borderBottomRightRadius} ${style.borderBottomLeftRadius}`,
    clipPath: style.clipPath,
    pointerEvents: "none",
  });
  return { element: line, rect };
}

/** A feed card as the window grows out of it: its frame, its corner, the
 *  card's fill and its picture (`windowSource`: the window's own picture's
 *  file, `detailPeekMediaSource`). */
export function readFeedPeekSource(frame: HTMLElement, windowSource: string | null = null): PeekSource {
  const radius = Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius);
  const media = feedCardMedia(frame, windowSource);
  const outline = media ? feedCardOutline(frame) : null;
  return {
    rect: rectOf(frame),
    radius: Number.isFinite(radius) ? radius : 0,
    fill: "var(--card)",
    media,
    ...(outline ? { outline } : {}),
  };
}

/** Where the card `slug` stands, if any of it is on screen in the right
 *  part `area` (which lies over the feed, not round it): in the feed, else
 *  on the graph. `windowSource` is the window's own picture's file. */
export function findPeekSource(area: HTMLElement, slug: string, windowSource: string | null = null): PeekSource | null {
  const areaRect = rectOf(area);
  const frame = area.ownerDocument.querySelector<HTMLElement>(feedCardSelector(slug));
  if (frame) {
    const source = readFeedPeekSource(frame, windowSource);
    if (peekRectsOverlap(source.rect, areaRect)) return source;
  }
  const graph = readPeekGraphSource(slug);
  return graph && peekRectsOverlap(graph.rect, areaRect) ? graph : null;
}

/** The open card's picture in the window's content: its one media frame
 *  (Р6), the first in the article column. */
export function detailPeekMediaFrame(content: HTMLElement): HTMLElement | null {
  return content.querySelector<HTMLElement>(
    "[data-detail-article-column] :is([data-detail-image], [data-detail-video])",
  );
}

/** The media file the open card's media frame shows, as the card's
 *  preview names it (Detail.tsx, `data-detail-media-source`). */
export function detailPeekMediaSource(content: HTMLElement): string | null {
  return detailPeekMediaFrame(content)?.dataset.detailMediaSource ?? null;
}

/** What draws the picture of an open card's media frame now: the original,
 *  else the preview under it, else the video. */
export function detailPeekDrawable(
  frame: HTMLElement,
): { drawable: CanvasImageSource; width: number; height: number } | null {
  for (const element of frame.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")) {
    const size = drawnSize(element);
    if (size && getComputedStyle(element).opacity !== "0") return { drawable: element, ...size };
  }
  return null;
}

/** Hears every press and key of the page, before anything takes it, and
 *  remembers the last one for the next opening (О10): a press on a feed card
 *  or on the graph grows the window out of that card, a key with the focus
 *  in the right part (`rightPart`) or nowhere fades it in place. Returns
 *  the function that stops. */
export function listenPeekInput(rightPart: () => HTMLElement | null): () => void {
  const elementOf = (target: EventTarget | null) => (target instanceof Element ? target : null);
  const handlePointer = (event: PointerEvent) => {
    const target = elementOf(event.target);
    recordPeekInput({
      kind: "pointer",
      at: performance.now(),
      feedCardSlug: target
        ?.closest(`${FEED_ROOT_SELECTOR} [data-feed-card-frame][data-block-slug]`)
        ?.getAttribute("data-block-slug") ?? null,
      onGraph: target?.closest("[data-graph-view]") != null,
      inRightPart: false,
    });
  };
  const handleKey = (event: KeyboardEvent) => {
    const target = elementOf(event.target);
    recordPeekInput({
      kind: "key",
      at: performance.now(),
      feedCardSlug: null,
      onGraph: false,
      inRightPart: target === null || target === document.body || (rightPart()?.contains(target) ?? false),
    });
  };
  window.addEventListener("pointerdown", handlePointer, true);
  window.addEventListener("keydown", handleKey, true);
  return () => {
    window.removeEventListener("pointerdown", handlePointer, true);
    window.removeEventListener("keydown", handleKey, true);
  };
}
