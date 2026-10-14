/** A quoted post inside a post's card, as the page shows it. */
export interface TweetQuoteGroup {
  tweetId: string | null;
  /** Screen name without `@`; empty when the card names none. */
  handle: string;
  /** Display name; empty when the card names none. */
  name: string;
  text: string;
  /** Picture and video addresses, in card order. */
  media: string[];
  /** The quote shows a video, whether or not its address could be read. */
  hasVideo?: boolean;
}

/** The parts of a post's card: its own text and media, and its quotes. */
export interface TweetContentParts {
  mainText: string;
  media: string[];
  /** The post itself shows a video, whether or not its address could be read. */
  hasVideo: boolean;
  quotes: TweetQuoteGroup[];
}

/** What a quote contributes to the composed text. */
export interface TweetQuoteText {
  text?: string | null;
  media?: readonly string[] | null;
}

declare global {
  var MineTwitterTweetContent: {
    /** The post's text followed by each quote as a blockquote. */
    composeTweetText(mainText: string | null | undefined, quotes: readonly TweetQuoteText[] | null | undefined): string;
    extractTweetContent(article: Element): { text: string; media: string[] };
    extractTweetContentParts(article: Element): TweetContentParts;
    /** The large JPEG of a post picture, or `null` for any other address. */
    normalizeTweetImageSrc(src: string | null | undefined): string | null;
    /** The quote as a Markdown blockquote; empty when it has neither text nor media. */
    quoteToMarkdown(quote: TweetQuoteText | null | undefined): string;
    /** The text of a `tweetText` element as Markdown. */
    tweetTextToMarkdown(el: Element): string;
  };
}
