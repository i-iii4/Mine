import "../../lib/xThread.js";
import type { ArticleData, PageMetadata } from "./messaging";
import { videoPreviewKey } from "./videoPreview";

/** The post an address of X names, by the one rule of lib/xThread.js: X, X Pro
 *  and Twitter, never a host that merely ends in "x.com" (SPEC_DEEP_AUDIT.md,
 *  Е3.15). */
export function xPostAddress(url: string | null | undefined): { handle: string; id: string } | null {
  return globalThis.MineXThread.postAddress(url);
}

export function isTwitterStatusUrl(url: string | null | undefined): boolean {
  return xPostAddress(url) !== null;
}

/** Whether the address is a page of X, X Pro or Twitter, any page. */
export function isXPageUrl(url: string | null | undefined): boolean {
  return globalThis.MineXThread.isXPage(url);
}

/** The text a syndication answer of an X post shows (SPEC_DEEP_AUDIT.md, Е3.6). */
export function syndicationShownText(data: { text?: unknown; display_text_range?: unknown }): string {
  return globalThis.MineXThread.syndicationText(data);
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
