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
  };
}
