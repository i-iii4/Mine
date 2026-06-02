import type { ArticleData, PageMetadata } from "./messaging";
import { videoPreviewKey } from "./videoPreview";

export function isTwitterStatusUrl(url: string | null | undefined): boolean {
  return /(?:^|\/\/)(?:www\.)?(?:x\.com|twitter\.com)\/[^/?#]+\/status\/\d+/i.test(url ?? "");
}

export function embeddedMediaMarkdown(article: ArticleData | null): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const video of article?.embeddedVideos ?? []) {
    const src = video.src?.trim();
    if (!src) continue;
    const key = videoPreviewKey(src) ?? src;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`![](${src})`);
  }

  return lines.join("\n\n");
}

export function articleHasTwitterMediaBody(
  metadata: PageMetadata | null,
  article: ArticleData | null,
): boolean {
  return isTwitterStatusUrl(metadata?.url) && embeddedMediaMarkdown(article).length > 0;
}
