export interface XPostMedia {
  url: string;
  kind: "image" | "video";
  poster: string | null;
}

export interface XPostContent {
  id: string;
  /** Screen name without `@`; names the author of a quoted post. */
  handle?: string;
  /** Display name; names the author of a quoted post. */
  name?: string;
  text: string;
  media: XPostMedia[];
  quote?: XPostContent | null;
  hasVideo?: boolean;
  mediaComplete?: boolean;
}

/** A post as X's GraphQL answers deliver it, normalized by `MineXThread.post`. */
export interface XThreadPost extends XPostContent {
  authorId: string;
  handle: string;
  name: string;
  /** The post it replies to, or `null`. */
  parentId: string | null;
  quote: XThreadPost | null;
  /** Some of its text or media could not be read from the answer. */
  incomplete: boolean;
  hasVideo: boolean;
  /** Every medium the post has is in `media`. */
  mediaComplete: boolean;
}

/** A continuation of a conversation: global, or of one module (a reply chain). */
export interface XThreadCursor {
  value: string;
  direction: "Bottom" | "ShowMore" | "Top" | "ShowMoreThreads";
  /** The module the cursor continues, or `null` for the conversation. */
  moduleId: string | null;
}

/** A module of a conversation page: one reply chain and the posts it holds. */
export interface XThreadModule {
  id: string;
  postIds: string[];
  /** X withheld a post of the module. */
  unavailable: boolean;
}

/** One page of a conversation answer. */
export interface XThreadPageData {
  posts: XThreadPost[];
  cursors: XThreadCursor[];
  modules: XThreadModule[];
  /** X withheld a post outside any module. */
  unavailable: boolean;
}

declare global {
  var MineXThread: {
    /** The posts, cursors and modules of a conversation answer; throws on an answer it cannot read. */
    page(data: unknown): XThreadPageData;
    /** The posts of a feed answer (a repost as the post it reposts); none for a shape it does not know. */
    feed(data: unknown): XThreadPost[];
    /** One post of an answer, its quote one level deep, or `null` when the answer does not hold one. */
    post(result: unknown, quoteDepth?: number): XThreadPost | null;
    /** The author chain of post `targetId` among `posts`, and what kept any of it from loading. */
    select(posts: readonly XThreadPost[], targetId: string): { posts: XThreadPost[]; issues: string[] };
    /** The cursors that continue the author chain of `targetId`, and whether X withheld part of it. */
    continuations(pages: readonly XThreadPageData[], targetId: string): { cursors: XThreadCursor[]; unavailable: boolean };
    compose(posts: readonly XPostContent[]): string;
    /** The text a syndication answer of a post shows: `display_text_range`, entities decoded. */
    syndicationText(data: { text?: unknown; display_text_range?: unknown } | null | undefined): string;
    /** The post an address of X names, or `null` for any other address. */
    postAddress(url: string | null | undefined): { handle: string; id: string } | null;
    /** Whether the address is a page of X, X Pro or Twitter. */
    isXPage(url: string | null | undefined): boolean;
  };
}
