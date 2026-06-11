import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseTwitterPhotoUrl,
  pickSyndicationPhoto,
  fetchTweetPhotoByIndex,
} from "./twitterPhotoLightbox";

describe("parseTwitterPhotoUrl", () => {
  it("parses an x.com photo URL into tweet id and zero-based index", () => {
    expect(
      parseTwitterPhotoUrl("https://x.com/poellll/status/2064739027647922677/photo/1"),
    ).toEqual({ tweetId: "2064739027647922677", photoIndex: 0 });
  });

  it("parses twitter.com and a non-first photo index", () => {
    expect(
      parseTwitterPhotoUrl("https://twitter.com/user/status/123/photo/3"),
    ).toEqual({ tweetId: "123", photoIndex: 2 });
  });

  it("ignores trailing query/fragment", () => {
    expect(
      parseTwitterPhotoUrl("https://x.com/u/status/55/photo/2?s=20&t=x"),
    ).toEqual({ tweetId: "55", photoIndex: 1 });
  });

  it("returns null for a plain tweet URL without /photo/", () => {
    expect(parseTwitterPhotoUrl("https://x.com/u/status/123")).toBeNull();
  });

  it("returns null for a non-Twitter URL", () => {
    expect(parseTwitterPhotoUrl("https://example.com/a/status/1/photo/1")).toBeNull();
  });
});

describe("pickSyndicationPhoto", () => {
  const media = [
    {
      type: "photo",
      media_url_https: "https://pbs.twimg.com/media/AAA.jpg",
      ext_alt_text: "first",
      original_info: { width: 1200, height: 800 },
    },
    {
      type: "photo",
      media_url_https: "https://pbs.twimg.com/media/BBB.jpg",
    },
  ];

  it("returns the indexed photo at full resolution with alt and size", () => {
    expect(pickSyndicationPhoto(media, 0)).toEqual({
      src: "https://pbs.twimg.com/media/AAA.jpg?name=large",
      alt: "first",
      width: 1200,
      height: 800,
    });
  });

  it("returns the second photo and null alt/size when absent", () => {
    expect(pickSyndicationPhoto(media, 1)).toEqual({
      src: "https://pbs.twimg.com/media/BBB.jpg?name=large",
      alt: null,
      width: null,
      height: null,
    });
  });

  it("filters out video/gif media (only photos are addressable by /photo/n)", () => {
    const mixed = [
      { type: "video", media_url_https: "https://pbs.twimg.com/media/VID.jpg" },
      { type: "photo", media_url_https: "https://pbs.twimg.com/media/PIC.jpg" },
    ];
    expect(pickSyndicationPhoto(mixed, 0)?.src).toBe(
      "https://pbs.twimg.com/media/PIC.jpg?name=large",
    );
  });

  it("falls back to the first photo when the index is out of range", () => {
    expect(pickSyndicationPhoto(media, 9)?.src).toBe(
      "https://pbs.twimg.com/media/AAA.jpg?name=large",
    );
  });

  it("returns null when there are no photos", () => {
    expect(pickSyndicationPhoto([{ type: "video" }], 0)).toBeNull();
    expect(pickSyndicationPhoto([], 0)).toBeNull();
  });
});

describe("fetchTweetPhotoByIndex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the syndication endpoint and returns the indexed photo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        mediaDetails: [
          { type: "photo", media_url_https: "https://pbs.twimg.com/media/AAA.jpg" },
          { type: "photo", media_url_https: "https://pbs.twimg.com/media/BBB.jpg" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTweetPhotoByIndex("999", 1);
    expect(result?.src).toBe("https://pbs.twimg.com/media/BBB.jpg?name=large");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.syndication.twimg.com/tweet-result?id=999&token=0",
    );
  });

  it("returns null when the syndication response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchTweetPhotoByIndex("999", 0)).toBeNull();
  });
});
