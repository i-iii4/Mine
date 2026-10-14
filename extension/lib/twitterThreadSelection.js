(function (root) {
  "use strict";

  /** @typedef {import("./twitterThreadSelection.types").TweetIdentity} TweetIdentity */
  /** @typedef {import("./twitterThreadSelection.types").TwitterThreadSelectionInput} TwitterThreadSelectionInput */
  /**
   * @typedef {object} ThreadCandidate
   * @property {Element} article
   * @property {Element} cell
   * @property {string | null} tweetId
   * @property {string | null} authorHandle
   */

  const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
  const CELL_SELECTOR = '[data-testid="cellInnerDiv"]';

  /** @param {string | null | undefined} handle */
  function normalizeHandle(handle) {
    return String(handle || "").replace(/^@/, "").trim().toLowerCase();
  }

  /**
   * @param {string | null | undefined} href
   * @param {string | undefined} baseURI
   * @returns {TweetIdentity | null}
   */
  function statusIdentityFromHref(href, baseURI) {
    if (!href) return null;
    try {
      const url = new URL(href, baseURI || "https://x.com/");
      const match = url.pathname.match(/^\/([^/?#]+)\/status\/(\d+)/i);
      if (!match) return null;
      return {
        handle: normalizeHandle(match[1]),
        // Both groups of the pattern are required, so a match has them.
        tweetId: /** @type {string} */ (match[2]),
        href: url.href,
      };
    } catch {
      return null;
    }
  }

  /**
   * @param {string | null} href
   * @param {string | undefined} baseURI
   */
  function profileHandleFromHref(href, baseURI) {
    if (!href) return null;
    try {
      const url = new URL(href, baseURI || "https://x.com/");
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) return null;
      const handle = normalizeHandle(segments[0]);
      if (!handle || handle === "i" || handle === "home" || handle === "search") {
        return null;
      }
      return handle;
    } catch {
      return null;
    }
  }

  /** @param {Element} article */
  function getTweetAuthorHandle(article) {
    const baseURI = article.ownerDocument?.baseURI;
    for (const link of article.querySelectorAll('div[data-testid="User-Name"] a[href]')) {
      const handle = profileHandleFromHref(link.getAttribute("href"), baseURI);
      if (handle) return handle;
    }
    return null;
  }

  /**
   * @param {Element} article
   * @returns {TweetIdentity | null}
   */
  function getTweetIdentity(article) {
    const baseURI = article.ownerDocument?.baseURI;
    const authorHandle = getTweetAuthorHandle(article);

    for (const time of article.querySelectorAll("time")) {
      const link = time.closest("a[href]");
      const identity = statusIdentityFromHref(link?.getAttribute("href"), baseURI);
      if (identity && (!authorHandle || identity.handle === authorHandle)) {
        return identity;
      }
    }

    let firstIdentity = null;
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const identity = statusIdentityFromHref(link.getAttribute("href"), baseURI);
      if (!identity) continue;
      if (!firstIdentity) firstIdentity = identity;
      if (!authorHandle || identity.handle === authorHandle) {
        return identity;
      }
    }

    return firstIdentity;
  }

  /** @param {Element} article */
  function getTimelineCell(article) {
    return article.closest(CELL_SELECTOR) || article;
  }

  /** @param {Element} anchorCell */
  function getSiblingTimelineCells(anchorCell) {
    const doc = anchorCell.ownerDocument;
    const parent = anchorCell.parentElement;
    if (parent) {
      const siblingCells = Array.from(parent.children).filter(
        (child) => child.matches?.(CELL_SELECTOR) || child.querySelector?.(TWEET_ARTICLE_SELECTOR),
      );
      if (siblingCells.includes(anchorCell)) return siblingCells;
    }

    const allCells = Array.from(doc.querySelectorAll(CELL_SELECTOR));
    if (allCells.includes(anchorCell)) return allCells;
    return Array.from(doc.querySelectorAll(TWEET_ARTICLE_SELECTOR));
  }

  /**
   * @param {Element} cell
   * @returns {Element | null}
   */
  function getPrimaryTweetArticle(cell) {
    if (cell.matches?.(TWEET_ARTICLE_SELECTOR)) return cell;
    const articles = Array.from(cell.querySelectorAll(TWEET_ARTICLE_SELECTOR));
    return articles[0] || null;
  }

  /**
   * @param {Element} article
   * @returns {ThreadCandidate}
   */
  function makeCandidate(article) {
    const identity = getTweetIdentity(article);
    const authorHandle = getTweetAuthorHandle(article) || identity?.handle || null;
    return {
      article,
      cell: getTimelineCell(article),
      tweetId: identity?.tweetId || null,
      authorHandle,
    };
  }

  /**
   * @param {Element | undefined} cell
   * @returns {ThreadCandidate | null}
   */
  function candidateFromCell(cell) {
    if (!cell) return null;
    const article = getPrimaryTweetArticle(cell);
    return article ? makeCandidate(article) : null;
  }

  /**
   * @param {ThreadCandidate | null} candidate
   * @param {string | null} targetHandle
   */
  function isSameAuthor(candidate, targetHandle) {
    return normalizeHandle(candidate?.authorHandle) === normalizeHandle(targetHandle);
  }

  /**
   * @param {TwitterThreadSelectionInput} input
   * @returns {Element[]}
   */
  function selectTwitterThreadArticles({ document: doc, targetTweetId, authorHandle }) {
    const targetAuthor = normalizeHandle(authorHandle);
    const articles = Array.from(doc.querySelectorAll(TWEET_ARTICLE_SELECTOR));
    if (articles.length === 0) return [];

    const candidates = articles.map(makeCandidate);
    const target =
      candidates.find((candidate) => candidate.tweetId === String(targetTweetId || "")) ||
      candidates.find((candidate) => isSameAuthor(candidate, targetAuthor));
    if (!target || !target.article) return [];

    if (target.tweetId !== String(targetTweetId || "")) {
      return [target.article];
    }

    const cells = getSiblingTimelineCells(target.cell);
    const targetIndex = cells.indexOf(target.cell);
    if (targetIndex < 0) return [target.article];

    const selected = new Set([target.cell]);
    const effectiveAuthor = target.authorHandle || targetAuthor;

    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const candidate = candidateFromCell(cells[index]);
      if (!candidate || !candidate.tweetId || !isSameAuthor(candidate, effectiveAuthor)) {
        break;
      }
      selected.add(candidate.cell);
    }

    for (let index = targetIndex + 1; index < cells.length; index += 1) {
      const candidate = candidateFromCell(cells[index]);
      if (!candidate || !candidate.tweetId || !isSameAuthor(candidate, effectiveAuthor)) {
        break;
      }
      selected.add(candidate.cell);
    }

    return cells
      .filter((cell) => selected.has(cell))
      .map(getPrimaryTweetArticle)
      .filter(/** @returns {article is Element} */ (article) => article !== null);
  }

  root.MineTwitterThreadSelection = {
    getTweetIdentity,
    selectTwitterThreadArticles,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
