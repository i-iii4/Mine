import { describe, expect, it } from "vitest";
import { normalizedPostUrl, pickImageCardUrl } from "./postSourceUrl";

describe("normalizedPostUrl", () => {
  it("normalizes an X status, stripping the lightbox suffix and query", () => {
    expect(normalizedPostUrl("https://x.com/artist/status/123/photo/1?s=20"))
      .toBe("https://x.com/artist/status/123");
    expect(normalizedPostUrl("https://twitter.com/artist/status/123"))
      .toBe("https://x.com/artist/status/123");
  });

  it("keeps a Bluesky post address", () => {
    expect(normalizedPostUrl("https://bsky.app/profile/a.bsky.social/post/3liyt?ref=x"))
      .toBe("https://bsky.app/profile/a.bsky.social/post/3liyt");
  });

  it("rejects what is not a publication", () => {
    // A profile, a feed root and a CDN file cannot lead back to the post.
    expect(normalizedPostUrl("https://x.com/cocolinearts")).toBeNull();
    expect(normalizedPostUrl("https://bsky.app")).toBeNull();
    expect(normalizedPostUrl("https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:x/bafk")).toBeNull();
    expect(normalizedPostUrl("https://pbs.twimg.com/media/HLpV?format=jpg")).toBeNull();
    expect(normalizedPostUrl(null)).toBeNull();
  });
});

describe("pickImageCardUrl", () => {
  it("prefers the post found in the DOM over everything", () => {
    expect(pickImageCardUrl({
      domPostUrl: "https://bsky.app/profile/a.bsky.social/post/3liyt",
      pageUrl: "https://bsky.app",
      srcUrl: "https://cdn.bsky.app/img/feed_fullsize/plain/did/bafk",
    })).toBe("https://bsky.app/profile/a.bsky.social/post/3liyt");
  });

  it("falls back to the page when the page is itself the post", () => {
    // X rewrites the location to /photo/1 inside its lightbox.
    expect(pickImageCardUrl({
      pageUrl: "https://x.com/artist/status/123/photo/1",
      srcUrl: "https://pbs.twimg.com/media/HLpV?format=jpg",
    })).toBe("https://x.com/artist/status/123");
  });

  it("keeps the old behaviour when no post can be recovered", () => {
    expect(pickImageCardUrl({
      pageUrl: "https://example.com/gallery",
      srcUrl: "https://example.com/photo.jpg",
    })).toBe("https://example.com/photo.jpg");
    expect(pickImageCardUrl({ srcUrl: "data:image/png;base64,xx" })).toBe("");
  });

  it("ignores a DOM link that is not a publication", () => {
    expect(pickImageCardUrl({
      domPostUrl: "https://x.com/cocolinearts",
      pageUrl: "https://x.com/cocolinearts",
      srcUrl: "https://pbs.twimg.com/media/HLpV?format=jpg",
    })).toBe("https://pbs.twimg.com/media/HLpV?format=jpg");
  });
});
