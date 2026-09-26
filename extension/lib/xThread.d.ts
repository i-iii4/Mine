export interface XPostMedia {
  url: string;
  kind: "image" | "video";
  poster: string | null;
}

export interface XPostContent {
  id: string;
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
