import type { EmbeddedVideoPreview } from "./messaging";

export function isVideoUrl(src: string | null | undefined): boolean {
  return /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(src ?? "");
}

export function videoPreviewKey(src: string | null | undefined): string | null {
  const trimmed = src?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.href;
  } catch {
    return trimmed;
  }
}

export function buildEmbeddedVideoPreviewMap(videos: EmbeddedVideoPreview[]) {
  const map = new Map<string, EmbeddedVideoPreview>();
  for (const video of videos) {
    const key = videoPreviewKey(video.src);
    if (key && !map.has(key)) {
      map.set(key, video);
    }
  }
  return map;
}

