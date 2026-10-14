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
    /** oEmbed request for the video of an address; `null` when it is not a YouTube video. */
    youtubeOEmbedUrl(value: unknown): string | null;
    /** Channel of an oEmbed answer: `@handle` from `author_url`, else `author_name`. */
    youtubeChannelFromOEmbed(payload: unknown): string | null;
    /** Bound of the channel request and of the Save waiting for its answer. */
    readonly YOUTUBE_CHANNEL_TIMEOUT_MS: number;
  };
}
