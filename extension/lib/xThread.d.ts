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

declare global {
  var MineXThread: {
    compose(posts: XPostContent[]): string;
    /** The text a syndication answer of a post shows: `display_text_range`, entities decoded. */
    syndicationText(data: { text?: unknown; display_text_range?: unknown } | null | undefined): string;
    /** The post an address of X names, or `null` for any other address. */
    postAddress(url: string | null | undefined): { handle: string; id: string } | null;
    /** Whether the address is a page of X, X Pro or Twitter. */
    isXPage(url: string | null | undefined): boolean;
  };
}
