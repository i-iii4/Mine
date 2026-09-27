import "../../extension/lib/youtubeSource.js";
import type { YoutubeSource } from "../../extension/lib/youtubeSource";

export type { YoutubeSource };

/** Interpret only a card's source URL, never links inside its article body. */
export function parseYoutubeSource(url: string | null | undefined): YoutubeSource | null {
  return globalThis.MineYoutubeSource.parse(url);
}
