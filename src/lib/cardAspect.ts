// Cropping policy for feed media cards — the single place that decides whether
// a graphic is shown whole or cropped.
//
// A card's shape follows the artifact the feed paints. Ordinary photographs,
// portrait and landscape alike, are shown whole: cropping them buys nothing and
// loses the picture. Only genuinely extreme frames — panoramas and scroll-like
// screenshots — are clamped, because letting them through would hand one card
// the whole viewport or squash it into a strip.
//
// Contract: SPEC_CARD_MEDIA_GEOMETRY.md.

/// The envelope a media slot takes while its artifact's geometry is unknown.
///
/// Deterministic, and marked in the markup as provisional so it reads as a
/// state rather than a measurement. Deliberately not square: a square is a
/// plausible-looking proportion, so using it here would pass off ignorance as
/// a fact — exactly what `SPEC_CARD_MEDIA_GEOMETRY.md` forbids. A slot this
/// shape is visibly a placeholder, and one `thumb:updated` replaces it.
///
/// Width over height, like every other ratio here: `16 / 9` is the landscape
/// slot, `9 / 16` would be its portrait mirror. Both the height reserved by
/// the layout and the ratio painted on the surface read this one constant,
/// because the whole point of a provisional envelope is that the two agree —
/// they did not, and disagreed by a factor of three.
export const PROVISIONAL_MEDIA_ASPECT = 16 / 9;

/// Tallest shape a card may take: height at most twice its width.
export const MIN_CARD_ASPECT = 1 / 2;
/// Widest shape a card may take: width at most twice its height.
export const MAX_CARD_ASPECT = 2 / 1;

/// Clamp an artifact's aspect ratio into the range a card may render.
///
/// Returns the ratio unchanged when it is already inside the range, which is
/// the case where the image is shown whole.
export function clampCardAspect(aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return 1;
  return Math.min(MAX_CARD_ASPECT, Math.max(MIN_CARD_ASPECT, aspectRatio));
}

/// Whether rendering at `clampCardAspect(aspectRatio)` crops the graphic.
///
/// Cropping is a consequence of the clamp and of nothing else: inside the range
/// the artifact fills its slot exactly.
export function cardAspectCrops(aspectRatio: number): boolean {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return false;
  return aspectRatio < MIN_CARD_ASPECT || aspectRatio > MAX_CARD_ASPECT;
}
