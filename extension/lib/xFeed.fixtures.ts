// Feed responses and feed markup of X in the shape observed on live pages on
// 10.10.2026 (SPEC_CLIPPER.md, «Кнопка Mine в ленте X»). No live sample of a
// response was captured: the posts are the existing test posts of the X
// thread and quote tests, placed in the ordinary timeline envelope of
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

function userName(user: RawUser, base: string) {
  return `<div data-testid="User-Name"><div><a href="${base}/${user.handle}" role="link"><span>${user.name}</span></a></div>`
    + `<div><a href="${base}/${user.handle}" role="link"><span>@${user.handle}</span></a></div></div>`;
}

interface CardOptions {
  /** `""` for x.com's relative links, `https://x.com` for X Pro's absolute ones. */
  base?: string;
  text?: string;
  social?: string;
  quote?: { user: RawUser; id: string; text: string };
}

/** One feed cell with its post card, as X renders it. */
export function card(user: RawUser, id: string, options: CardOptions = {}) {
  const base = options.base ?? "";
  const statusPath = `${base}/${user.handle}/status/${id}`;
  const social = options.social ? `<span data-testid="socialContext">${options.social} reposted</span>` : "";
  const quote = options.quote
    ? `<div role="link" tabindex="0">${userName(options.quote.user, base)}<time datetime="2026-10-09T10:00:00.000Z">Oct 9</time>`
      + `<div data-testid="tweetText"><span>${options.quote.text}</span></div></div>`
    : "";
  return `<div data-testid="cellInnerDiv"><div><article aria-labelledby="id__card" role="article" tabindex="0" data-testid="tweet">`
    + `<div>${social}${userName(user, base)}<a href="${statusPath}" role="link"><time datetime="2026-10-10T10:00:00.000Z">1h</time></a></div>`
    + `<div data-testid="tweetText"><span>${options.text ?? `post ${id}`}</span></div>${quote}${actions(statusPath)}`
    + `</article></div></div>`;
}

/** The syndication answer for a post, in the shape the clipper already reads. */
export function syndication(id: string, user: RawUser, text: string) {
  return { __typename: "Tweet", id_str: id, text, user: { screen_name: user.handle, name: user.name },
    mediaDetails: [{ type: "photo", url: "https://t.co/p", media_url_https: "https://pbs.twimg.com/media/fallback.jpg" }] };
}
