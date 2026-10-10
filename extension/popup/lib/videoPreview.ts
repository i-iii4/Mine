import { fromMarkdown } from "mdast-util-from-markdown";
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

type MarkdownNode = { type: string; url?: string; children?: MarkdownNode[] };

/** Preview identities of every image-syntax embed in a Markdown body. A video
 * the body already holds is drawn at its place there, never again above it. */
export function markdownMediaKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  function visit(node: MarkdownNode) {
    if (node.type === "image") {
      const key = videoPreviewKey(node.url);
      if (key) keys.add(key);
    }
    node.children?.forEach(visit);
  }
  if (markdown) visit(fromMarkdown(markdown));
  return keys;
}
