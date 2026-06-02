// Single source of truth for the body of a content-type clip.
//
// Both the save() pipeline in useClipperState.ts and the preview render
// in PopupApp.tsx delegate to this function. Keeping them both behind
// one pure function makes it structurally impossible for the popup
// preview to show one thing while the saved block contains another —
// a divergence that caused a real user-visible bug where the popup
// displayed the full article while the user had only selected a
// paragraph.
//
// Priority rules (must stay in lockstep with save() and preview):
//
//   1. detectedType === "video" → always articleData.content (ignore
//      selection, since video clips represent YouTube transcripts /
//      long-form captions, not a selected fragment).
//   2. metadata.selection non-empty → selection wins over article.
//   3. articleData.content present → article body; byline propagates
//      so the caller can use it as author.
//   4. Twitter/X media-only post → media markdown body.
//   5. Nothing → empty, source = "empty".
//
// Contract test: extension/popup/hooks/resolveContentBody.test.ts
// Changing the ordering silently will break either save or preview.
// If you change the rules, update the contract test in the same commit.

import type { PageMetadata, ArticleData } from "./messaging";
import { articleHasTwitterMediaBody, embeddedMediaMarkdown } from "./socialContent";

export type ContentBodySource = "video" | "selection" | "article" | "empty";

export interface ResolvedContentBody {
  text: string;
  source: ContentBodySource;
  /** Optional byline, relevant only for article source. */
  byline: string | null;
}

export function resolveContentBody(
  metadata: PageMetadata | null,
  articleData: ArticleData | null,
): ResolvedContentBody {
  if (!metadata) return { text: "", source: "empty", byline: null };

  if (metadata.detectedType === "video") {
    return {
      text: articleData?.content ?? "",
      source: "video",
      byline: null,
    };
  }

  if (metadata.selection && metadata.selection.length > 0) {
    return {
      text: metadata.selection,
      source: "selection",
      byline: null,
    };
  }

  if (articleData?.content) {
    return {
      text: articleData.content,
      source: "article",
      byline: articleData.byline ?? null,
    };
  }

  if (articleHasTwitterMediaBody(metadata, articleData)) {
    return {
      text: embeddedMediaMarkdown(articleData),
      source: "article",
      byline: articleData?.byline ?? metadata.author ?? null,
    };
  }

  return { text: "", source: "empty", byline: null };
}
