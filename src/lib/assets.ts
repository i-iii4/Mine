// Asset URL helpers for Tauri WebView.
// convertFileSrc transforms absolute file paths into asset:// URLs
// that the WebView can load securely.

import { convertFileSrc } from "@tauri-apps/api/core";

export function thumbnailUrl(vaultPath: string, slug: string): string {
  return convertFileSrc(`${vaultPath}/.arena/cache/thumbs/${slug}.jpg`);
}

export function mediaUrl(vaultPath: string, fileName: string): string {
  return convertFileSrc(`${vaultPath}/${fileName}`);
}

export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
