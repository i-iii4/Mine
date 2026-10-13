import { describe, expect, it } from "vitest";
import { isTwitterStatusUrl, isXPageUrl } from "./socialContent";
import { parseTwitterPhotoUrl } from "./twitterPhotoLightbox";

// One rule for the address of X (SPEC_DEEP_AUDIT.md, Е3.15): X, X Pro and
// Twitter by their host, never a substring "x.com/".
describe("the address of an X post in the clipper", () => {
  it("knows a post of X Pro", () => {
    expect(isTwitterStatusUrl("https://pro.x.com/artist/status/123")).toBe(true);
    expect(isTwitterStatusUrl("https://x.com/artist/status/123")).toBe(true);
  });

  it("does not take another host for X", () => {
    expect(isTwitterStatusUrl("https://www.dropbox.com/team/status/123")).toBe(false);
    expect(isXPageUrl("https://www.dropbox.com/x.com/")).toBe(false);
    expect(parseTwitterPhotoUrl("https://netflix.com/user/status/123/photo/2")).toBeNull();
  });

  it("reads the photo of an X post page", () => {
    expect(parseTwitterPhotoUrl("https://x.com/artist/status/123/photo/2")).toEqual({ tweetId: "123", photoIndex: 1 });
  });
});
