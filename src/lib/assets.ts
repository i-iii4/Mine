// Asset URL helpers for Tauri WebView.
// convertFileSrc transforms absolute file paths into asset:// URLs
// that the WebView can load securely.

import { convertFileSrc } from "@tauri-apps/api/core";

export function fallbackThumbsRoot(vaultPath: string): string {
  return `${vaultPath}/.mine/cache/thumbs`;
}

export function thumbnailUrl(thumbsRootPath: string, slug: string): string {
  return convertFileSrc(`${thumbsRootPath}/${slug}.jpg`);
}

export function previewAssetUrl(thumbsRootPath: string, previewPath: string): string {
  return convertFileSrc(`${thumbsRootPath}/${previewPath}`);
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
