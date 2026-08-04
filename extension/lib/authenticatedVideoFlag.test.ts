import { describe, expect, it } from "vitest";

/// Mirrors the decision made in content.js after tweet extraction: does this
/// post have video that neither the API nor the DOM could resolve?
function needsAuthenticatedVideo(
  hasPlayerInPage: boolean,
  embeddedVideos: { src: string | null }[],
  apiMedia: { kind: string }[],
): boolean {
  const hasResolvedVideo =
    embeddedVideos.some((video) => !!video.src)
    || apiMedia.some((media) => media.kind === "video");
  return hasPlayerInPage && !hasResolvedVideo;
}

describe("authenticated video fallback decision", () => {
  it("triggers when the player runs off a blob URL", () => {
    // The preview entry exists but carries only a poster: blob: sources are
    // dropped upstream because they cannot be re-fetched. This is the exact
    // shape of an age-restricted tweet, and counting entries would miss it.
    expect(needsAuthenticatedVideo(true, [{ src: null }], [])).toBe(true);
  });

  it("stays off when the API resolved the video", () => {
    expect(needsAuthenticatedVideo(true, [{ src: null }], [{ kind: "video" }])).toBe(false);
  });

  it("stays off when the DOM gave a real source", () => {
    expect(
      needsAuthenticatedVideo(true, [{ src: "https://video.twimg.com/a.mp4" }], []),
    ).toBe(false);
  });

  it("stays off on posts with no player at all", () => {
    expect(needsAuthenticatedVideo(false, [], [{ kind: "photo" }])).toBe(false);
  });
});
