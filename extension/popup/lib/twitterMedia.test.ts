import { describe, expect, it, vi } from "vitest";
import { hydrateTwitterPosts, twitterMediaKey } from "./twitterMedia";
import type { ArticleData } from "./messaging";
import type { XPostContent } from "../../lib/xThread";

const video = "https://video.twimg.com/amplify_video/2103618771441360896/vid/avc1/1280x720/SRz40Vsis3bFBscQ.mp4?tag=14";
const gif = "https://video.twimg.com/tweet_video/HTGOUI-a8AA8ROt.mp4";
const poster = "https://pbs.twimg.com/tweet_video_thumb/HTGOUI-a8AA8ROt.jpg";
const media = (url: string) => ({ kind: "video" as const, url, poster });
const post = (id: string, urls: string[]): XPostContent => ({ id, text: `Post ${id}`, media: urls.map(media) });
const article = (posts: XPostContent[]): ArticleData => ({
  title: "Post", content: globalThis.MineXThread.compose(posts), byline: null, excerpt: "", twitterPosts: posts,
});
function resolver() {
  return {
    publicMedia: vi.fn(async (_id: string) => ({ ok: true, media: [] })),
    authenticatedMedia: vi.fn(async (_id: string) => ({ ok: true, media: [
      { kind: "video", src: video, poster: "https://pbs.twimg.com/amplify_video_thumb/first.jpg" },
      { kind: "video", src: gif, poster },
    ] })),
    frame: vi.fn(async () => null),
  };
}

describe("X media recovery", () => {
  it("recovers the reported video plus GIF when only the GIF was initially extracted", async () => {
    const r = resolver();
    const result = await hydrateTwitterPosts(article([post("2103621844733714547", [gif])]), r);
    expect(r.authenticatedMedia).toHaveBeenCalledWith("2103621844733714547");
    expect(result.embeddedVideos?.map(m => m.src)).toEqual([video, gif]);
    expect(result.content).toBe(`Post 2103621844733714547\n\n![](${video})\n\n![](${gif})`);
    expect(result.embeddedVideos?.every(m => m.poster?.startsWith("https://pbs.twimg.com/"))).toBe(true);
  });

  it("keeps other posts, photos, quotes and deliberate repeated media in their own scopes", async () => {
    const target = post("10", [gif]);
    const quoted = post("20", [gif]);
    const other = { ...post("30", []), media: [{ kind: "image" as const, url: "https://pbs.twimg.com/media/photo.jpg", poster: null }], quote: quoted };
    const r = resolver();
    r.authenticatedMedia.mockImplementation(async id => ({ ok: true, media: (id === "10" ? [video, gif] : [gif]).map(src => ({ kind: "video", src, poster })) }));
    const result = await hydrateTwitterPosts(article([target, other]), r);
    expect(result.content).toContain(`Post 10\n\n![](${video})\n\n![](${gif})\n\n***\n\nPost 30`);
    expect(result.content).toContain(`> Post 20\n> \n> ![](${gif})`);
    expect(result.content).toContain("![](https://pbs.twimg.com/media/photo.jpg)");
    expect(result.embeddedVideos?.map(m => m.src)).toEqual([video, gif, gif]);
    expect(r.publicMedia.mock.calls.map(([id]) => id)).toEqual(["10", "20"]);
  });

  it("preserves known media if both resolution paths fail", async () => {
    const r = resolver();
    r.authenticatedMedia.mockResolvedValue({ ok: false, media: [] });
    const input = article([post("10", [gif])]);
    const result = await hydrateTwitterPosts(input, r);
    expect(result.content).toBe(input.content);
    expect(result.embeddedVideos?.map(m => m.src)).toEqual([gif]);
  });

  it("uses public media without requesting cookies when public video is available", async () => {
    const r = resolver();
    r.publicMedia.mockResolvedValue(await r.authenticatedMedia("10"));
    r.authenticatedMedia.mockClear();
    const result = await hydrateTwitterPosts(article([post("10", [gif])]), r);
    expect(r.authenticatedMedia).not.toHaveBeenCalled();
    expect(result.embeddedVideos?.map(m => m.src)).toEqual([video, gif]);
  });

  it("does not duplicate a different rendition of the same video", async () => {
    const low = video.replace("1280x720/SRz40Vsis3bFBscQ", "640x360/low");
    const result = await hydrateTwitterPosts(article([post("10", [low, gif])]), resolver());
    expect(result.embeddedVideos?.map(m => m.src)).toEqual([video, gif]);
    expect(result.content).not.toContain(low);
    expect(twitterMediaKey(low)).toBe(twitterMediaKey(video));
  });

  it("resolves a player with no direct URL and leaves text-only posts alone", async () => {
    const r = resolver();
    const result = await hydrateTwitterPosts(article([{ ...post("10", []), hasVideo: true }, post("11", [])]), r);
    expect(result.embeddedVideos).toHaveLength(2);
    expect(r.publicMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps known order and photos when a later response contains only one of two videos", async () => {
    const r = resolver();
    r.authenticatedMedia.mockResolvedValue({ ok: true, media: [{ kind: "video", src: gif, poster }] });
    const mixed = post("10", [video, gif]);
    mixed.media.splice(1, 0, { kind: "image", url: "https://pbs.twimg.com/media/still.jpg", poster: null });
    const result = await hydrateTwitterPosts(article([mixed]), r);
    expect(result.twitterPosts?.[0]?.media.map(m => m.url)).toEqual(mixed.media.map(m => m.url));
  });

  it("keeps the captured body if the extension transport rejects", async () => {
    const r = resolver();
    r.publicMedia.mockRejectedValue(new Error("Disconnected"));
    r.authenticatedMedia.mockRejectedValue(new Error("Disconnected"));
    const input = article([post("10", [gif])]);
    expect((await hydrateTwitterPosts(input, r)).content).toBe(input.content);
  });

  it("does not refetch complete GraphQL attachments", async () => {
    const r = resolver();
    const input = article([{ ...post("10", [video, gif]), mediaComplete: true }]);
    expect((await hydrateTwitterPosts(input, r)).content).toBe(input.content);
    expect(r.publicMedia).not.toHaveBeenCalled();
    expect(r.authenticatedMedia).not.toHaveBeenCalled();
  });
});
