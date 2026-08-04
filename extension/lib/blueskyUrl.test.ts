import { describe, expect, it } from "vitest";

/// Mirrors isBlueskyPostUrl in content.js.
function isBlueskyPostUrl(url: string | null | undefined): boolean {
  return /(?:^|\/\/)(?:[\w.-]*\.)?bsky\.app\/profile\/[^/]+\/post\/[\w]+/i.test(url ?? "");
}

/// Mirrors the URL parsing inside extractBlueskyPost.
function parseBlueskyPost(url: string): { handleOrDid: string; rkey: string } | null {
  const match = url.match(/bsky\.app\/profile\/([^/]+)\/post\/([\w]+)/i);
  if (!match) return null;
  return { handleOrDid: match[1]!, rkey: match[2]! };
}

describe("Bluesky post URLs", () => {
  it("recognises a post by handle", () => {
    expect(
      isBlueskyPostUrl("https://bsky.app/profile/glacierclear.bsky.social/post/3msaufedhgs2w"),
    ).toBe(true);
  });

  it("recognises a post addressed by DID", () => {
    expect(
      isBlueskyPostUrl("https://bsky.app/profile/did:plc:yhcxtphccfv3jeacygabveql/post/3msaufedhgs2w"),
    ).toBe(true);
  });

  it("ignores profiles and the rest of the app", () => {
    expect(isBlueskyPostUrl("https://bsky.app/profile/glacierclear.bsky.social")).toBe(false);
    expect(isBlueskyPostUrl("https://bsky.app/search?q=cats")).toBe(false);
    expect(isBlueskyPostUrl("https://example.com/profile/a/post/b")).toBe(false);
  });

  it("splits the author and the record key", () => {
    const parsed = parseBlueskyPost(
      "https://bsky.app/profile/glacierclear.bsky.social/post/3msaufedhgs2w",
    );
    expect(parsed).toEqual({
      handleOrDid: "glacierclear.bsky.social",
      rkey: "3msaufedhgs2w",
    });
  });

  it("keeps a DID intact, since it needs no resolution", () => {
    const parsed = parseBlueskyPost(
      "https://bsky.app/profile/did:plc:yhcxtphccfv3jeacygabveql/post/3msaufedhgs2w",
    );
    expect(parsed?.handleOrDid).toBe("did:plc:yhcxtphccfv3jeacygabveql");
  });
});
