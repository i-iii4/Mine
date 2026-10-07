import { afterEach, describe, expect, it, vi } from "vitest";

// The hook module reads `chrome` when it loads.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).chrome = { tabs: {}, runtime: {} };
});

import { hydrateTwitterVideoPreviews } from "./useClipperState";
import type { ArticleData } from "../lib/messaging";
import type { VideoToolState } from "../lib/videoTool";

// SPEC_CLIPPER.md, 3d, «Сбой утилиты видео», В4, В5: a restricted X post whose
// video only the helper's tool can get.

const tweetUrl = "https://x.com/someone/status/2106189157127328167";
const video = "https://video.twimg.com/amplify_video/2106189157127328167/vid/avc1/1280x720/clip.mp4";
const metadata = { url: tweetUrl } as never;
const restricted = (): ArticleData => ({
  title: "Post",
  content: "The post's own words",
  byline: null,
  excerpt: "",
  needsAuthenticatedVideo: true,
  tweetUrl,
  tweetId: "2106189157127328167",
});

/** The browser: the helper answers through the background's native port,
 *  the background answers the request for the video with the session. */
function browser(authenticated: unknown) {
  const background = vi.fn(async () => authenticated);
  const sendMessage = vi.fn((message: { action: string; payload?: { action?: string } }, callback?: (reply: unknown) => void) => {
    if (message.action === "nativeMessage") {
      callback?.({ ok: true, media: [] });
      return undefined;
    }
    return background();
  });
  (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage, lastError: undefined } };
  return { background };
}

afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = { tabs: {}, runtime: {} };
});

describe("a restricted X post and the helper's video tool", () => {
  it("does not ask a tool the self-check found not working, and says why", async () => {
    const { background } = browser({ ok: true, media: [{ kind: "video", src: video }] });
    const tool: VideoToolState = { state: "unavailable", reason: "blocked" };
    const result = await hydrateTwitterVideoPreviews(metadata, restricted(), Promise.resolve(tool));
    expect(background).not.toHaveBeenCalled();
    expect(result.content).toBe("The post's own words");
    expect(result.videoNotice).toBe("Couldn't get the video: macOS blocked the video tool. The text and pictures will be saved.");
  });

  it("keeps the post and says why when the tool fails on this post", async () => {
    browser({ ok: false, code: "video_tool_failed", reason: "timeout", error: "the tool did not finish within 20 s" });
    const result = await hydrateTwitterVideoPreviews(metadata, restricted(), Promise.resolve({ state: "ready", version: "2026.08.19" }));
    expect(result.content).toBe("The post's own words");
    expect(result.embeddedVideos ?? []).toEqual([]);
    expect(result.videoNotice).toBe("Couldn't get the video: the video tool didn't answer in time. The text and pictures will be saved.");
  });

  it("still asks when the self-check only ran past its deadline", async () => {
    const { background } = browser({ ok: true, media: [{ kind: "video", src: video }] });
    const tool: VideoToolState = { state: "unavailable", reason: "timeout" };
    const result = await hydrateTwitterVideoPreviews(metadata, restricted(), Promise.resolve(tool));
    expect(background).toHaveBeenCalledTimes(1);
    expect(result.videoNotice).toBeUndefined();
    expect(result.embeddedVideos?.map((preview) => preview.src)).toEqual([video]);
  });

  it("asks for the video as before when an older helper has no self-check", async () => {
    const { background } = browser({ ok: true, media: [{ kind: "video", src: video }] });
    const result = await hydrateTwitterVideoPreviews(metadata, restricted(), Promise.resolve(null));
    expect(background).toHaveBeenCalledTimes(1);
    expect(result.videoNotice).toBeUndefined();
    expect(result.embeddedVideos?.map((preview) => preview.src)).toEqual([video]);
    expect(result.content).toBe(`The post's own words\n\n![](${video})`);
  });

  it("does not wait for the self-check when the post needs no tool", async () => {
    browser({ ok: true, media: [] });
    const never = new Promise<VideoToolState | null>(() => {});
    const plain = { ...restricted(), needsAuthenticatedVideo: false };
    const result = await hydrateTwitterVideoPreviews(metadata, plain, never);
    expect(result.videoNotice).toBeUndefined();
  });
});
