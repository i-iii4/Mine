// Helper to parse the `media_dimensions` JSON blob stored per block.
//
// The Rust indexer (see storage/media_dimensions.rs) produces strings like:
//   {"photo.jpg":[1920,1080],"diagram.png":[800,600]}
//
// Card templates use `getMediaAspectRatio(block, filename, fallback)` to get
// a deterministic aspect-ratio value for a wrapper div. When dimensions are
// known, the wrapper sizes itself to the exact image ratio — `object-contain`
// then renders the image at its natural shape without cropping. When unknown
// (block not yet re-indexed, remote URL, corrupt file), the caller passes a
// sensible fallback ratio.

import type { LightBlock, IndexedBlock } from "@/types";

type BlockWithDimensions = Pick<LightBlock | IndexedBlock, "media_dimensions">;

interface ParsedDimensions {
  [filename: string]: [number, number];
}

/**
 * Parse a block's media_dimensions string once and return a map.
 * Returns null if the string is null/empty/malformed.
 *
 * Callers should memoize per block — parseMediaDimensions is cheap but
 * recomputing on every render is wasteful for large grids.
 */
export function parseMediaDimensions(
  block: BlockWithDimensions,
): ParsedDimensions | null {
  if (!block.media_dimensions) return null;
  try {
    const parsed = JSON.parse(block.media_dimensions) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    // Shallow validation: each value must be a [number, number] array
    const result: ParsedDimensions = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (
        Array.isArray(val) &&
        val.length === 2 &&
        typeof val[0] === "number" &&
        typeof val[1] === "number" &&
        val[0] > 0 &&
        val[1] > 0
      ) {
        result[key] = [val[0], val[1]];
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Get the CSS aspect-ratio string for a specific media filename in a block.
 *
 * @param block      Block containing media_dimensions
 * @param filename   Filename to look up (matches keys stored by the indexer)
 * @param fallback   CSS aspect-ratio string used when the filename is not
 *                   found in media_dimensions (e.g. "16 / 9", "1 / 1")
 */
export function getMediaAspectRatio(
  block: BlockWithDimensions,
  filename: string | null | undefined,
  fallback: string,
): string {
  if (!filename) return fallback;
  const dims = parseMediaDimensions(block);
  if (!dims) return fallback;
  const entry = dims[filename];
  if (!entry) return fallback;
  return `${entry[0]} / ${entry[1]}`;
}

/**
 * Directly return the pre-parsed dimensions map for a block, or null.
 * Use when a component needs to look up multiple files (e.g. SocialCard
 * with several media items).
 */
export function getMediaDimensionsMap(
  block: BlockWithDimensions,
): ParsedDimensions | null {
  return parseMediaDimensions(block);
}
