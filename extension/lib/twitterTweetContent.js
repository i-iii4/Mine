(function (root) {
  "use strict";

  /** @typedef {import("./twitterThreadSelection.types").TweetIdentity} TweetIdentity */
  /** @typedef {import("./twitterTweetContent.types").TweetQuoteGroup} TweetQuoteGroup */
  /** @typedef {import("./twitterTweetContent.types").TweetContentParts} TweetContentParts */
  /** @typedef {import("./twitterTweetContent.types").TweetQuoteText} TweetQuoteText */

  const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
  const TWEET_TEXT_SELECTOR = 'div[data-testid="tweetText"]';
  const TWEET_PHOTO_SELECTOR = 'div[data-testid="tweetPhoto"] img';

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
      // Both groups of the pattern are required, so a match has them.
      const [, handle, tweetId] = /** @type {[string, string, string]} */ (match);
      return {
        handle: handle.replace(/^@/, "").trim().toLowerCase(),
        tweetId,
        href: url.href,
      };
    } catch {
      return null;
    }
  }

  /**
   * @param {Element} article
   * @returns {TweetIdentity | null}
   */
  function getTweetIdentity(article) {
    const fromSharedSelector = root.MineTwitterThreadSelection?.getTweetIdentity?.(article);
    if (fromSharedSelector?.tweetId) return fromSharedSelector;

    const baseURI = article.ownerDocument?.baseURI;
    for (const time of article.querySelectorAll("time")) {
      const identity = statusIdentityFromHref(time.closest("a[href]")?.getAttribute("href"), baseURI);
      if (identity) return identity;
    }
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const identity = statusIdentityFromHref(link.getAttribute("href"), baseURI);
      if (identity) return identity;
    }
    return null;
  }

  /** @param {Element} element */
  function closestAncestorTweetArticle(element) {
    let parent = element?.parentElement || null;
    while (parent) {
      if (parent.matches?.(TWEET_ARTICLE_SELECTOR)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  /**
   * @param {Element} element
   * @param {string | undefined} baseURI
   */
  function elementStatusIdentity(element, baseURI) {
    if (element.matches?.('a[href*="/status/"]')) {
      const identity = statusIdentityFromHref(element.getAttribute("href"), baseURI);
      if (identity) return identity;
    }
    for (const link of element.querySelectorAll?.('a[href*="/status/"]') || []) {
      const identity = statusIdentityFromHref(link.getAttribute("href"), baseURI);
      if (identity) return identity;
    }
    return null;
  }

  /**
   * @param {Element} rootArticle
   * @param {Element} element
   * @param {TweetIdentity | null} rootIdentity
   * @returns {Element | null}
   */
  function quoteContainerForElement(rootArticle, element, rootIdentity) {
    const nestedTweet = closestAncestorTweetArticle(element);
    if (nestedTweet && nestedTweet !== rootArticle && rootArticle.contains(nestedTweet)) {
      return nestedTweet;
    }

    const baseURI = rootArticle.ownerDocument?.baseURI;
    let current = element?.parentElement || null;
    while (current && current !== rootArticle) {
      const isClickableQuoteShell = current.matches?.('a[href*="/status/"], [role="link"]');
      if (isClickableQuoteShell) {
        const identity = elementStatusIdentity(current, baseURI);
        if (identity?.tweetId && identity.tweetId !== rootIdentity?.tweetId) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * @param {Element} rootArticle
   * @param {TweetIdentity | null} rootIdentity
   */
  function firstTopLevelTweetText(rootArticle, rootIdentity) {
    for (const textEl of rootArticle.querySelectorAll(TWEET_TEXT_SELECTOR)) {
      if (!quoteContainerForElement(rootArticle, textEl, rootIdentity)) return textEl;
    }
    return null;
  }

  /**
   * @param {Node} node
   * @returns {node is Element}
   */
  function isElement(node) {
    return node.nodeType === Node.ELEMENT_NODE;
  }

  /**
   * @param {Node} el
   * @returns {string}
   */
  function tweetTextToMarkdown(el) {
    let result = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeName === "BR") {
        result += "\n";
      } else if (node.nodeName === "A" && isElement(node)) {
        const href = node.getAttribute("href") || "";
        const text = node.textContent || "";
        if (href.startsWith("/hashtag/") || href.startsWith("/")) {
          result += text;
        } else {
          result += `[${text}](${href})`;
        }
      } else if (node.nodeName === "IMG" && isElement(node)) {
        result += node.getAttribute("alt") || "";
      } else if (node.childNodes.length > 0) {
        result += tweetTextToMarkdown(node);
      } else {
        result += node.textContent || "";
      }
    }
    return result;
  }

  /** @param {string | null | undefined} src */
  function normalizeTweetImageSrc(src) {
    if (!src || !src.includes("pbs.twimg.com/media")) return null;
    const base = src.split("?")[0];
    return base + "?format=jpg&name=large";
  }

  /**
   * @param {string[]} list
   * @param {string} value
   */
  function pushUnique(list, value) {
    if (!value || list.includes(value)) return;
    list.push(value);
  }

  /**
   * @param {Element} rootArticle
   * @param {Element} container
   * @param {TweetIdentity | null} rootIdentity
   */
  function quoteIdentityForContainer(rootArticle, container, rootIdentity) {
    const baseURI = rootArticle.ownerDocument?.baseURI;
    const identity = container.matches?.(TWEET_ARTICLE_SELECTOR)
      ? getTweetIdentity(container)
      : elementStatusIdentity(container, baseURI);
    if (identity?.tweetId && identity.tweetId !== rootIdentity?.tweetId) return identity;
    return null;
  }

  /**
   * @param {Node} node
   * @returns {string}
   */
  function textWithEmoji(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
      else if (child.nodeName === "IMG" && isElement(child)) out += child.getAttribute("alt") || "";
      else out += textWithEmoji(child);
    }
    return out;
  }

  /// The quoted author as the quote card shows it: display name, then
  /// `@handle`. The permalink only knows the handle, lowercased.
  /**
   * @param {Element} container
   * @param {TweetIdentity | null} identity
   */
  function quoteAuthorFromContainer(container, identity) {
    const userName = container.querySelector?.('[data-testid="User-Name"]');
    const text = userName ? textWithEmoji(userName).replace(/\s+/g, " ") : "";
    const handles = [...text.matchAll(/@(\w{1,15})/g)];
    // The pattern's one group is required, so every match has it.
    const match = handles.find((m) => /** @type {string} */ (m[1]).toLowerCase() === identity?.handle) || handles[0];
    return {
      handle: match?.[1] || identity?.handle || "",
      name: match ? text.slice(0, match.index).replace(/[\s·]+$/, "").trim() : "",
    };
  }

  /**
   * @param {Map<string | Element, TweetQuoteGroup>} groups
   * @param {Array<string | Element>} order
   * @param {string | Element} key
   * @param {TweetIdentity | null} identity
   * @param {Element} container
   * @returns {TweetQuoteGroup}
   */
  function ensureQuoteGroup(groups, order, key, identity, container) {
    let group = groups.get(key);
    if (!group) {
      const author = quoteAuthorFromContainer(container, identity);
      group = {
        tweetId: identity?.tweetId || null,
        handle: author.handle,
        name: author.name,
        text: "",
        media: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    return group;
  }

  /**
   * @param {Element} article
   * @returns {TweetContentParts}
   */
  function extractTweetContentParts(article) {
    const rootIdentity = getTweetIdentity(article);
    const mainTextEl = firstTopLevelTweetText(article, rootIdentity);
    const mainText = mainTextEl ? tweetTextToMarkdown(mainTextEl).trim() : "";
    /** @type {string[]} */
    const media = [];
    let hasVideo = false;
    /** @type {Map<string | Element, TweetQuoteGroup>} */
    const quoteGroups = new Map();
    /** @type {Array<string | Element>} */
    const quoteOrder = [];

    for (const textEl of article.querySelectorAll(TWEET_TEXT_SELECTOR)) {
      if (textEl === mainTextEl) continue;
      const container = quoteContainerForElement(article, textEl, rootIdentity);
      if (!container) continue;
      const identity = quoteIdentityForContainer(article, container, rootIdentity);
      const quote = ensureQuoteGroup(quoteGroups, quoteOrder, identity?.tweetId || container, identity, container);
      const text = tweetTextToMarkdown(textEl).trim();
      if (text) quote.text = quote.text ? `${quote.text}\n\n${text}` : text;
    }

    // The selector ends in `img`, so it matches only image elements.
    const images = /** @type {NodeListOf<HTMLImageElement>} */ (article.querySelectorAll(TWEET_PHOTO_SELECTOR));
    for (const img of images) {
      const src = normalizeTweetImageSrc(img.src || "");
      if (!src) continue;
      const container = quoteContainerForElement(article, img, rootIdentity);
      if (container) {
        const identity = quoteIdentityForContainer(article, container, rootIdentity);
        pushUnique(ensureQuoteGroup(quoteGroups, quoteOrder, identity?.tweetId || container, identity, container).media, src);
      } else {
        pushUnique(media, src);
      }
    }

    for (const video of article.querySelectorAll("video")) {
      const container = quoteContainerForElement(article, video, rootIdentity);
      /** @type {TweetQuoteGroup | null} */
      let quote = null;
      if (container) {
        const identity = quoteIdentityForContainer(article, container, rootIdentity);
        quote = ensureQuoteGroup(quoteGroups, quoteOrder, identity?.tweetId || container, identity, container);
        quote.hasVideo = true;
      } else hasVideo = true;
      const src = video.src || video.querySelector("source")?.src || "";
      if (!src || src.startsWith("blob:") || !src.includes("video.twimg.com/")) continue;
      if (quote) pushUnique(quote.media, src);
      else {
        pushUnique(media, src);
      }
    }

    return {
      mainText,
      media,
      hasVideo,
      quotes: quoteOrder
        .map((container) => quoteGroups.get(container))
        .filter(/** @returns {quote is TweetQuoteGroup} */ (quote) => quote !== undefined),
    };
  }

  /** @param {TweetQuoteText | null | undefined} quote */
  function quoteToMarkdown(quote) {
    const parts = [];
    const text = String(quote?.text || "").trim();
    if (text) parts.push(text);
    for (const src of quote?.media || []) {
      if (src) parts.push(`![](${src})`);
    }
    if (parts.length === 0) return "";
    return parts
      .join("\n\n")
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }

  /**
   * @param {string | null | undefined} mainText
   * @param {readonly TweetQuoteText[] | null | undefined} quotes
   */
  function composeTweetText(mainText, quotes) {
    const parts = [];
    const normalizedMainText = String(mainText || "").trim();
    if (normalizedMainText) parts.push(normalizedMainText);
    for (const quote of quotes || []) {
      const markdown = quoteToMarkdown(quote);
      if (markdown) parts.push(markdown);
    }
    return parts.join("\n\n");
  }

  /** @param {Element} article */
  function extractTweetContent(article) {
    const parts = extractTweetContentParts(article);
    return {
      text: composeTweetText(parts.mainText, parts.quotes),
      media: parts.media,
    };
  }

  root.MineTwitterTweetContent = {
    composeTweetText,
    extractTweetContent,
    extractTweetContentParts,
    normalizeTweetImageSrc,
    quoteToMarkdown,
    tweetTextToMarkdown,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
