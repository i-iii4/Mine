import { describe, it, expect } from "vitest";
import "./xThread.js";

const api = globalThis.MineXThread;
function raw(id: string, parent: string | null = null, author = "7", extra = {}) {
  return { __typename: "Tweet", rest_id: id, core: { user_results: { result: { rest_id: author, core: { screen_name: "author" } } } },
    legacy: { id_str: id, full_text: `post ${id}`, in_reply_to_status_id_str: parent, ...extra } };
}
const item = (t: ReturnType<typeof raw>) => ({ itemContent: { itemType: "TimelineTweet", tweet_results: { result: t } } });
function response(tweets: ReturnType<typeof raw>[]) {
  return { data: { threaded_conversation_with_injections_v2: { instructions: [
    { type: "TimelineAddEntries", entries: tweets.map(t => ({ content: item(t) })) },
  ] } } };
}
const select = (tweets: ReturnType<typeof raw>[], target = "10") => api.select(api.page(response(tweets)).posts, target);

describe("X author-chain contract", () => {
  it("distinguishes complete extended media from a partial entity or unresolved player", () => {
    const gif = { type: "animated_gif", media_url_https: "https://pbs.twimg.com/media/frame.jpg",
      video_info: { variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/tweet_video/gif.mp4" }] } };
    expect(api.post(raw("10", null, "7", { extended_entities: { media: [gif] } }))).toMatchObject({ hasVideo: true, mediaComplete: true });
    expect(api.post(raw("10", null, "7", { entities: { media: [gif] } }))).toMatchObject({ hasVideo: true, mediaComplete: false });
    expect(api.post(raw("10", null, "7", { extended_entities: { media: [{ type: "video" }] } }))).toMatchObject({ hasVideo: true, mediaComplete: false, media: [] });
  });
  it("ignores global discussion cursors when the four-part author chain is loaded", () => {
    const d = response([raw("10"), raw("11", "10"), raw("12", "11"), raw("13", "12")]);
    d.data.threaded_conversation_with_injections_v2.instructions[0].entries.push({ content: { __typename: "TimelineTimelineCursor", cursorType: "Bottom", value: "infinite-comments" } });
    expect(api.continuations([api.page(d)], "10").cursors).toEqual([]);
  });
  it("loads only the selected author module and preserves ownership on append", () => {
    const cursor = value => ({ item: { itemContent: { __typename: "TimelineTimelineCursor", cursorType: "ShowMore", value } } });
    const d = response([raw("10")]);
    d.data.threaded_conversation_with_injections_v2.instructions[0].entries.push(
      { entryId: "conversationthread-author", content: { items: [{ item: item(raw("11", "10")) }, cursor("author-next")] } },
      { entryId: "conversationthread-comment", content: { items: [{ item: item(raw("20", "10", "8")) }, cursor("comment-next")] } },
    );
    const first = api.page(d);
    expect(api.continuations([first], "10").cursors.map(c => c.value)).toEqual(["author-next"]);
    const second = api.page({ data: { threaded_conversation_with_injections_v2: { instructions: [{
      type: "TimelineAddToModule", moduleEntryId: "conversationthread-author", moduleItems: [cursor("author-next-2")],
    }] } } });
    expect(api.continuations([first, second], "10").cursors.map(c => c.value)).toEqual(["author-next", "author-next-2"]);
  });
  it("uses the top cursor only when an ancestor is missing", () => {
    const d = response([raw("11", "10")]);
    d.data.threaded_conversation_with_injections_v2.instructions[0].entries.push({ content: { __typename: "TimelineTimelineCursor", cursorType: "Top", value: "ancestors" } });
    const p = api.page(d);
    expect(api.continuations([p], "11").cursors).toHaveLength(1);
    expect(api.continuations([p, api.page(response([raw("10")]))], "11").cursors).toEqual([]);
  });
  it("collects the reported four-part chain and excludes both comment branches", () => {
    const ids = ["2099105293938708797", "2099105296912462179", "2099105299630354832", "2099106114575143209"];
    const tweets = ids.map((id, i) => raw(id, ids[i - 1] || null));
    tweets.splice(1, 0, raw("2099120191942603204", ids[0], "8"), raw("2099131999629799748", "2099120191942603204"));
    for (const target of [ids[0], ids[3]]) expect(select(tweets, target).posts.map(p => p.id)).toEqual(ids);
  });
  it("excludes same-author recommendations without a reply relationship", () => {
    expect(select([raw("10"), raw("11", "10"), raw("12")]).posts.map(p => p.id)).toEqual(["10", "11"]);
  });
  it("ignores API order and deduplicates overlap between pages", () => {
    expect(select([raw("12", "11"), raw("10"), raw("11", "10"), raw("10")]).posts.map(p => p.id)).toEqual(["10", "11", "12"]);
  });
  it("keeps branches with each parent before its descendants", () => {
    expect(select([raw("10"), raw("13", "11"), raw("12", "10"), raw("11", "10")]).posts.map(p => p.id)).toEqual(["10", "11", "12", "13"]);
  });
  it("stops ancestor traversal at another author", () => {
    expect(select([raw("9", null, "8"), raw("10", "9"), raw("11", "10")]).posts.map(p => p.id)).toEqual(["10", "11"]);
  });
  it("does not substitute another post when target is missing", () => {
    expect(select([raw("11")]).posts).toEqual([]);
  });
  it("reports missing ancestry, cycles and contradictory identities", () => {
    expect(select([raw("10", "9")]).issues).not.toHaveLength(0);
    expect(select([raw("10", "11"), raw("11", "10")]).issues).not.toHaveLength(0);
    expect(select([raw("10"), raw("10", "11")]).issues).not.toHaveLength(0);
  });
  it("reads modules, visibility wrappers, cursor replacement and add-to-module pages", () => {
    const d = response([]);
    d.data.threaded_conversation_with_injections_v2.instructions = [
      { type: "TimelineAddEntries", entries: [{ content: { __typename: "TimelineTimelineModule", items: [{ item: item(raw("10")) }] } }] },
      { type: "TimelineAddToModule", moduleItems: [{ item: { itemContent: { itemType: "TimelineTweet", tweet_results: { result: { __typename: "TweetWithVisibilityResults", tweet: raw("11", "10") } } } } }] },
      { type: "TimelineReplaceEntry", entry: { content: { __typename: "TimelineTimelineCursor", cursorType: "Bottom", value: "next" } } },
    ];
    expect(api.page(d).posts.map(p => p.id)).toEqual(["10", "11"]);
    expect(api.page(d).cursors).toEqual([{ value: "next", direction: "Bottom", moduleId: null }]);
  });
  it("accepts a valid empty continuation without requiring the focal post again", () => {
    expect(api.page(response([]))).toEqual({ posts: [], cursors: [], modules: [], unavailable: false });
  });
  it("rejects errors and unknown response envelopes", () => {
    expect(() => api.page({})).toThrow();
    expect(() => api.page({ ...response([]), errors: [{ message: "denied" }] })).toThrow();
  });
  it("marks unavailable posts and ignores promoted entries", () => {
    const d = response([raw("10")]);
    d.data.threaded_conversation_with_injections_v2.instructions[0].entries.push({ content: { itemContent: { itemType: "TimelineTweet", tweet_results: { result: { __typename: "TweetTombstone" } } } } });
    expect(api.page(d).unavailable).toBe(true);
    d.data.threaded_conversation_with_injections_v2.instructions[0].entries[0].content.itemContent.promotedMetadata = {};
    expect(api.page(d).posts).toHaveLength(0);
  });
  it("collects photos and highest-bitrate MP4 from a continuation", () => {
    const t = raw("11", "10", "7", { extended_entities: { media: [
      { type: "photo", media_url_https: "https://pbs.twimg.com/one.jpg" },
      { type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg", video_info: { variants: [
        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/a.m3u8" },
        { content_type: "video/mp4", bitrate: 10, url: "https://video.twimg.com/small.mp4" },
        { content_type: "video/mp4", bitrate: 20, url: "https://video.twimg.com/full.mp4" },
      ] } },
    ] } });
    const result = select([raw("10"), t]);
    expect(api.compose(result.posts)).toContain("https://video.twimg.com/full.mp4");
    expect(result.posts[1].media).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });
  it("does not mistake a poster or blob for a saved video", () => {
    expect(select([raw("10", null, "7", { extended_entities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg" }] } })]).issues).not.toHaveLength(0);
  });
  it("keeps a quote inside its parent, uses note text and safe thread separators", () => {
    const t = { ...raw("10"), note_tweet: { note_tweet_results: { result: { text: "full long text" } } }, quoted_status_result: { result: raw("8", null, "9") } };
    const result = select([t, raw("11", "10")]);
    expect(api.compose(result.posts)).toBe("full long text\n\n> post 8\n\n***\n\npost 11");
  });
});
