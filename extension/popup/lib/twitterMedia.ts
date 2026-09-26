import "../../lib/xThread.js";
import type { XPostContent, XPostMedia } from "../../lib/xThread";
import type { ArticleData, EmbeddedVideoPreview } from "./messaging";

export interface TwitterMediaResponse {
  ok: boolean;
  media?: { kind: string; src: string; poster?: string | null; media_type?: string }[];
}

interface Resolver {
  publicMedia(tweetId: string): Promise<TwitterMediaResponse>;
  authenticatedMedia(tweetId: string): Promise<TwitterMediaResponse | undefined>;
  frame(src: string): Promise<string | null>;
}

/** X rendition URLs share an asset identity even when quality/query differs. */
export function twitterMediaKey(src: string): string {
  try {
    const url = new URL(src);
    if (url.hostname === "video.twimg.com") {
      const asset = url.pathname.match(/^\/(amplify_video|ext_tw_video)\/(\d+)\//)
        ?? url.pathname.match(/^\/(tweet_video)\/([^/.]+)\./);
      if (asset) return `${asset[1]}/${asset[2]}`;
    }
    return url.origin + url.pathname;
  } catch {
    return src;
  }
}

/** Preserve known photos and unavailable assets; replace video slots in source order. */
function mergeVideos(known: XPostMedia[], resolved: XPostMedia[]): XPostMedia[] {
  const byId = new Map<string, XPostMedia>();
  const knownVideos = known.filter(m => m.kind === "video");
  const resolvedIds = new Set(resolved.map(m => twitterMediaKey(m.url)));
  const coversKnown = knownVideos.every(m => resolvedIds.has(twitterMediaKey(m.url)));
  const ordered = coversKnown ? [...resolved, ...knownVideos] : [
    ...knownVideos.map(m => resolved.find(r => twitterMediaKey(r.url) === twitterMediaKey(m.url)) ?? m),
    ...resolved,
  ];
  for (const media of ordered) {
    const key = twitterMediaKey(media.url);
    if (!byId.has(key)) byId.set(key, media);
  }
  const videos = [...byId.values()];
  let next = 0;
  const lastVideo = known.reduce((last, m, index) => m.kind === "video" ? index : last, -1);
  const result: XPostMedia[] = [];
  known.forEach((media, index) => {
    if (media.kind === "image") result.push(media);
    else if (videos[next]) result.push(videos[next++]!);
    if (index === lastVideo) result.push(...videos.slice(next));
  });
  if (lastVideo < 0) result.push(...videos);
  return result;
}

/** Resolve each post independently, then compose preview and save from the same posts. */
export async function hydrateTwitterPosts(article: ArticleData, resolver: Resolver): Promise<ArticleData> {
  if (!article.twitterPosts) return article;
  const responses = new Map<string, Promise<XPostMedia[]>>();
  async function resolve(post: XPostContent): Promise<XPostMedia[]> {
    let response: TwitterMediaResponse = await resolver.publicMedia(post.id).catch(() => ({ ok: false }));
    let videos = response.ok ? response.media?.filter(m => m.kind === "video" && m.src) ?? [] : [];
    // A partial DOM/GraphQL result is evidence of video, not of completeness.
    if (videos.length === 0) {
      response = await resolver.authenticatedMedia(post.id).catch(() => undefined) ?? { ok: false };
      videos = response.ok ? response.media?.filter(m => m.kind === "video" && m.src) ?? [] : [];
    }
    return videos.map(m => ({ kind: "video", url: m.src, poster: m.poster ?? null }));
  }
  async function hydrate(post: XPostContent): Promise<XPostContent> {
    let media = post.media;
    if (post.hasVideo || media.some(m => m.kind === "video")) {
      // Complete extended_entities already supplies every attachment. Only
      // partial/DOM captures need another request and an authenticated retry.
      if (!post.mediaComplete) {
        let pending = responses.get(post.id);
        if (!pending) { pending = resolve(post); responses.set(post.id, pending); }
        media = mergeVideos(media, await pending);
      }
      media = await Promise.all(media.map(async m => m.kind === "video" && !m.poster
        ? { ...m, poster: await resolver.frame(m.url) } : m));
    }
    return { ...post, media, quote: post.quote ? await hydrate(post.quote) : post.quote };
  }
  // Bound network work; X threads can contain many posts and subprocess retries.
  const posts: XPostContent[] = [];
  for (const post of article.twitterPosts) posts.push(await hydrate(post));
  const embeddedVideos: EmbeddedVideoPreview[] = [];
  function previews(post: XPostContent) {
    for (const media of post.media) if (media.kind === "video") {
      embeddedVideos.push({ src: media.url, poster: media.poster, title: "Tweet video preview" });
    }
    if (post.quote) previews(post.quote);
  }
  posts.forEach(previews);
  return { ...article, twitterPosts: posts, content: globalThis.MineXThread.compose(posts), embeddedVideos };
}
