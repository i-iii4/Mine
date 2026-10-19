import "../../lib/pageTitle.js";
import type { ArticleData, PageMetadata } from "./messaging";
import { articleHasTwitterMediaBody } from "./socialContent";

export type ArticleExtractionState = "idle" | "loading" | "ready" | "empty" | "failed";

export function articleHasText(article: ArticleData | null): boolean {
  return Boolean(article?.content.trim());
}

export function articleHasPreviewMedia(article: ArticleData | null): boolean {
  return (article?.embeddedVideos?.length ?? 0) > 0;
}

export function articleHasSaveableContent(
  metadata: PageMetadata | null,
  article: ArticleData | null,
): boolean {
  return articleHasText(article) || articleHasTwitterMediaBody(metadata, article);
}

export function articleExtractionStateForResult(
  article: ArticleData,
  metadata: PageMetadata | null = null,
): ArticleExtractionState {
  return articleHasSaveableContent(metadata, article) ? "ready" : "empty";
}

export function contentModeNeedsArticleExtraction(metadata: PageMetadata | null): boolean {
  if (!metadata) return false;
  if (metadata.detectedType === "video") return true;
  return !metadata.selection.trim();
}

/** A link's heading, unless its title is a placeholder of separators alone (SPEC_CLIPPER.md, «Название страницы»). */
export function buildLinkBody(title: string): string {
  const heading = title.trim();
  return globalThis.MinePageTitle.hasNameText(heading) ? `# ${heading}` : "";
}

export function emptyContentMessage(
  metadata: PageMetadata | null,
  state: ArticleExtractionState,
  article: ArticleData | null = null,
): string {
  if (article?.unavailableReason) return article.unavailableReason;
  if (state === "failed") {
    return "Content extraction failed. Save as Screenshot or Link, or try again.";
  }
  if (metadata?.detectedType === "video") {
    return "No transcript was extracted. Save as Screenshot or Link instead.";
  }
  return "No article text was extracted. Save as Screenshot or Link instead.";
}
