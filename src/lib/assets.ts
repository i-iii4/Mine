// Asset URL helpers for Tauri WebView.
// convertFileSrc transforms absolute file paths into asset:// URLs
// that the WebView can load securely.

import { convertFileSrc } from "@tauri-apps/api/core";
import { cardPicturesVersion } from "@/lib/pictureVersions";

/** The query parameter that carries the version of a card's pictures. */
const PICTURE_VERSION_PARAM = "pv";

export function fallbackThumbsRoot(vaultPath: string): string {
  return `${vaultPath}/.mine/cache/thumbs`;
}

/// A reduced level of a thumbnail, for surfaces that draw it small.
///
/// `micro` covers a 32-logical-pixel node or sidebar cell at double density;
/// `zoom` covers the graph's 100-pixel ceiling. Reading the full 640px file for
/// a 32px square costs four hundred times the decoded memory it needs.
export type ThumbLevel = "micro" | "zoom";

/** `url` with `key=value` added to its query. */
export function withQueryParam(url: string, key: string, value: string | number): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${value}`;
}

/// The address of a picture made from the card `slug`, carrying the version
/// of the card's pictures (`pictureVersions.ts`): the same address never
/// names two versions of a file within a page (SPEC_THUMBNAILS.md, «Адрес
/// картинки»).
function cardPictureUrl(path: string, slug: string): string {
  const version = cardPicturesVersion(slug);
  const url = convertFileSrc(path);
  return version ? withQueryParam(url, PICTURE_VERSION_PARAM, version) : url;
}

/// The card a derived preview belongs to, from the name the backend gives
/// it: `<slug>.jpg` for the primary preview, `<slug>.preview-<n>.jpg` for a
/// tile (`storage/preview_plan.rs`).
export function cardSlugOfPreviewPath(previewPath: string): string {
  return previewPath.replace(/\.jpg$/i, "").replace(/\.preview-\d+$/, "");
}

export function thumbnailUrl(thumbsRootPath: string, slug: string): string {
  return cardPictureUrl(`${thumbsRootPath}/${slug}.jpg`, slug);
}

export function thumbnailLevelUrl(
  thumbsRootPath: string,
  slug: string,
  level: ThumbLevel,
): string {
  return cardPictureUrl(`${thumbsRootPath}/${slug}.${level}.jpg`, slug);
}

export function previewAssetUrl(thumbsRootPath: string, previewPath: string): string {
  return cardPictureUrl(`${thumbsRootPath}/${previewPath}`, cardSlugOfPreviewPath(previewPath));
}

/// The address of a request made after a failed one. The retry mark makes the
/// browser ask the file again instead of repeating the failure it may keep in
/// its memory cache.
export function withRetry(url: string, retry: number): string {
  if (retry <= 0) return url;
  return withQueryParam(url, "retry", retry);
}

export function mediaUrl(vaultPath: string, fileName: string): string {
  return convertFileSrc(`${vaultPath}/${fileName}`);
}

export function audioAssetUrl(audioPath: string): string {
  return convertFileSrc(audioPath);
}

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Check that a URL uses a safe protocol (http/https). */
export function isSafeUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
