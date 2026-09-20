import type { ArticleData, PageMetadata } from "./messaging";
import { resolveContentBody, type ResolvedContentBody } from "./resolveContentBody";

/** Source and selected content travel together through preview and saving. */
export type CaptureResult = {
  sourceUrl: string;
  body: ResolvedContentBody;
} & (
  | { kind: "content"; article: ArticleData | null }
  | { kind: "image"; imageUrl: string | null; width: number | null; height: number | null }
  | { kind: "screenshot" | "link" | "video" }
);

/** Assemble the existing draft without rereading the page or changing its selection. */
export function resolveCaptureResult(
  kind: "content" | "image" | "screenshot" | "link" | "video",
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
