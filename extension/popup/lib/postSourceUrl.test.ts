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

  // SPEC_CLIPPER.md, «Ссылка карточки при сохранении фото», step 3: off X
  // and Bluesky the card links to the page it was saved on, not to the file
  // server, from which there is no way back to the product.
  it("links a picture of a shop page to the page, not to its file server", () => {
    expect(pickImageCardUrl({
      pageUrl: "https://shop.example/products/linen-shirt?variant=2",
      srcUrl: "https://cdn.shopify.com/s/files/1/0/products/linen.jpg?v=1",
    })).toBe("https://shop.example/products/linen-shirt?variant=2");
    expect(pickImageCardUrl({
      pageUrl: "https://example.com/gallery",
      srcUrl: "https://example.com/photo.jpg",
    })).toBe("https://example.com/gallery");
    // A picture without an address of its own still links to its page.
    expect(pickImageCardUrl({
      pageUrl: "https://example.com/gallery",
      srcUrl: "data:image/png;base64,xx",
    })).toBe("https://example.com/gallery");
  });

  // Step 4: the file when the page is the picture itself.
  it("links to the file when the page is the picture itself", () => {
    const file = "https://upload.wikimedia.org/wikipedia/commons/a/a1/Harvest.jpg";
    expect(pickImageCardUrl({ pageUrl: file, srcUrl: file })).toBe(file);
    expect(pickImageCardUrl({ pageUrl: `${file}#top`, srcUrl: file })).toBe(file);
  });

  // Step 4: the file when the page has no http(s) address.
  it("links to the file when the page has no web address", () => {
    expect(pickImageCardUrl({
      pageUrl: "file:///Users/someone/picture.html",
      srcUrl: "https://example.com/photo.jpg",
    })).toBe("https://example.com/photo.jpg");
    expect(pickImageCardUrl({
      pageUrl: "chrome-extension://abc/page.html",
      srcUrl: "https://example.com/photo.jpg",
    })).toBe("https://example.com/photo.jpg");
    expect(pickImageCardUrl({ srcUrl: "https://example.com/photo.jpg" })).toBe("https://example.com/photo.jpg");
    expect(pickImageCardUrl({ srcUrl: "data:image/png;base64,xx" })).toBe("");
  });

  // On X and Bluesky step 3 does not apply: a profile or the feed root is not
  // the publication and never outranks the file.
  it("keeps the file over a profile of X or the root of Bluesky", () => {
    expect(pickImageCardUrl({
      pageUrl: "https://x.com/cocolinearts",
      srcUrl: "https://pbs.twimg.com/media/HLpV?format=jpg",
    })).toBe("https://pbs.twimg.com/media/HLpV?format=jpg");
    expect(pickImageCardUrl({
      pageUrl: "https://x.com/home",
      srcUrl: "https://pbs.twimg.com/media/HLpV?format=jpg",
    })).toBe("https://pbs.twimg.com/media/HLpV?format=jpg");
    expect(pickImageCardUrl({
      pageUrl: "https://bsky.app",
      srcUrl: "https://cdn.bsky.app/img/feed_fullsize/plain/did/bafk",
    })).toBe("https://cdn.bsky.app/img/feed_fullsize/plain/did/bafk");
    expect(pickImageCardUrl({
      pageUrl: "https://bsky.app/profile/a.bsky.social",
      srcUrl: "https://cdn.bsky.app/img/feed_fullsize/plain/did/bafk",
    })).toBe("https://cdn.bsky.app/img/feed_fullsize/plain/did/bafk");
  });

  it("links a picture of an X post to the post", () => {
    expect(pickImageCardUrl({
      pageUrl: "https://x.com/artist/status/123",
      srcUrl: "https://pbs.twimg.com/media/HLpV?format=jpg",
    })).toBe("https://x.com/artist/status/123");
  });

  it("ignores a DOM link that is not a publication", () => {
    expect(pickImageCardUrl({
      domPostUrl: "https://x.com/cocolinearts",
      pageUrl: "https://x.com/cocolinearts",
      srcUrl: "https://pbs.twimg.com/media/HLpV?format=jpg",
    })).toBe("https://pbs.twimg.com/media/HLpV?format=jpg");
  });
});
