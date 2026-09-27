export interface YoutubeSource {
  provider: "youtube";
  videoId: string;
  sourceUrl: string;
  embedUrl: string;
  posterUrl: string;
}

declare global {
  var MineYoutubeSource: {
    parse(value: unknown): YoutubeSource | null;
  };
}
