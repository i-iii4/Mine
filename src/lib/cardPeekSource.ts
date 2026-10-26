// TRIAL (SPEC_CARD_PEEK.md, О10, О11, О14): where a card and its picture
// stand on screen, read from the page for the open card's window (CardPeek.tsx).
// The feed's cards are read from their frames (Card.tsx); the graph's from
// the graph itself (cardPeek.ts, `registerPeekGraphSource`). The open card's
// own picture is read from the window's content (Detail.tsx, Р6).

import {
  coverPeekRect,
  intersectPeekRect,
  peekTileEdges,
  peekRectsOverlap,
  readPeekGraphSource,
  recordPeekInput,
  type PeekRect,
  type PeekSource,
  type PeekSourceGallery,
  type PeekSourceMedia,
  type PeekSourceTile,
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

/** The clip of a card's media slot: the part the card shows now (a lifted
 *  card shows less of it, SPEC_CARD_STATES.md, С8). */
function slotClipOf(slot: HTMLElement): PeekRect {
  const slotRect = rectOf(slot);
  const lift = slot.querySelector("[data-card-lift='window']");
  return lift ? intersectPeekRect(slotRect, rectOf(lift)) : slotRect;
}

/** A gallery card's media (Card.tsx, `GalleryTiles`): its slot's shown part,
 *  corner and seams, and every tile the card shows any part of, with its
 *  picture drawn, as the tile crops it (О10, п. 3). A tile the lifted card
 *  hides whole is none of them: it shows with the window's content. Null
 *  for a card that is no gallery. */
function feedCardGallery(slot: HTMLElement): PeekSourceGallery | null {
  const tiles = [...slot.querySelectorAll<HTMLElement>("[data-card-media-tile]")];
  const grid = tiles[0]?.parentElement;
  if (!grid) return null;
  const clip = slotClipOf(slot);
  // The seams between the tiles, from the whole tiles, the lifted card's
  // hidden part included: a seam it hides lies outside its shown part.
  const edges = peekTileEdges(tiles.map(rectOf));
  const shown: PeekSourceTile[] = [];
  // Each tile's index among the shown ones, for the tiles across a seam.
  const shownIndex = new Map<number, number>();
  for (const [index, tile] of tiles.entries()) {
    const source = tile.dataset.cardMediaSource;
    const tileClip = intersectPeekRect(clip, rectOf(tile));
    const picture = tile.querySelector("img");
    if (!source || tileClip.width <= 0 || tileClip.height <= 0 || !picture || !painted(picture)) continue;
    // `painted` kept only pictures that have a size.
    const size = drawnSize(picture)!;
    // The card's own file to carry, shown in the frame it is put on the
    // page in, not when a scroll would reach it.
    const copy = picture.cloneNode() as HTMLImageElement;
    copy.loading = "eager";
    copy.decoding = "sync";
    // A seam the lift hides is no edge of the shown part.
    const shownEdges = (edges[index] ?? []).filter(({ side }) => (
      side === "left" ? tileClip.x > clip.x
        : side === "right" ? tileClip.x + tileClip.width < clip.x + clip.width
          : side === "top" ? tileClip.y > clip.y
            : tileClip.y + tileClip.height < clip.y + clip.height
    ));
    shownIndex.set(index, shown.length);
    shown.push({
      source,
      edges: shownEdges,
      clip: tileClip,
      image: coverPeekRect(rectOf(picture), size.width, size.height),
      picture: copy,
      naturalWidth: size.width,
      naturalHeight: size.height,
    });
  }
  for (const tile of shown) {
    tile.edges = tile.edges.map((edge) => ({
      ...edge,
      across: edge.across.map((index) => shownIndex.get(index) ?? -1).filter((index) => index >= 0),
    }));
  }
  return {
    clip,
    seams: getComputedStyle(grid).backgroundColor,
    tiles: shown,
  };
}

/** A feed card's picture that is no gallery: the part of its media slot the
 *  card shows now and the whole picture as the slot crops it
 *  (`object-cover`). */
function feedCardMedia(slot: HTMLElement): PeekSourceMedia | null {
  const clip = slotClipOf(slot);
  if (clip.width <= 0 || clip.height <= 0) return null;
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
 *  there (global.css, `[data-card-media-outline]`): the row its bottom edge,
 *  all of it the card shows, stands on, and its colour, as the card has
 *  them. */
function feedCardUnderline(frame: HTMLElement): { y: number; height: number; colour: string } | null {
  const ring = frame.querySelector<HTMLElement>("[data-card-media-outline]");
  if (!ring) return null;
  const rect = rectOf(ring);
  const style = getComputedStyle(ring);
  const height = Number.parseFloat(style.borderBottomWidth);
  if (rect.width <= 0 || !(height > 0)) return null;
  return { y: rect.y + rect.height - height, height, colour: style.borderBottomColor };
}

/** A feed card's text part (Card.tsx, `CardTextStack`), copied to be
 *  carried with the window's frame: the card's title and text come back
 *  with the card as the window lands, not at once after it (О11, п. 2). The
 *  copy is no lift and holds no line under the media: the window draws
 *  that line itself. */
function feedCardText(frame: HTMLElement): { element: HTMLElement; rect: PeekRect } | null {
  const text = frame.querySelector<HTMLElement>("[data-card-lift='text']");
  if (!text) return null;
  const rect = intersectPeekRect(rectOf(text), rectOf(frame));
  if (rect.width <= 0 || rect.height <= 0) return null;
  const copy = text.cloneNode(true) as HTMLElement;
  for (const ring of copy.querySelectorAll("[data-card-media-outline]")) ring.remove();
  for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("[data-card-lift]")]) element.removeAttribute("data-card-lift");
  Object.assign(copy.style, { width: `${rectOf(text).width}px`, transform: "none" });
  copy.setAttribute("aria-hidden", "true");
  return { element: copy, rect: rectOf(text) };
}

/** A feed card as the window grows out of it: its frame, its corner, the
 *  card's fill, its picture or its gallery, and the line under them. */
export function readFeedPeekSource(frame: HTMLElement): PeekSource {
  const radius = Number.parseFloat(getComputedStyle(frame).borderTopLeftRadius);
  const slot = frame.querySelector<HTMLElement>("[data-card-media-clip]");
  const gallery = slot ? feedCardGallery(slot) : null;
  const media = slot && !gallery ? feedCardMedia(slot) : null;
  const underline = media || gallery ? feedCardUnderline(frame) : null;
  const text = feedCardText(frame);
  return {
    rect: rectOf(frame),
    radius: Number.isFinite(radius) ? radius : 0,
    fill: "var(--card)",
    media,
    ...(gallery ? { gallery } : {}),
    ...(underline ? { underline } : {}),
    ...(text ? { text } : {}),
  };
}

/** Where the card `slug` stands, if any of it is on screen in the right
 *  part `area` (which lies over the feed, not round it): in the feed, else
 *  on the graph. */
export function findPeekSource(area: HTMLElement, slug: string): PeekSource | null {
  const areaRect = rectOf(area);
  const frame = area.ownerDocument.querySelector<HTMLElement>(feedCardSelector(slug));
  if (frame) {
    const source = readFeedPeekSource(frame);
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

/** Every media frame of the open card in the article column, in the
 *  article's order, with the file each shows as the card's preview names it
 *  (Detail.tsx, `data-detail-media-source`). */
export function detailPeekMediaFrames(content: HTMLElement): { frame: HTMLElement; source: string | null }[] {
  return [...content.querySelectorAll<HTMLElement>(
    "[data-detail-article-column] :is([data-detail-image], [data-detail-video])",
  )].map((frame) => ({ frame, source: frame.dataset.detailMediaSource ?? null }));
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
