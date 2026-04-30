import { describe, expect, it } from "vitest";
import {
  buildEmbeddedVideoPreviewMap,
  isVideoUrl,
  videoPreviewKey,
} from "./videoPreview";

describe("clipper video preview identity", () => {
  it("matches the same Twitter mp4 from embeddedVideos and markdown", () => {
    const src = "https://video.twimg.com/tweet_video/HHEgvO5XEAA3gfF.mp4";
    const previews = buildEmbeddedVideoPreviewMap([
      {
        src,
        poster: "https://pbs.twimg.com/tweet_video_thumb/HHEgvO5XEAA3gfF.jpg",
        title: "Tweet video preview",
      },
    ]);

    expect(previews.get(videoPreviewKey(src) ?? "")?.poster).toBe(
      "https://pbs.twimg.com/tweet_video_thumb/HHEgvO5XEAA3gfF.jpg",
    );
  });

  it("keeps URL fragments out of preview identity", () => {
    expect(videoPreviewKey("https://example.com/clip.mp4#frame")).toBe(
      "https://example.com/clip.mp4",
    );
  });

  it("recognizes inline video URLs with query strings", () => {
    expect(isVideoUrl("https://example.com/clip.mp4?token=abc")).toBe(true);
    expect(isVideoUrl("https://example.com/poster.jpg")).toBe(false);
  });
});

