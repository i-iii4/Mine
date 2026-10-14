import type { EmbeddedVideoPreview } from "../popup/lib/messaging";

/** An X article (long-form post) read from its page. */
export interface XLongformArticle {
  title: string;
  content: string;
  /** `@handle` of the author, unless the caller named a byline. */
  byline: string;
  excerpt: string;
  embeddedVideos: EmbeddedVideoPreview[];
}

/**
 * `article`: the page shows a long-form post with its body. `empty`: it shows
 * the marks of one but no readable body, and the article is empty.
 */
export interface XLongformResult {
  status: "article" | "empty";
  article: XLongformArticle;
}

/** The page to read a long-form post from, and what stands in for its parts. */
export interface XLongformInput {
  document: Document | null | undefined;
  /** The page's address; the document's own when absent. */
  locationHref?: string | null;
  fallbackTitle?: string;
  fallbackByline?: string | null;
}

declare global {
  var MineXLongformArticleExtraction: {
    /** The long-form post of an X post page, or `null` when the page shows none. */
    extractXLongformArticle(input: XLongformInput): XLongformResult | null;
    /** The post a status address names, or `null` for any other address. */
    parseStatusIdentity(url: string | null | undefined): { authorHandle: string; tweetId: string } | null;
  };
}
