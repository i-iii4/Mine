/// Which URL a photo card should carry.
///
/// A saved photo used to point at the image file itself (`pbs.twimg.com/…`,
/// `cdn.bsky.app/…`). A file URL cannot lead back to the publication, which is
/// the one thing the card's link is for. The post URL is recovered from two
/// places, in order of trust:
///
/// 1. the DOM around the clicked image — the post's own permalink;
/// 2. the page URL, when the page itself is a post (X rewrites the location to
///    `/status/<id>/photo/1` inside its lightbox);
/// 3. only then the image file URL, as before.

const X_STATUS = /(?:^|\/\/)(?:www\.)?(?:twitter\.com|x\.com)\/([\w]+)\/status\/(\d+)/i;
const BSKY_POST = /(?:^|\/\/)(?:[\w.-]*\.)?bsky\.app(\/profile\/[^/?#]+\/post\/[\w]+)/i;

/// Normalized post URL when `url` addresses a publication, else null.
/// X photo/video suffixes and query strings are stripped: the post is the
/// stable address, `/photo/1?s=20` is a view of it.
export function normalizedPostUrl(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  const x = value.match(X_STATUS);
  if (x) return `https://x.com/${x[1]}/status/${x[2]}`;
  const bsky = value.match(BSKY_POST);
  if (bsky) return `https://bsky.app${bsky[1]}`;
  return null;
}

export function pickImageCardUrl(input: {
  /// Post permalink found next to the image in the DOM, if any.
  domPostUrl?: string | null;
  /// The page the save happened on.
  pageUrl?: string | null;
  /// The image file itself.
  srcUrl?: string | null;
}): string {
  const fromDom = normalizedPostUrl(input.domPostUrl);
  if (fromDom) return fromDom;
  const fromPage = normalizedPostUrl(input.pageUrl);
  if (fromPage) return fromPage;
  const src = (input.srcUrl ?? "").trim();
  return /^https?:\/\//i.test(src) ? src : "";
}
