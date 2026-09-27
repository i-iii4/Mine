import { describe, expect, it } from "vitest";
import fixtures from "../../extension/lib/youtubeSource.fixtures.json";
import { parseYoutubeSource } from "./youtubeSource";

describe("YouTube source grammar shared with the clipper and Rust", () => {
  it.each(fixtures)("interprets $url", ({ url, id }) => {
    const source = parseYoutubeSource(url);
    expect(source?.videoId ?? null).toBe(id);
    if (id) {
      expect(source).toEqual({
        provider: "youtube", videoId: id,
        sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        embedUrl: `https://www.youtube.com/embed/${id}`,
        posterUrl: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      });
    }
  });
});
