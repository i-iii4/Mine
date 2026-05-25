import type { ArticleData, PageMetadata } from "./messaging";

export type ArticleExtractionState = "idle" | "loading" | "ready" | "empty" | "failed";

export function articleHasText(article: ArticleData | null): boolean {
  return Boolean(article?.content.trim());
}

export function articleHasPreviewMedia(article: ArticleData | null): boolean {
  return (article?.embeddedVideos?.length ?? 0) > 0;
}

export function articleExtractionStateForResult(article: ArticleData): ArticleExtractionState {
  return articleHasText(article) ? "ready" : "empty";
}

export function contentModeNeedsArticleExtraction(metadata: PageMetadata | null): boolean {
  if (!metadata) return false;
  if (metadata.detectedType === "video") return true;
  return !metadata.selection.trim();
}

export function buildLinkBody(title: string): string {
  const heading = title.trim();
  return heading ? `# ${heading}` : "";
}

export function emptyContentMessage(
  metadata: PageMetadata | null,
  state: ArticleExtractionState,
): string {
  if (state === "failed") {
    return "Content extraction failed. Save as Screenshot or Link, or try again.";
  }
  if (metadata?.detectedType === "video") {
    return "No transcript was extracted. Save as Screenshot or Link instead.";
  }
  return "No article text was extracted. Save as Screenshot or Link instead.";
}
