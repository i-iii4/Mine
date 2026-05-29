(function (root) {
  "use strict";

  const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
  const TWEET_TEXT_SELECTOR = 'div[data-testid="tweetText"]';
  const TWEET_PHOTO_SELECTOR = 'div[data-testid="tweetPhoto"] img';

  function statusIdentityFromHref(href, baseURI) {
    if (!href) return null;
    try {
      const url = new URL(href, baseURI || "https://x.com/");
      const match = url.pathname.match(/^\/([^/?#]+)\/status\/(\d+)/i);
      if (!match) return null;
      return {
        handle: match[1].replace(/^@/, "").trim().toLowerCase(),
        tweetId: match[2],
        href: url.href,
      };
    } catch {
      return null;
    }
  }

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

  function closestAncestorTweetArticle(element) {
    let parent = element?.parentElement || null;
    while (parent) {
      if (parent.matches?.(TWEET_ARTICLE_SELECTOR)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

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

  function firstTopLevelTweetText(rootArticle, rootIdentity) {
    for (const textEl of rootArticle.querySelectorAll(TWEET_TEXT_SELECTOR)) {
      if (!quoteContainerForElement(rootArticle, textEl, rootIdentity)) return textEl;
    }
    return null;
  }

  function tweetTextToMarkdown(el) {
    let result = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeName === "BR") {
        result += "\n";
      } else if (node.nodeName === "A") {
        const href = node.getAttribute("href") || "";
        const text = node.textContent || "";
        if (href.startsWith("/hashtag/") || href.startsWith("/")) {
          result += text;
        } else {
          result += `[${text}](${href})`;
        }
      } else if (node.nodeName === "IMG") {
        result += node.getAttribute("alt") || "";
      } else if (node.childNodes.length > 0) {
        result += tweetTextToMarkdown(node);
      } else {
        result += node.textContent || "";
      }
    }
    return result;
  }

  function normalizeTweetImageSrc(src) {
    if (!src || !src.includes("pbs.twimg.com/media")) return null;
    const base = src.split("?")[0];
    return base + "?format=jpg&name=large";
  }

  function pushUnique(list, value) {
    if (!value || list.includes(value)) return;
    list.push(value);
  }

  function quoteIdentityForContainer(rootArticle, container, rootIdentity) {
    const baseURI = rootArticle.ownerDocument?.baseURI;
    const identity = container.matches?.(TWEET_ARTICLE_SELECTOR)
      ? getTweetIdentity(container)
      : elementStatusIdentity(container, baseURI);
    if (identity?.tweetId && identity.tweetId !== rootIdentity?.tweetId) return identity;
    return null;
  }

  function ensureQuoteGroup(groups, order, key, identity) {
    if (!groups.has(key)) {
      const group = {
        tweetId: identity?.tweetId || null,
        text: "",
        media: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    return groups.get(key);
  }

  function extractTweetContentParts(article) {
    const rootIdentity = getTweetIdentity(article);
    const mainTextEl = firstTopLevelTweetText(article, rootIdentity);
    const mainText = mainTextEl ? tweetTextToMarkdown(mainTextEl).trim() : "";
    const media = [];
    const quoteGroups = new Map();
    const quoteOrder = [];

    for (const textEl of article.querySelectorAll(TWEET_TEXT_SELECTOR)) {
      if (textEl === mainTextEl) continue;
      const container = quoteContainerForElement(article, textEl, rootIdentity);
      if (!container) continue;
      const identity = quoteIdentityForContainer(article, container, rootIdentity);
      const quote = ensureQuoteGroup(quoteGroups, quoteOrder, identity?.tweetId || container, identity);
      const text = tweetTextToMarkdown(textEl).trim();
      if (text) quote.text = quote.text ? `${quote.text}\n\n${text}` : text;
    }

    for (const img of article.querySelectorAll(TWEET_PHOTO_SELECTOR)) {
      const src = normalizeTweetImageSrc(img.src || "");
      if (!src) continue;
      const container = quoteContainerForElement(article, img, rootIdentity);
      if (container) {
        const identity = quoteIdentityForContainer(article, container, rootIdentity);
        pushUnique(ensureQuoteGroup(quoteGroups, quoteOrder, identity?.tweetId || container, identity).media, src);
      } else {
        pushUnique(media, src);
      }
    }

    for (const video of article.querySelectorAll("video")) {
      const src = video.src || video.querySelector("source")?.src || "";
      if (!src || src.startsWith("blob:") || !src.includes("video.twimg.com/")) continue;
      const container = quoteContainerForElement(article, video, rootIdentity);
      if (container) {
        const identity = quoteIdentityForContainer(article, container, rootIdentity);
        pushUnique(ensureQuoteGroup(quoteGroups, quoteOrder, identity?.tweetId || container, identity).media, src);
      } else {
        pushUnique(media, src);
      }
    }

    return {
      mainText,
      media,
      quotes: quoteOrder.map((container) => quoteGroups.get(container)).filter(Boolean),
    };
  }

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
