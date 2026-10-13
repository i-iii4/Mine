// Twitter/X "/status/<id>/photo/<n>" opens one image in a lightbox over the
// tweet. The page still classifies as a thread (content.js detectType →
// article), so without an explicit override the clipper would extract the whole
// tweet instead of the single image on screen. These helpers resolve the exact
// photo from the URL, preferring the syndication API (full-res, indexed, no
// dependency on lazy-loaded DOM).

import { requestXSyndication } from "./messaging";

export interface ResolvedLightboxImage {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export interface TwitterPhotoTarget {
  tweetId: string;
  /** Zero-based index into the tweet's photos (/photo/1 → 0). */
  photoIndex: number;
}

interface SyndicationPhoto {
  type: string;
  media_url_https?: string;
  ext_alt_text?: string;
  original_info?: { width?: number; height?: number };
}

const TWITTER_PHOTO_URL_RE =
  /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)\/photo\/(\d+)/i;

/** Parse a raw page URL into a tweet id + zero-based photo index, or null. */
export function parseTwitterPhotoUrl(rawUrl: string): TwitterPhotoTarget | null {
  const match = rawUrl.match(TWITTER_PHOTO_URL_RE);
  if (!match) return null;
  return {
    tweetId: match[1]!,
    photoIndex: Math.max(1, parseInt(match[2]!, 10)) - 1,
  };
}

/**
 * Pick the indexed photo out of syndication `mediaDetails`. Videos/GIFs are
 * ignored (a /photo/n URL only addresses photos). An out-of-range index
 * (deleted/edited tweet) falls back to the first photo. Returns the full-res
 * `?name=large` variant.
 */
export function pickSyndicationPhoto(
  mediaDetails: readonly SyndicationPhoto[],
  photoIndex: number,
): ResolvedLightboxImage | null {
  const photos = mediaDetails.filter(
    (m) => m.type === "photo" && m.media_url_https,
  );
  const photo = photos[photoIndex] ?? photos[0];
  if (!photo?.media_url_https) return null;
  return {
    src: photo.media_url_https + "?name=large",
    alt: photo.ext_alt_text ?? null,
    width: photo.original_info?.width ?? null,
    height: photo.original_info?.height ?? null,
  };
}

/** Fetch the indexed photo of a tweet via the syndication API, asked of
 *  background: the service refuses the page the overlay runs in. */
export async function fetchTweetPhotoByIndex(
  tweetId: string,
  photoIndex: number,
): Promise<ResolvedLightboxImage | null> {
  const data = await requestXSyndication(tweetId);
  if (!data) return null;
  // The service's own shape; the picker skips entries it cannot use.
  return pickSyndicationPhoto((Array.isArray(data.mediaDetails) ? data.mediaDetails : []) as SyndicationPhoto[], photoIndex);
}
