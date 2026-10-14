/** Called when the Mine button of a post is pressed: the post's card and the button. */
export type XFeedButtonActivate = (article: Element, control: Element) => void;

/** The post a card stands for, as its links spell it. */
export interface XFeedPostIdentity {
  tweetId: string;
  /** Screen name without `@`, as the link spells it. */
  handle: string;
  /** The status link, absolute. */
  href: string;
}

declare global {
  var MineXFeedButton: {
    /** The attribute that marks a Mine button in the page. */
    readonly OWNED_ATTRIBUTE: string;
    isXHost(hostname: string | null | undefined): boolean;
    postIdentity(article: Element): XFeedPostIdentity | null;
    /** Whether the card is the post X Pro opened over a column (Р2). */
    isStackMainPost(article: Element): boolean;
    /** The post's Mine button, made or kept, or `null` when the post gets none here. */
    ensureButton(article: Element, activate: XFeedButtonActivate): Element | null;
    /** The Mine button of an X Pro stack header, or `null` when it gets none. */
    ensureStackButton(header: Element, activate: XFeedButtonActivate): Element | null;
    /** One full pass over every post and stack header under `doc`. */
    scan(doc: ParentNode, activate: XFeedButtonActivate): void;
    /** Keep a Mine button on every post as X changes the page; returns the function that stops it. */
    watch(doc: Document, activate: XFeedButtonActivate): () => void;
    /** Take every Mine button under `scope` away. */
    removeAll(scope: ParentNode): void;
  };
}
