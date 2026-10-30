import "../../lib/xThread.js";

/// Which URL a photo card should carry (SPEC_CLIPPER.md, «Ссылка карточки при
/// сохранении фото»).
///
/// A saved photo used to point at the image file itself (`pbs.twimg.com/…`,
/// `cdn.shopify.com/…`). A file URL cannot lead back to the publication or
/// the product, which is the one thing the card's link is for. In order:
///
/// 1. the post permalink found in the DOM around the clicked image;
/// 2. the page URL, when the page itself is a post (X rewrites the location to
///    `/status/<id>/photo/1` inside its lightbox);
/// 3. the page the save happened on, on every site but X and Bluesky: there a
///    profile or the feed root is not the publication and never outranks the
///    file (decision of 29.10.2026);
/// 4. the image file URL, when the page is the image itself or has no
///    http(s) address.

const X_STATUS = /(?:^|\/\/)(?:www\.)?(?:twitter\.com|x\.com)\/([\w]+)\/status\/(\d+)/i;
const BSKY_POST = /(?:^|\/\/)(?:[\w.-]*\.)?bsky\.app(\/profile\/[^/?#]+\/post\/[\w]+)/i;
const BSKY_HOST = /(?:^|\.)bsky\.app$/i;
const WEB_ADDRESS = /^https?:\/\//i;

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

/// Whether `url` is a page of X or Bluesky, where only a post is a
/// publication and the page around a picture may be a profile or a feed.
function isPostOnlySite(url: string): boolean {
  if (globalThis.MineXThread.isXPage(url)) return true;
  try {
    return BSKY_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/// The address `url` names once parsed, so that `…/a.jpg` and `…/a.jpg#x`
/// written differently still compare by what they load; null when it is not
/// an address.
function parsedHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
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
  const page = (input.pageUrl ?? "").trim();
  const src = (input.srcUrl ?? "").trim();
  const file = WEB_ADDRESS.test(src) ? src : "";
  if (WEB_ADDRESS.test(page) && !isPostOnlySite(page)) {
    const pageIsTheFile = file !== "" && parsedHref(page) === parsedHref(file);
    if (!pageIsTheFile) return page;
  }
  return file;
}
