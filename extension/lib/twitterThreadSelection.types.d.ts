/** A post as its status link spells it. */
export interface TweetIdentity {
  /** Screen name without `@`, lowercased. */
  handle: string;
  tweetId: string;
  /** The status link, absolute. */
  href: string;
}

/** Where to look for a thread and which post it is about. */
export interface TwitterThreadSelectionInput {
  document: Document;
  targetTweetId: string | null | undefined;
  authorHandle: string | null | undefined;
}

declare global {
  var MineTwitterThreadSelection: {
    /** The post a card of the page stands for, or `null` when no status link names it. */
    getTweetIdentity(article: Element): TweetIdentity | null;
    /**
     * The cards of the target post and of the posts of its author next to
     * it, in page order; only the target when it is not found by its id.
     */
    selectTwitterThreadArticles(input: TwitterThreadSelectionInput): Element[];
  };
}
