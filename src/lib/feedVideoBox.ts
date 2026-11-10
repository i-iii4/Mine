// The box a feed video is drawn in (SPEC_CARD_MEDIA_GEOMETRY.md, «Коробка
// видео в целых пикселях»).
//
// The slot a video fills is rarely the video's own shape: the layout rounds a
// card's height, and the media's clip is the slot grown by half a pixel on
// every side to lie under the frame's line. With `object-fit: cover` the
// engine then works the video's size out itself, rounds the result to whole
// pixels for the video's layer and lets the video render at its own fractional
// cover size inside that layer: the picture is drawn a fraction of a pixel
// larger than its box and cropped at a fractional offset. This module gives
// the video a box of whole CSS pixels, so whole device pixels at 1x and 2x,
// that already has the video's shape to within one pixel and covers the slot;
// the video is drawn exactly at it (`object-fit: fill`) and the slot's clip
// crops the overflow as before.

/** A box in CSS px. */
export interface FeedVideoSize {
  width: number;
  height: number;
}

/** Where the video is drawn, in whole CSS px from the slot's top left. */
export interface FeedVideoBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// Sizes a layout hands over carry LayoutUnit precision (1/64 px); a value
/// within this of a whole pixel is that pixel, not the next one up.
const WHOLE_PIXEL_TOLERANCE_PX = 1 / 128;

/// The smallest whole number of pixels that covers `size`.
function coveringPixels(size: number): number {
  return Math.ceil(size - WHOLE_PIXEL_TOLERANCE_PX);
}

/// The whole-pixel offset that centres `inner` over `outer` and keeps both of
/// `outer`'s edges covered (`inner >= outer`). `+ 0` turns -0 into 0.
function centredOffset(outer: number, inner: number): number {
  return Math.round((outer - inner) / 2) + 0;
}

/**
 * The video's box over a slot of `slot` CSS px for a video of `natural`
 * pixels, or `null` while either is unknown or empty.
 *
 * The dimension the video's shape limits matches the slot, rounded up to a
 * whole pixel; the other is the video's shape across it, rounded to the
 * nearest pixel and never less than the slot. The box then covers the slot,
 * its edges and size are whole pixels, and its shape differs from the video's
 * by less than one pixel along one side: under 0.5 % at the narrowest feed
 * card, too little to see.
 */
export function feedVideoBox(slot: FeedVideoSize, natural: FeedVideoSize): FeedVideoBox | null {
  const known = [slot.width, slot.height, natural.width, natural.height]
    .every((value) => Number.isFinite(value) && value > 0);
  if (!known) return null;
  const aspect = natural.width / natural.height;
  const coversByWidth = slot.width / slot.height >= aspect;
  const width = coversByWidth
    ? coveringPixels(slot.width)
    : Math.max(coveringPixels(slot.width), Math.round(coveringPixels(slot.height) * aspect));
  const height = coversByWidth
    ? Math.max(coveringPixels(slot.height), Math.round(width / aspect))
    : coveringPixels(slot.height);
  return {
    left: centredOffset(slot.width, width),
    top: centredOffset(slot.height, height),
    width,
    height,
  };
}
