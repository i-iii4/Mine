import type { ArticleData } from "../popup/lib/messaging";

/** Converts the HTML of an article to Markdown, links resolved against `url`. */
export type MarkdownConverter = (html: string, url: string) => string;

declare global {
  var MineProductExtraction: {
    /**
     * The article of a confirmed Shopify product page: its gallery and
     * description (SPEC_PRODUCT_EXTRACTION.md), or `null` when the page is
     * not one. Conversion errors propagate to the caller.
     */
    extractProductArticle(doc: Document, pageUrl: string, toMarkdown: MarkdownConverter): ArticleData | null;
  };
}
