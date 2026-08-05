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

/// Mirrors parseBlueskyPlaylist in content.js.
function parseBlueskyPlaylist(
  playlist: string | null | undefined,
): { did: string; cid: string } | null {
  const match = String(playlist ?? "").match(/\/watch\/([^/]+)\/([^/]+)\/playlist\.m3u8/i);
  if (!match) return null;
  try {
    return { did: decodeURIComponent(match[1]!), cid: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

describe("Bluesky video playlists", () => {
  const playlist =
    "https://video.bsky.app/watch/did%3Aplc%3A2dwd4zvjtr3fob2pv2pwuf3t/bafkreifcfi/playlist.m3u8";

  it("recovers the repository the video blob lives in", () => {
    expect(parseBlueskyPlaylist(playlist)).toEqual({
      did: "did:plc:2dwd4zvjtr3fob2pv2pwuf3t",
      cid: "bafkreifcfi",
    });
  });

  it("returns null for anything that is not a watch playlist", () => {
    expect(parseBlueskyPlaylist("https://video.bsky.app/watch/did/thumbnail.jpg")).toBeNull();
    expect(parseBlueskyPlaylist("")).toBeNull();
    expect(parseBlueskyPlaylist(null)).toBeNull();
  });
});
