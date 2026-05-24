/** Pixel granularity for masonry column-width bucketing. */
export const BUCKET_PX = 40;

export function bucketize(columnWidth: number): number {
  return Math.max(0, Math.round(columnWidth / BUCKET_PX));
}
