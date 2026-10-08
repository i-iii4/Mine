import "../../lib/youtubeSource.js";
import type { ArticleData, PageMetadata } from "./messaging";
import { resolveContentBody, type ResolvedContentBody } from "./resolveContentBody";

/** What a clip saves of its page. */
export type CaptureKind = "content" | "image" | "screenshot" | "link" | "video";

/** Source and selected content travel together through preview and saving. */
export type CaptureResult = {
  sourceUrl: string;
  body: ResolvedContentBody;
} & (
  | { kind: "content"; article: ArticleData | null }
  | { kind: "image"; imageUrl: string | null; width: number | null; height: number | null }
  | { kind: "screenshot" | "link" | "video" }
);

/** Assemble the clip shown without rereading the page or changing its selection. */
export function resolveCaptureResult(
  kind: CaptureKind,
  metadata: PageMetadata | null,
  article: ArticleData | null,
): CaptureResult {
  const body = resolveContentBody(metadata, article);
  const usesArticle = kind === "content" && (body.source === "article" || body.source === "video");
  const sourceUrl = (usesArticle ? article?.sourceUrl : undefined) || metadata?.url || "";
  if (kind === "image") return {
    kind, sourceUrl, body,
    imageUrl: metadata?.imageToSave ?? metadata?.image ?? null,
    width: metadata?.imageWidth ?? null, height: metadata?.imageHeight ?? null,
  };
  if (kind === "content") return { kind, sourceUrl, body, article };
  return { kind, sourceUrl, body };
}

/** The YouTube video a capture's address names, as its canonical source; `null` for any other address. */
export function youtubeCaptureSourceUrl(metadata: PageMetadata | null): string | null {
  return globalThis.MineYoutubeSource.parse(metadata?.url)?.sourceUrl ?? null;
}

/**
 * The author Save writes (SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube»).
 * A YouTube capture takes the channel answered for the video of its address,
 * whatever is saved of it, and no author while the channel is unknown: the
 * page's byline may still belong to the video shown before an in-page
 * navigation (SPEC_CLIPPER.md, rule 1). Any other address keeps the page
 * author, replaced by the article byline when the content is the article.
 */
export function resolveCaptureAuthor(
  kind: CaptureKind,
  metadata: PageMetadata | null,
  article: ArticleData | null,
  youtubeChannel: string | null,
): string | null {
  if (youtubeCaptureSourceUrl(metadata)) return youtubeChannel?.trim() || null;
  if (kind === "content") {
    const body = resolveContentBody(metadata, article);
    if (body.source === "article" && body.byline) return body.byline;
  }
  return metadata?.author || null;
}
