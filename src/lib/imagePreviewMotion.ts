// The image preview's way out of its media frame and back
// (SPEC_MEDIA_ASSET_ACTIONS.md, «Движение просмотра изображения»): where the
// picture stands at a point of the motion and how an opening and a closing go.
// The spring and the shares of time are the card window's (cardPeek.ts); the
// component (ImagePreviewOverlay.tsx) measures once and writes each frame.
//
// One `<img>` flies, laid out at its place in the preview. A uniform scale
// brings it to any size, and `clip-path: inset(… round …)`, its values divided
// by that scale, gives the visible part and the corner: nothing is stretched
// in any frame, and the crop opens with no switch.

import { coverPeekRect, intersectPeekRect, lerp, lerpPeekRect, type PeekRect } from "./cardPeek";

/** The user's zoom and pan: a scale about the picture's centre, then an
 *  offset, px. */
export interface ImagePreviewTransform {
  scale: number;
  x: number;
  y: number;
}

/** Where the picture stands in its source, viewport px: the part the page
 *  shows, the whole picture and the corner. */
export interface ImagePreviewPlace {
  clip: PeekRect;
  image: PeekRect;
  radius: number;
}

/** How the preview opens: out of its source, in place by opacity alone, as a
 *  dialog does, or not at all. */
export type ImagePreviewOpening = "flight" | "fade" | "dialog" | "instant";

/** How the preview closes: into its source, in place by opacity alone, or as
 *  a dialog does. Escape is no motion, so it is no kind. */
export type ImagePreviewClosing = "flight" | "fade" | "dialog";

/** The smallest side a moving box is given, so the clip's values stay finite. */
const MIN_SIDE_PX = 0.01;

/** Six decimals: a scale of a box a thousand pixels wide stays within a
 *  thousandth of a pixel. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** How an opening goes: a key stands it at once, "Reduce motion" fades it in
 *  place, a source gives it its way, and with no source it opens as a dialog. */
export function imagePreviewOpeningKind({
  keyboard,
  reducedMotion,
  hasSource,
}: {
  keyboard: boolean;
  reducedMotion: boolean;
  hasSource: boolean;
}): ImagePreviewOpening {
  if (keyboard) return "instant";
  if (reducedMotion) return "fade";
  return hasSource ? "flight" : "dialog";
}

/** How a closing by the button or the background goes: a preview that stood
 *  at once and "Reduce motion" fade in place (SPEC_CARD_PEEK.md, О10, О13),
 *  a source on screen takes the picture back, and with none it leaves as a
 *  dialog. */
export function imagePreviewClosingKind({
  openedAs,
  reducedMotion,
  sourceOnScreen,
}: {
  openedAs: ImagePreviewOpening;
  reducedMotion: boolean;
  sourceOnScreen: boolean;
}): ImagePreviewClosing {
  if (reducedMotion || openedAs === "instant") return "fade";
  return sourceOnScreen ? "flight" : "dialog";
}

/** The picture `transform` shows when it is laid out as `laid`. */
export function imagePreviewRestRect(laid: PeekRect, transform: ImagePreviewTransform): PeekRect {
  const width = laid.width * transform.scale;
  const height = laid.height * transform.scale;
  return {
    x: laid.x + (laid.width - width) / 2 + transform.x,
    y: laid.y + (laid.height - height) / 2 + transform.y,
    width,
    height,
  };
}

/** The picture's transform at rest: at 100 % none, so it keeps no layer. */
export function imagePreviewRestTransform({ scale, x, y }: ImagePreviewTransform): string {
  if (scale === 1 && x === 0 && y === 0) return "none";
  return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}

/** Where a picture `naturalWidth × naturalHeight` lies when it fits inside
 *  `box` centred, as `object-fit: contain` draws it. */
export function containPeekRect(box: PeekRect, naturalWidth: number, naturalHeight: number): PeekRect {
  if (naturalWidth <= 0 || naturalHeight <= 0 || box.width <= 0 || box.height <= 0) return box;
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** The picture's place in a source that draws it in `box` by `fit` and shows
 *  no more of it than `bounds`; null when none of it shows. The whole picture
 *  keeps the preview's proportion `width × height`, so the way to the preview
 *  scales it alike on both axes. */
export function imagePreviewPlace({
  box,
  bounds,
  fit,
  width,
  height,
  radius,
}: {
  box: PeekRect;
  bounds: PeekRect;
  fit: string;
  width: number;
  height: number;
  radius: number;
}): ImagePreviewPlace | null {
  const image = fit === "contain" || fit === "scale-down"
    ? containPeekRect(box, width, height)
    : coverPeekRect(box, width, height);
  const clip = intersectPeekRect(intersectPeekRect(image, box), bounds);
  if (clip.width <= 0 || clip.height <= 0) return null;
  return { clip, image, radius };
}

/** One frame of the way: the picture `laid` out in the preview, `progress` of
 *  the way from `place` (0) to where `transform` shows it (1). Its first frame
 *  stands on `place` and its last on the preview's place, whatever the zoom. */
export function imagePreviewFrame(
  place: ImagePreviewPlace,
  laid: PeekRect,
  transform: ImagePreviewTransform,
  progress: number,
): { transform: string; clipPath: string } {
  const rest = imagePreviewRestRect(laid, transform);
  const image = lerpPeekRect(place.image, rest, progress);
  const clip = lerpPeekRect(place.clip, rest, progress);
  const scale = Math.max(MIN_SIDE_PX, image.width) / Math.max(MIN_SIDE_PX, laid.width);
  const shownWidth = laid.width * scale;
  const shownHeight = laid.height * scale;
  const centreX = image.x + image.width / 2;
  const centreY = image.y + image.height / 2;
  const left = centreX - shownWidth / 2;
  const top = centreY - shownHeight / 2;
  const inset = (value: number) => round(Math.max(0, value) / scale);
  const corner = inset(lerp(place.radius, 0, progress));
  const shape = [
    inset(clip.y - top),
    inset(left + shownWidth - clip.x - clip.width),
    inset(top + shownHeight - clip.y - clip.height),
    inset(clip.x - left),
  ].map((value) => `${value}px`).join(" ");
  return {
    transform: `translate3d(${round(centreX - laid.x - laid.width / 2)}px, ${round(centreY - laid.y - laid.height / 2)}px, 0) scale(${round(scale)})`,
    clipPath: `inset(${shape} round ${corner}px)`,
  };
}

/** A size of the proportion `width × height` as large as `maxWidth ×
 *  maxHeight` holds: the preview's place for an original whose own size is
 *  not known yet; null when the proportion or the limits are not known. */
export function fitImagePreviewSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } | null {
  if (!(width > 0 && height > 0 && maxWidth > 0 && maxHeight > 0)) return null;
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

// ─── Reading the page, once per motion ──────────────────────────────────

function toPeekRect(rect: DOMRect): PeekRect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function cornerOf(element: Element): number {
  return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
}

/** The `overflow` values that clip what lies past a box's edge. */
const CLIPS = /^(?:hidden|clip|auto|scroll)$/;

/** The part of the viewport `element`'s ancestors let it show: a scroller, a
 *  window, any box that clips. */
function visibleBounds(element: Element): PeekRect {
  let bounds: PeekRect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  for (let box = element.parentElement; box; box = box.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(box);
    if (CLIPS.test(overflowX) || CLIPS.test(overflowY)) {
      bounds = intersectPeekRect(bounds, toPeekRect(box.getBoundingClientRect()));
    }
  }
  return bounds;
}

/** The original's element in a media frame. */
function sourcePicture(source: HTMLElement): HTMLImageElement | null {
  return source.querySelector<HTMLImageElement>("img:not([data-detail-preview-backing])");
}

/** The picture the frame draws now: the small preview while the original
 *  loads under it (Detail.tsx, `DetailPreviewBacking`), else the original. */
export function imagePreviewDrawnPicture(source: HTMLElement): HTMLImageElement | null {
  const backing = source.querySelector<HTMLImageElement>("img[data-detail-preview-backing]");
  return backing && backing.naturalWidth > 0 ? backing : sourcePicture(source);
}

/** The address of what the frame draws now; null when it draws nothing yet. */
export function imagePreviewDrawnAddress(source: HTMLElement): string | null {
  const drawn = imagePreviewDrawnPicture(source);
  return drawn?.currentSrc || drawn?.src || null;
}

/** Where a source stands on screen now, for a picture of the proportion
 *  `width × height`; null when it left the page or none of it shows. */
export function readImagePreviewPlace(source: HTMLElement, width: number, height: number): ImagePreviewPlace | null {
  if (!source.isConnected) return null;
  const drawn = sourcePicture(source) ?? source;
  return imagePreviewPlace({
    box: toPeekRect(drawn.getBoundingClientRect()),
    bounds: visibleBounds(drawn),
    fit: getComputedStyle(drawn).objectFit,
    width,
    height,
    radius: Math.max(cornerOf(drawn), cornerOf(source)),
  });
}

/** The picture's box in the preview with no transform on it. An original
 *  whose own size is not known yet takes, by inline size, the place the
 *  largest picture of its source's proportion would; null when even that is
 *  not known. */
export function measureLaidImage(image: HTMLImageElement, source: HTMLElement | null): PeekRect | null {
  if (image.naturalWidth <= 0) {
    const drawn = source ? imagePreviewDrawnPicture(source) : null;
    const limits = getComputedStyle(image);
    const size = fitImagePreviewSize(
      drawn?.naturalWidth ?? 0,
      drawn?.naturalHeight ?? 0,
      Number.parseFloat(limits.maxWidth),
      Number.parseFloat(limits.maxHeight),
    );
    if (!size) return null;
    image.style.width = `${size.width}px`;
    image.style.height = `${size.height}px`;
  }
  const { transform } = image.style;
  // No transition sees this: the transform comes back before any style is
  // flushed but the one this read forces, and the motion writes its own.
  image.style.transition = "none";
  image.style.transform = "none";
  const laid = toPeekRect(image.getBoundingClientRect());
  image.style.transform = transform;
  return laid.width > 0 && laid.height > 0 ? laid : null;
}
