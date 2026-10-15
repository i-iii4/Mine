// Feed responses and feed markup of X in the shape observed on live pages on
// 10.10.2026, the post header as measured again on 11.10.2026 (SPEC_CLIPPER.md,
// «Кнопка Mine в ленте X»; «Доработки после живого просмотра», Р1). No live
// sample of a response was captured: the posts are the existing test posts of
// the X thread and quote tests, placed in the ordinary timeline envelope of
// `ListLatestTweetsTimeline`.

interface RawUser { id: string; handle: string; name: string }

export const ARTIGNATEV: RawUser = { id: "7", handle: "artignatev", name: "Art Ignatev" };
export const ALEXIS: RawUser = { id: "99", handle: "alexisohanian", name: "Alexis Ohanian" };
export const GASPR: RawUser = { id: "41", handle: "GasprArt", name: "Gaspr" };
export const MICASSO: RawUser = { id: "70621192", handle: "michaelmicasso", name: "Michael" };
export const LISTER: RawUser = { id: "5", handle: "lister", name: "Lister" };

export const QUOTE_POST_ID = "2108558741528355242";
export const QUOTED_ID = "2108000000000000001";
export const VIDEO_POST_ID = "2103621844733714547";
export const REPOSTED_ID = "2099105293938708797";
export const REPOST_ID = "2108600000000000001";
export const QUOTED_VIDEO = "https://video.twimg.com/amplify_video/q1/vid/avc1/720x1280/q1.mp4";
export const POST_VIDEO = "https://video.twimg.com/amplify_video/2103618771441360896/vid/avc1/1280x720/SRz40Vsis3bFBscQ.mp4?tag=14";

const photo = (name: string) => ({ type: "photo", url: `https://t.co/${name}`, media_url_https: `https://pbs.twimg.com/media/${name}.jpg` });
const video = (name: string, mp4: string) => ({ type: "video", url: `https://t.co/${name}`,
  media_url_https: `https://pbs.twimg.com/amplify_video_thumb/${name}.jpg`,
  video_info: { variants: [{ content_type: "video/mp4", bitrate: 20, url: mp4 }] } });

function tweet(id: string, user: RawUser, text: string, extra: Record<string, unknown> = {}) {
  return {
    __typename: "Tweet", rest_id: id,
    core: { user_results: { result: { __typename: "User", rest_id: user.id, core: { screen_name: user.handle, name: user.name } } } },
    legacy: { id_str: id, full_text: text, in_reply_to_status_id_str: null, ...extra },
  };
}

/** The post with two photos and a quote of a post with a video. */
export function quotePost() {
  const quote = tweet(QUOTED_ID, ALEXIS, "Quote text https://t.co/q1", { extended_entities: { media: [video("q1", QUOTED_VIDEO)] } });
  return {
    ...tweet(QUOTE_POST_ID, ARTIGNATEV, "Main text https://t.co/one https://t.co/two https://t.co/link", {
      entities: { urls: [{ url: "https://t.co/link", expanded_url: `https://twitter.com/alexisohanian/status/${QUOTED_ID}` }] },
      extended_entities: { media: [photo("one"), photo("two")] },
    }),
    quoted_status_result: { result: quote },
  };
}

/** A post with one video, behind X's visibility wrapper. */
export function videoPost() {
  return { __typename: "TweetWithVisibilityResults",
    tweet: tweet(VIDEO_POST_ID, GASPR, "Clip https://t.co/v", { extended_entities: { media: [video("v", POST_VIDEO)] } }) };
}

/** A repost by the list's member: the feed shows the reposted post. */
export function repost() {
  const original = tweet(REPOSTED_ID, MICASSO, "post 2099105293938708797");
  return tweet(REPOST_ID, LISTER, "RT @michaelmicasso: post 2099105293938708797", { retweeted_status_result: { result: original } });
}

const entry = (result: unknown, index = 0, extra: Record<string, unknown> = {}) => ({
  entryId: `tweet-${index}`,
  content: { entryType: "TimelineTimelineItem", __typename: "TimelineTimelineItem",
    itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result }, tweetDisplayType: "Tweet", ...extra } },
});

/** A page of `ListLatestTweetsTimeline`, with its bottom cursor. */
export function listResponse(results: unknown[] = [quotePost(), videoPost(), repost()]) {
  return { data: { list: { tweets_timeline: { timeline: { instructions: [
    { type: "TimelineClearCache" },
    { type: "TimelineAddEntries", entries: [
      ...results.map((result, index) => entry(result, index)),
      { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "next-page", cursorType: "Bottom" } },
    ] },
  ], metadata: { scribeConfig: { page: "list" } } } } } } };
}

/** A profile page of `UserTweets`, its pinned post in `TimelinePinEntry`. */
export function userTweetsResponse() {
  return { data: { user: { result: { __typename: "User", timeline: { timeline: { instructions: [
    { type: "TimelinePinEntry", entry: entry(videoPost()) },
    { type: "TimelineAddEntries", entries: [{ entryId: "profile-conversation-1", content: {
      entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule",
      items: [{ entryId: "m-1", item: { itemContent: { itemType: "TimelineTweet", tweet_results: { result: quotePost() } } } }],
    } }] },
  ] } } } } } };
}

// The feeds of the Bookmarks, Likes, Media and Replies pages. The operation
// names were seen in live requests of X on 14.10.2026: `Bookmarks`, `Likes`
// (its answer under `data.user.result.timeline.timeline`), `UserVideoTimeline`
// (Media) and `UserRepliesTimeline` (Replies). The envelopes are the ones the
// public clients of X's web API read (twitter-openapi `BookmarksResponseData` →
// `bookmark_timeline_v2.timeline`, `UserTweetsResultV1` → `timeline.timeline`,
// `UserTweetsResultV2` → `timeline_v2.timeline`; twikit reads the media grid of
// the older `UserMedia` from `profile-grid-0` on the first page and from
// `moduleItems` on the next). The answers of `UserVideoTimeline` and
// `UserRepliesTimeline` were not captured (Е7.5): their entries here follow
// `UserMedia` and `UserTweetsAndReplies`.

/** A page of `Bookmarks`: posts as plain entries, with its bottom cursor. */
export function bookmarksResponse() {
  return { data: { bookmark_timeline_v2: { timeline: { instructions: [
    { type: "TimelineAddEntries", entries: [
      entry(quotePost(), 0), entry(videoPost(), 1),
      { entryId: "cursor-bottom-1", content: { entryType: "TimelineTimelineCursor", __typename: "TimelineTimelineCursor", value: "next-bookmarks", cursorType: "Bottom" } },
    ] },
  ] } } } };
}

/** A user timeline under `timeline` (`UserTweetsResultV1`) or `timeline_v2` (`UserTweetsResultV2`). */
function userTimeline(instructions: unknown[], key: "timeline" | "timeline_v2") {
  return { data: { user: { result: { __typename: "User", [key]: { timeline: { instructions } } } } } };
}

/** A page of `Likes`: other people's posts, a reposted one among them, as plain entries. */
export function likesResponse(key: "timeline" | "timeline_v2" = "timeline") {
  return userTimeline([
    { type: "TimelineAddEntries", entries: [entry(quotePost(), 0), entry(repost(), 1)] },
  ], key);
}

const gridItem = (result: unknown, index: number) => ({ entryId: `profile-grid-0-tweet-${index}`,
  item: { itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result }, tweetDisplayType: "MediaGrid" } } });

/** The first page of `UserVideoTimeline`: one grid module holds the posts. */
export function userVideoResponse() {
  return userTimeline([
    { type: "TimelineClearCache" },
    { type: "TimelineAddEntries", entries: [{ entryId: "profile-grid-0", content: {
      entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule", displayType: "VerticalGrid",
      items: [gridItem(videoPost(), 0)],
    } }] },
  ], "timeline");
}

/** A later page of `UserVideoTimeline`: the posts are added to the grid module of the first. */
export function userVideoNextResponse() {
  return userTimeline([
    { type: "TimelineAddToModule", moduleEntryId: "profile-grid-0", prepend: false, moduleItems: [gridItem(quotePost(), 1)] },
  ], "timeline");
}

export const REPLY_ID = "2108700000000000001";

/** A page of `UserRepliesTimeline`: a post of its own and a conversation module ending with the user's reply. */
export function userRepliesResponse() {
  const reply = tweet(REPLY_ID, GASPR, "@artignatev reply", { in_reply_to_status_id_str: QUOTE_POST_ID });
  return userTimeline([
    { type: "TimelineAddEntries", entries: [
      entry(videoPost(), 0),
      { entryId: `profile-conversation-${REPLY_ID}`, content: {
        entryType: "TimelineTimelineModule", __typename: "TimelineTimelineModule", displayType: "VerticalConversation",
        items: [quotePost(), reply].map((result, index) => ({ entryId: `profile-conversation-${REPLY_ID}-tweet-${index}`,
          item: { itemContent: { itemType: "TimelineTweet", __typename: "TimelineTweet", tweet_results: { result }, tweetDisplayType: "Tweet" } } })),
      } },
    ] },
  ], "timeline");
}

// ── Feed markup ─────────────────────────────────────────────────────────────

/** The look of X's action controls, as atomic classes and an inline colour. */
export const REST_COLOUR = "rgb(113, 118, 123)";
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs"><g><path d="M12 2.59l5.7 5.7"></path></g></svg>';

function control(testId: string | null, label: string, count = "") {
  const id = testId ? ` data-testid="${testId}"` : "";
  const counter = count ? `<div class="css-175oi2r r-xoduu5 r-1udh08x"><span class="css-1jxf684"><span>${count}</span></span></div>` : "";
  return `<button aria-label="${label}" role="button" class="css-175oi2r r-1777fci r-bt1l66"${id} type="button">`
    + `<div dir="ltr" class="css-146c3p1 r-bcqeeo r-1ttztb7" style="color: ${REST_COLOUR};">`
    + `<div class="css-175oi2r r-xoduu5"><div class="css-175oi2r r-xoduu5 r-1p0dtai r-1niwhzg"></div>${ICON}</div>${counter}</div></button>`;
}

function actions(statusPath: string) {
  return `<div role="group" aria-label="12 replies, 5 reposts, 40 likes" class="css-175oi2r r-1kbdv8c r-18u37iz" id="id__row">`
    + `<div class="css-175oi2r r-18u37iz r-1h0z5md r-13awgt0">${control("reply", "12 Replies. Reply", "12")}</div>`
    + `<div class="css-175oi2r r-18u37iz r-1h0z5md r-13awgt0">${control("retweet", "5 reposts. Repost", "5")}</div>`
    + `<div class="css-175oi2r r-18u37iz r-1h0z5md r-13awgt0">${control("like", "40 Likes. Like", "40")}</div>`
    + `<div class="css-175oi2r r-18u37iz r-1h0z5md r-13awgt0"><a href="${statusPath}/analytics" aria-label="900 views" class="css-175oi2r r-1777fci">`
    + `<div dir="ltr" class="css-146c3p1" style="color: ${REST_COLOUR};"><div class="css-175oi2r r-xoduu5"><div class="css-175oi2r r-1niwhzg"></div>${ICON}</div>`
    + `<div class="css-175oi2r r-xoduu5"><span data-testid="app-text-transition-container"><span>900</span></span></div></div></a></div>`
    + `<div class="css-175oi2r r-18u37iz r-1h0z5md r-1wron08">${control(null, "Share post")}</div>`
    + `</div>`;
}

function userName(user: RawUser, base: string, time = "") {
  return `<div data-testid="User-Name"><div><a href="${base}/${user.handle}" role="link"><span>${user.name}</span></a></div>`
    + `<div><a href="${base}/${user.handle}" role="link"><span>@${user.handle}</span></a>${time}</div></div>`;
}

/** X's header icons: "…", Grok and the stack header's buttons, 19 px. */
const HEADER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" class="r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr"><g><path d="M3 12c0-1.1.9-2 2-2"></path></g></svg>';

/**
 * "…" in a post's header as X renders it on 11.10.2026, with or without Grok
 * beside it: a row, a column without classes, the box of "…" (a row) and the
 * button. The first row of the right block holds this chain, Grok's box
 * before it when the post has Grok.
 */
function caretChain() {
  return `<div class="css-175oi2r r-1awozwy r-6koalj r-18u37iz"><div>`
    + `<div class="css-175oi2r r-18u37iz r-1h0z5md">`
    + `<button aria-expanded="false" aria-haspopup="menu" aria-label="More" role="button" class="css-175oi2r r-1777fci r-bt1l66" data-testid="caret" type="button">`
    + `<div dir="ltr" class="css-146c3p1 r-bcqeeo r-1ttztb7" style="color: ${REST_COLOUR};">`
    + `<div class="css-175oi2r r-xoduu5"><div class="css-175oi2r r-xoduu5 r-1p0dtai r-1niwhzg"></div>${HEADER_ICON}</div></div></button>`
    + `</div></div></div>`;
}

/** The box of the Grok button, a row; its label is in the interface language, `null` draws none. */
function grokBox(label: string | null) {
  const aria = label === null ? "" : ` aria-label="${label}"`;
  return `<div class="css-175oi2r r-18u37iz r-grok-box">`
    + `<button${aria} role="button" class="css-175oi2r r-1777fci r-grok" type="button">`
    + `<div dir="ltr" class="css-146c3p1 r-grok-tint" style="color: ${REST_COLOUR};"><svg viewBox="0 0 33 32" aria-hidden="true" class="r-grok-icon"><g><path d="M12.7 19.4"></path></g></svg></div>`
    + `</button></div>`;
}

/** The Follow button the main post of a post page shows in its header. */
function followBox(user: RawUser) {
  return `<div class="css-175oi2r r-follow"><button aria-label="Follow @${user.handle}" role="button" class="css-175oi2r r-follow-button" data-testid="${user.id}-follow" type="button">`
    + `<div dir="ltr" class="css-146c3p1"><span><span>Follow</span></span></div></button></div>`;
}

interface CardOptions {
  /** `""` for x.com's relative links, `https://x.com` for X Pro's absolute ones and its own header classes. */
  base?: string;
  text?: string;
  social?: string;
  quote?: { user: RawUser; id: string; text: string };
  /** The Grok button and its label: absent from lists and X Pro (`false`); `null` draws it unlabelled. */
  grok?: string | null | false;
  /** The Follow button of a post page's main post. */
  follow?: boolean;
  /** The post X Pro opened: its time is not a link, its photo link names it. */
  opened?: boolean;
  /** An analytics link of the opened post, naming the post it gives. */
  analyticsId?: string;
}

/** One feed cell with its post card, as X renders it. */
export function card(user: RawUser, id: string, options: CardOptions = {}) {
  const base = options.base ?? "";
  const statusPath = `${base}/${user.handle}/status/${id}`;
  const social = options.social ? `<span data-testid="socialContext">${options.social} reposted</span>` : "";
  const quote = options.quote
    ? `<div role="link" tabindex="0">${userName(options.quote.user, base)}<time datetime="2026-10-09T10:00:00.000Z">Oct 9</time>`
      + `<div data-testid="tweetText"><span>${options.quote.text}</span></div>`
      + `<a href="${base}/${options.quote.user.handle}/status/${options.quote.id}/photo/1" role="link"><img alt="" src="https://pbs.twimg.com/media/q.jpg"></a></div>`
    : "";
  const time = options.opened
    ? `<span><time datetime="2026-10-10T10:00:00.000Z">10:00 AM, Oct 10, 2026</time></span>`
    : `<a href="${statusPath}" role="link"><time datetime="2026-10-10T10:00:00.000Z">1h</time></a>`;
  const grok = options.grok === undefined ? (base ? false : "Grok actions") : options.grok;
  const right = (options.follow ? followBox(user) : "") + (grok === false ? "" : grokBox(grok)) + caretChain();
  // The header row: the author block and the right block (a column), whose
  // first row holds Follow, Grok and "…". X Pro builds it the same way with
  // classes of its own (measured on 11.10.2026).
  const [rightBlock, firstRow] = base
    ? ["r-2pydbh", "r-1awozwy r-18u37iz r-1ey881g r-1wtj0ep"]
    : ["r-1kkk96v", "r-1awozwy r-18u37iz r-1cmwbt1 r-1wtj0ep"];
  const header = `<div class="css-175oi2r r-zl2h9q"><div class="css-175oi2r r-k4xj1c r-18u37iz r-1wtj0ep">`
    + `<div class="css-175oi2r r-1d09ksm r-18u37iz r-1wbh5a2"><div class="css-175oi2r r-1wbh5a2 r-dnmrzs">${userName(user, base, time)}</div></div>`
    + `<div class="css-175oi2r ${rightBlock}"><div class="css-175oi2r ${firstRow}">${right}</div></div>`
    + `</div></div>`;
  const openedLinks = options.opened
    ? (options.analyticsId ? `<a href="${base}/${user.handle}/status/${options.analyticsId}/analytics" role="link">Views</a>` : "")
      + `<a href="${statusPath}/photo/1" role="link"><img alt="" src="https://pbs.twimg.com/media/own.jpg"></a>`
    : "";
  return `<div data-testid="cellInnerDiv"><div><article aria-labelledby="id__card" role="article" tabindex="0" data-testid="tweet">`
    + `<div>${social}${header}</div>`
    + `<div data-testid="tweetText"><span>${options.text ?? `post ${id}`}</span></div>${quote}${openedLinks}${actions(statusPath)}`
    + `</article></div></div>`;
}

/** An icon button of the stack header of X Pro, 34 px. */
function stackButton(label: string, extra = "") {
  return `<button aria-label="${label}" role="button" class="css-175oi2r r-34 r-stack-button${extra}" type="button">`
    + `<div dir="ltr" class="css-146c3p1 r-stack-tint" style="color: ${REST_COLOUR};"><div class="css-175oi2r r-xoduu5"><div class="css-175oi2r r-stack-halo"></div>${HEADER_ICON}</div></div></button>`;
}

/** The header of the stack X Pro opens over a column: close, spacer, title, actions. */
export function stackHeader() {
  return `<div data-testid="root" class="css-175oi2r r-18u37iz r-stack-header">`
    + `<div class="css-175oi2r r-close-box">${stackButton("Close stack")}</div>`
    + `<div class="css-175oi2r r-1iusvr4 r-16y2uox"></div>`
    + `<div class="css-175oi2r r-title-box"><h1 role="heading" class="css-146c3p1 r-title">Column: Post</h1></div>`
    + `<div class="css-175oi2r r-actions-box"><div class="css-175oi2r r-18u37iz r-actions-row"><div data-testid="wrapper"></div>${stackButton("Create a separate column", " r-new-column")}</div></div>`
    + `</div>`;
}

/** A column of X Pro with its feed, and the stack of a post opened over it. */
export function column(feed: string[], opened: { main?: string; replies?: string[] } | null = null) {
  const stack = opened
    ? `<div class="css-175oi2r r-stack">${stackHeader()}<div class="css-175oi2r r-stack-timeline">${opened.main ?? ""}${(opened.replies ?? []).join("")}</div></div>`
    : "";
  return `<section role="region" class="css-175oi2r r-column"><div class="css-175oi2r r-column-timeline">${feed.join("")}</div>${stack}</section>`;
}

/** The syndication answer for a post, in the shape the clipper already reads. */
export function syndication(id: string, user: RawUser, text: string) {
  return { __typename: "Tweet", id_str: id, text, user: { screen_name: user.handle, name: user.name },
    mediaDetails: [{ type: "photo", url: "https://t.co/p", media_url_https: "https://pbs.twimg.com/media/fallback.jpg" }] };
}
