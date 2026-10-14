import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import "./xThread.js";
import {
  listResponse, POST_VIDEO, QUOTE_POST_ID, QUOTED_ID, QUOTED_VIDEO, quotePost, REPOST_ID, REPOSTED_ID, userTweetsResponse, VIDEO_POST_ID,
} from "./xFeed.fixtures";

const api = globalThis.MineXThread;

// X's GraphQL answers as the tests build them. Their shapes are X's and vary by
// kind of entry; the tests put in ones the reader has to tell apart or skip.
/** A post, or another result X puts in its place (a tombstone, a wrapper). */
type RawResult = { __typename: string } & Record<string, unknown>;
type RawItem = { itemContent: { itemType: string; tweet_results: { result: RawResult }; promotedMetadata?: object } };
interface RawEntry { entryId?: string; content: Record<string, unknown> }
interface RawInstruction { type: string; entries?: RawEntry[]; moduleEntryId?: string; moduleItems?: unknown[]; entry?: RawEntry }
interface ConversationAnswer { data: { threaded_conversation_with_injections_v2: { instructions: RawInstruction[] } } }

function raw(id: string, parent: string | null = null, author = "7", extra: Record<string, unknown> = {}): RawResult {
  return { __typename: "Tweet", rest_id: id, core: { user_results: { result: { rest_id: author, core: { screen_name: "author" } } } },
    legacy: { id_str: id, full_text: `post ${id}`, in_reply_to_status_id_str: parent, ...extra } };
}
const item = (t: RawResult): RawItem => ({ itemContent: { itemType: "TimelineTweet", tweet_results: { result: t } } });
function response(tweets: RawResult[]): ConversationAnswer {
  return { data: { threaded_conversation_with_injections_v2: { instructions: [
    { type: "TimelineAddEntries", entries: tweets.map(t => ({ content: item(t) })) },
  ] } } };
}
/** The entries of the answer's first instruction, where `response` puts the posts. */
function entries(answer: ConversationAnswer): RawEntry[] {
  const added = answer.data.threaded_conversation_with_injections_v2.instructions[0]?.entries;
  if (!added) throw new Error("the answer has no entries to add to");
  return added;
}
const select = (tweets: RawResult[], target = "10") => api.select(api.page(response(tweets)).posts, target);

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
    entries(d).push({ content: { __typename: "TimelineTimelineCursor", cursorType: "Bottom", value: "infinite-comments" } });
    expect(api.continuations([api.page(d)], "10").cursors).toEqual([]);
  });
  it("loads only the selected author module and preserves ownership on append", () => {
    const cursor = (value: string) => ({ item: { itemContent: { __typename: "TimelineTimelineCursor", cursorType: "ShowMore", value } } });
    const d = response([raw("10")]);
    entries(d).push(
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
    entries(d).push({ content: { __typename: "TimelineTimelineCursor", cursorType: "Top", value: "ancestors" } });
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
    const post = item(raw("10"));
    const d = response([]);
    entries(d).push({ content: post }, { content: item({ __typename: "TweetTombstone" }) });
    expect(api.page(d).unavailable).toBe(true);
    post.itemContent.promotedMetadata = {};
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
    expect(result.posts[1]?.media).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });
  it("does not mistake a poster or blob for a saved video", () => {
    expect(select([raw("10", null, "7", { extended_entities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg" }] } })]).issues).not.toHaveLength(0);
  });
  it("keeps a quote inside its parent, uses note text and safe thread separators", () => {
    const t = { ...raw("10"), note_tweet: { note_tweet_results: { result: { text: "full long text" } } }, quoted_status_result: { result: raw("8", null, "9") } };
    const result = select([t, raw("11", "10")]);
    expect(api.compose(result.posts)).toBe("full long text\n\n> [@author](https://x.com/author/status/8)\n> \n> post 8\n\n***\n\npost 11");
  });
});

// SPEC_CLIPPER.md, «Пост с цитатой как в оригинале» (09.10.2026).
describe("X post with a quote, as in the original", () => {
  const photo = (name: string) => ({ type: "photo", url: `https://t.co/${name}`, media_url_https: `https://pbs.twimg.com/media/${name}.jpg` });
  const video = (name: string) => ({ type: "video", url: `https://t.co/${name}`, media_url_https: `https://pbs.twimg.com/amplify_video_thumb/${name}.jpg`,
    video_info: { variants: [{ content_type: "video/mp4", bitrate: 20, url: `https://video.twimg.com/amplify_video/${name}/vid/avc1/720x1280/${name}.mp4` }] } });
  function quoted(id: string, user: { handle: string; name: string }, text: string, media: object[]) {
    return { __typename: "Tweet", rest_id: id,
      core: { user_results: { result: { rest_id: "99", core: { screen_name: user.handle, name: user.name } } } },
      legacy: { id_str: id, full_text: `${text} ${media.map(m => (m as { url: string }).url).join(" ")}`.trim(), extended_entities: { media } } };
  }
  const alexis = { handle: "alexisohanian", name: "Alexis Ohanian 🗽" };

  it("keeps the post text and its photos on top, then one quote block with author, text and video", () => {
    const quote = quoted("2108000000000000001", alexis, "Quote text", [video("q1")]);
    const main = raw("2108558741528355242", null, "7", {
      full_text: "Main text https://t.co/one https://t.co/two https://t.co/link",
      entities: { urls: [{ url: "https://t.co/link", expanded_url: "https://twitter.com/alexisohanian/status/2108000000000000001" }] },
      extended_entities: { media: [photo("one"), photo("two")] },
    });
    const result = select([{ ...main, quoted_status_result: { result: quote } }], "2108558741528355242");

    expect(result.posts.map(p => p.id)).toEqual(["2108558741528355242"]);
    expect(api.compose(result.posts)).toBe([
      "Main text",
      "![](https://pbs.twimg.com/media/one.jpg)",
      "![](https://pbs.twimg.com/media/two.jpg)",
      [
        "> **Alexis Ohanian 🗽** [@alexisohanian](https://x.com/alexisohanian/status/2108000000000000001)",
        "> ",
        "> Quote text",
        "> ",
        "> ![](https://video.twimg.com/amplify_video/q1/vid/avc1/720x1280/q1.mp4)",
      ].join("\n"),
    ].join("\n\n"));
  });

  it("keeps a quote inside its own thread part and never makes it a part", () => {
    const quote = quoted("8", { handle: "quoted", name: "Quoted" }, "post 8", [photo("q")]);
    const result = select([raw("10"), { ...raw("11", "10"), quoted_status_result: { result: quote } }, raw("12", "11"), quote]);

    expect(result.posts.map(p => p.id)).toEqual(["10", "11", "12"]);
    expect(api.compose(result.posts)).toBe([
      "post 10",
      "***",
      "post 11\n\n> **Quoted** [@quoted](https://x.com/quoted/status/8)\n> \n> post 8\n> \n> ![](https://pbs.twimg.com/media/q.jpg)",
      "***",
      "post 12",
    ].join("\n\n"));
  });

  it("escapes Markdown in the author name and links the post when the handle is unknown", () => {
    expect(api.compose([{ id: "1", text: "post", media: [],
      quote: { id: "2", handle: "_bob_", name: "Bob *Star* [x]", text: "quoted", media: [] } }]))
      .toBe("post\n\n> **Bob \\*Star\\* \\[x\\]** [@\\_bob\\_](https://x.com/_bob_/status/2)\n> \n> quoted");
    expect(api.compose([{ id: "1", text: "post", media: [], quote: { id: "2", text: "quoted", media: [] } }]))
      .toBe("post\n\n> [x.com/i/status/2](https://x.com/i/status/2)\n> \n> quoted");
  });
});

// SPEC_CLIPPER.md, «Кнопка Mine в ленте X», rule 6.
describe("posts of an X feed response", () => {
  it("reads every post of a list page in the post shape of a thread, the reposted post under its own ID", () => {
    const posts = api.feed(listResponse());
    expect(posts.map(p => p.id)).toEqual([QUOTE_POST_ID, VIDEO_POST_ID, REPOSTED_ID]);
    expect(posts[0]).toMatchObject({ handle: "artignatev", name: "Art Ignatev", mediaComplete: true,
      quote: { id: QUOTED_ID, handle: "alexisohanian", hasVideo: true } });
    expect(api.compose(posts.slice(0, 1))).toBe([
      "Main text",
      "![](https://pbs.twimg.com/media/one.jpg)",
      "![](https://pbs.twimg.com/media/two.jpg)",
      `> **Alexis Ohanian** [@alexisohanian](https://x.com/alexisohanian/status/${QUOTED_ID})\n> \n> Quote text\n> \n> ![](${QUOTED_VIDEO})`,
    ].join("\n\n"));
    expect(posts[1]).toMatchObject({ handle: "GasprArt", hasVideo: true, mediaComplete: true, media: [{ kind: "video", url: POST_VIDEO }] });
    expect(posts[2]).toMatchObject({ handle: "michaelmicasso", text: "post 2099105293938708797" });
    expect(posts.some(p => p.id === REPOST_ID)).toBe(false);
  });
  it("reads a pinned post and posts inside modules of a profile page", () => {
    expect(api.feed(userTweetsResponse()).map(p => p.id)).toEqual([VIDEO_POST_ID, QUOTE_POST_ID]);
  });
  it("keeps a promoted post a feed shows: its Mine button saves it", () => {
    const d = listResponse([quotePost()]);
    const added = d.data.list.tweets_timeline.timeline.instructions[1];
    const first = added?.entries?.[0]?.content;
    if (!first || !("itemContent" in first)) throw new Error("the list has no post entry");
    Object.assign(first.itemContent, { promotedMetadata: { advertiser_results: {} } });
    expect(api.feed(d).map(p => p.id)).toEqual([QUOTE_POST_ID]);
  });
  it("gives no posts for a response it cannot read, without an error", () => {
    expect(api.feed({})).toEqual([]);
    expect(api.feed({ data: { list: { name: "List" } } })).toEqual([]);
    expect(api.feed({ data: { list: { tweets_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [
      { content: { itemContent: { itemType: "TimelineTweet", tweet_results: { result: { __typename: "TweetTombstone" } } } } },
    ] }] } } } } })).toEqual([]);
  });
});

describe("the address of an X post (Е3.15)", () => {
  it("names the post of X, X Pro and Twitter, photo pages included", () => {
    expect(api.postAddress("https://x.com/artist/status/123")).toEqual({ handle: "artist", id: "123" });
    expect(api.postAddress("https://pro.x.com/artist/status/123?s=20")).toEqual({ handle: "artist", id: "123" });
    expect(api.postAddress("https://twitter.com/artist/status/123/photo/2")).toEqual({ handle: "artist", id: "123" });
    expect(api.postAddress("https://www.x.com/i/status/123")).toEqual({ handle: "i", id: "123" });
  });

  it("names no post on a host that merely ends in x.com, or outside a status path", () => {
    expect(api.postAddress("https://www.dropbox.com/team/status/123")).toBeNull();
    expect(api.postAddress("https://netflix.com/user/status/123")).toBeNull();
    expect(api.postAddress("https://example.com/?u=https://x.com/a/status/1")).toBeNull();
    expect(api.postAddress("https://x.com/artist")).toBeNull();
    expect(api.postAddress("not an address")).toBeNull();
    expect(api.isXPage("https://pro.x.com/i/decks/1")).toBe(true);
    expect(api.isXPage("https://box.com/x.com/")).toBe(false);
  });
});

// Answers of X itself, written down 13.10.2026 (xPost.live.test.json):
// GraphQL TweetResultByRestId and the syndication service for the same posts.
describe("the text of an X post as X answers it (Е3.6)", () => {
  const live = JSON.parse(readFileSync("extension/lib/xPost.live.test.json", "utf8")) as {
    graphql: Record<string, { data: { tweetResult: { result: unknown } } }>;
    syndication: Record<string, { text: string; display_text_range: [number, number] }>;
  };
  const graphql = (id: string) => live.graphql[id]!.data.tweetResult.result;
  const REPLY_TEXT = "To clarify, this is a legacy integration. We've reached out to explore new integrations including live-streaming. Stay tuned!";

  it("decodes what X escapes in legacy text and keeps the text of a long post as written", () => {
    expect(api.post(graphql("1778833124643983615"))?.text).toBe("To an exciting & inspiring future!");
    // The legacy text of this long post says `&amp;`; its note text says `&`.
    const note = api.post(graphql("1985444208627392799"))?.text ?? "";
    expect(note).toContain("Python & TypeScript");
    expect(note).not.toContain("&amp;");
  });

  it("leaves out the mentions a reply starts with, the part X does not show", () => {
    expect(api.post(graphql("1724511614206898410"))?.text).toBe(REPLY_TEXT);
    expect(api.post(graphql("1959996732173058433"))?.text).toBe(
      "Hi there! Let’s fix this. We provide Emergency/Weather bots elevated access for free. Please DM us or @chrisparkX directly.");
  });

  it("reads the text a syndication answer shows by the same rules", () => {
    expect(api.syndicationText(live.syndication["1724511614206898410"])).toBe(REPLY_TEXT);
    expect(api.syndicationText(live.syndication["1778833124643983615"])).toBe("To an exciting & inspiring future!");
    expect(api.syndicationText(live.syndication["1985444208627392799"])).toContain("Python & TypeScript");
  });
});
