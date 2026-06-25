(function (root) {
  "use strict";

  const TWEET_ARTICLE_SELECTOR = 'article[data-testid="tweet"]';
  const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
  const LONGFORM_READ_SELECTOR = '[data-testid="twitterArticleReadView"]';
  const LONGFORM_RICH_SELECTOR = [
    '[data-testid="twitterArticleRichTextView"]',
    '[data-testid="longformRichTextComponent"]',
  ].join(",");
  const LONGFORM_TITLE_SELECTOR = '[data-testid="twitter-article-title"]';
  const EXCLUDED_SELECTOR = [
    "script",
    "style",
    "noscript",
    "svg",
    "button",
    "input",
    "textarea",
    "select",
    "nav",
    '[role="button"]',
    '[data-testid="User-Name"]',
    '[data-testid="caret"]',
    '[data-testid="reply"]',
    '[data-testid="retweet"]',
    '[data-testid="like"]',
    '[data-testid="bookmark"]',
    '[data-testid="socialContext"]',
    '[data-testid="tweetPhoto"]',
    '[data-testid="videoPlayer"]',
    '[data-testid="card.wrapper"]',
  ].join(",");

  const MIN_BODY_CHARS = 360;
  const MIN_PARAGRAPH_COUNT = 2;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function compactText(value) {
    return normalizeText(value).replace(/\s+/g, " ").trim();
  }

  function plainTextFromMarkdown(value) {
    return compactText(String(value || "")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, ""));
  }

  function parseStatusIdentity(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url, "https://x.com/");
      const match = parsed.pathname.match(/^\/([^/?#]+)\/status\/(\d+)/i);
      if (!match) return null;
      return {
        authorHandle: match[1].replace(/^@/, ""),
        tweetId: match[2],
      };
    } catch {
      return null;
    }
  }

  function isVisibleElement(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const view = element.ownerDocument?.defaultView;
    if (!view?.getComputedStyle) return true;
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function isExcludedElement(element, { excludeTweetText = true } = {}) {
    if (!element || element.nodeType !== 1) return true;
    if (!isVisibleElement(element)) return true;
    if (excludeTweetText && element.closest(TWEET_TEXT_SELECTOR)) return true;
    return Boolean(element.closest(EXCLUDED_SELECTOR));
  }

  function rootTweetArticleFor(surface) {
    return surface.matches?.(TWEET_ARTICLE_SELECTOR)
      ? surface
      : surface.closest?.(TWEET_ARTICLE_SELECTOR) || null;
  }

  function isInsideDifferentTweet(element, rootTweetArticle) {
    const closestTweet = element.closest?.(TWEET_ARTICLE_SELECTOR);
    return Boolean(rootTweetArticle && closestTweet && closestTweet !== rootTweetArticle);
  }

  function markdownFromNode(node, options = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      return compactText(node.nodeValue);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node;
    if (isExcludedElement(element, options) || isInsideDifferentTweet(element, options.rootTweetArticle)) {
      return "";
    }

    const childText = Array.from(element.childNodes)
      .map((child) => markdownFromNode(child, options))
      .filter(Boolean)
      .join(" ");
    const text = compactText(childText);
    if (!text || isChromeText(text)) return "";

    if (element.tagName === "A") {
      const href = element.getAttribute("href");
      if (!href) return text;
      let absoluteHref = href;
      try {
        absoluteHref = new URL(href, element.ownerDocument.baseURI).href;
      } catch {}
      return `[${text}](${absoluteHref})`;
    }

    return text;
  }

  function textFromElement(element, options = {}) {
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const pieces = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || isExcludedElement(parent, options)) continue;
      const closestTweet = parent.closest(TWEET_ARTICLE_SELECTOR);
      if (options.rootTweetArticle && closestTweet && closestTweet !== options.rootTweetArticle) {
        continue;
      }
      const text = compactText(node.nodeValue);
      if (!text || isChromeText(text)) continue;
      pieces.push(text);
    }

    return compactText(pieces.join(" "));
  }

  function isChromeText(text) {
    const value = compactText(text);
    if (!value) return true;
    const lower = value.toLowerCase();
    if (/^@\w{1,30}$/.test(value)) return true;
    if (/^\d+([.,]\d+)?[kmb]?$/i.test(value)) return true;
    if (/^\d+[smhd]$/i.test(value)) return true;
    return [
      "follow",
      "following",
      "subscribe",
      "show more",
      "read more",
      "reply",
      "repost",
      "like",
      "likes",
      "bookmark",
      "share",
      "views",
      "view",
      "translate post",
      "copy link",
    ].includes(lower);
  }

  function collectParagraphTexts(surface, options = {}) {
    const rootTweetArticle = rootTweetArticleFor(surface);
    const textOptions = { ...options, rootTweetArticle };
    const selector = [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "li",
      "blockquote",
      "div[dir]",
      "span[dir]",
      "[data-testid]",
    ].join(",");
    const blocks = Array.from(surface.querySelectorAll(selector));
    const blockSet = new Set(blocks);
    const paragraphs = [];

    for (const block of blocks) {
      if (isExcludedElement(block, textOptions)) continue;
      const closestTweet = block.closest(TWEET_ARTICLE_SELECTOR);
      if (rootTweetArticle && closestTweet && closestTweet !== rootTweetArticle) {
        continue;
      }
      const hasNestedTextBlock = Array.from(block.querySelectorAll(selector)).some((child) => {
        const childTweet = child.closest(TWEET_ARTICLE_SELECTOR);
        return (
          blockSet.has(child) &&
          (!rootTweetArticle || !childTweet || childTweet === rootTweetArticle) &&
          !isExcludedElement(child, textOptions)
        );
      });
      if (hasNestedTextBlock && !/^(P|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE)$/.test(block.tagName)) {
        continue;
      }
      const text = textFromElement(block, textOptions);
      if (text.length < 2) continue;
      if (paragraphs.some((existing) => existing.markdown === text)) continue;
      if (paragraphs.some((existing) => existing.markdown.includes(text) && text.length < 120)) continue;
      if (paragraphs.some((existing) => text.includes(existing.markdown) && existing.markdown.length < 120)) {
        for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
          if (text.includes(paragraphs[index].markdown) && paragraphs[index].markdown.length < 120) {
            paragraphs.splice(index, 1);
          }
        }
      }
      paragraphs.push({ markdown: text, node: block });
    }

    if (paragraphs.length === 0) {
      const text = textFromElement(surface, textOptions);
      if (text) paragraphs.push({ markdown: text, node: surface });
    }

    return paragraphs;
  }

  function collectDraftEditorBlocks(surface, options = {}) {
    const richRoot = surface.querySelector?.(LONGFORM_RICH_SELECTOR);
    if (!richRoot) return [];

    const rootTweetArticle = rootTweetArticleFor(surface);
    const textOptions = { ...options, rootTweetArticle, excludeTweetText: false };
    const blocks = Array.from(richRoot.querySelectorAll('[data-block="true"]'));
    const paragraphs = [];

    for (const block of blocks) {
      if (isExcludedElement(block, textOptions) || isInsideDifferentTweet(block, rootTweetArticle)) {
        continue;
      }
      let markdown = markdownFromNode(block, textOptions);
      if (!markdown || markdown.length < 2) continue;

      const tagName = block.tagName;
      const className = String(block.className || "");
      if (/^H[1-6]$/.test(tagName) || className.includes("longform-header")) {
        markdown = `## ${markdown.replace(/^#+\s*/, "")}`;
      }

      if (!paragraphs.some((existing) => existing.markdown === markdown)) {
        paragraphs.push({ markdown, node: block });
      }
    }

    return paragraphs;
  }

  function hasLongformSignal(surface) {
    if (!surface) return false;
    const rootTweetArticle = rootTweetArticleFor(surface);
    for (const element of surface.querySelectorAll("[data-testid], [aria-label], a[href]")) {
      const closestTweet = element.closest(TWEET_ARTICLE_SELECTOR);
      if (rootTweetArticle && closestTweet && closestTweet !== rootTweetArticle) continue;
      const attrs = [
        element.getAttribute("data-testid"),
        element.getAttribute("aria-label"),
        element.getAttribute("href"),
      ].filter(Boolean).join(" ").toLowerCase();
      if (
        attrs.includes("longform") ||
        attrs.includes("article") ||
        attrs.includes("/i/article") ||
        attrs.includes("note_tweet")
      ) {
        return true;
      }
    }
    return false;
  }

  function targetArticleFromDocument(doc, identity) {
    const threadSelection = root.MineTwitterThreadSelection;
    const selected = threadSelection?.selectTwitterThreadArticles?.({
      document: doc,
      targetTweetId: identity.tweetId,
      authorHandle: identity.authorHandle,
    }) || [];
    const target = selected.find((article) => {
      return threadSelection?.getTweetIdentity?.(article)?.tweetId === identity.tweetId;
    });
    if (target) return target;
    if (selected[0]) return selected[0];

    for (const article of doc.querySelectorAll(TWEET_ARTICLE_SELECTOR)) {
      const statusLink = article.querySelector(`a[href*="/status/${identity.tweetId}"]`);
      if (statusLink) return article;
    }
    return null;
  }

  // Document-order test: true when node `a` precedes node `b`, or when `b` is
  // nested inside `a` (an ancestor is considered to come first).
  function isNodeBeforeInDocument(a, b) {
    if (!a || !b || a === b) return false;
    const rel = a.compareDocumentPosition(b);
    return Boolean(rel & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY));
  }

  function collectArticleImages(surface) {
    const images = [];
    const seen = new Set();
    for (const img of surface.querySelectorAll("img")) {
      const articleMediaLink = img.closest('a[href*="/article/"][href*="/media/"]');
      if (img.closest(EXCLUDED_SELECTOR) && !articleMediaLink) continue;
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src) continue;
      if (src.includes("profile_images") || src.includes("/emoji/")) continue;
      let normalizedSrc = src;
      try {
        normalizedSrc = normalizeXArticleImageUrl(new URL(src, surface.ownerDocument.baseURI).href);
      } catch {
        normalizedSrc = normalizeXArticleImageUrl(src);
      }
      if (seen.has(normalizedSrc)) continue;
      seen.add(normalizedSrc);
      // `node` anchors the image in document order so the assembly step can
      // interleave it with the surrounding paragraphs at its real position.
      // `querySelectorAll` already yields images in document order.
      images.push({
        markdown: `![](${normalizedSrc})`,
        node: articleMediaLink || img,
      });
    }
    return images;
  }

  function normalizeXArticleImageUrl(src) {
    try {
      const url = new URL(src, "https://x.com/");
      if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
        if (url.searchParams.has("name")) {
          url.searchParams.set("name", "large");
        }
        return url.href;
      }
    } catch {}
    return src;
  }

  // Merge paragraphs and images into a single stream that follows document
  // order, so inline images land between the paragraphs that surround them
  // instead of being bucketed before/after the whole body. Both inputs are
  // already in document order, so this is a linear two-pointer merge — stable,
  // no sort. Each item carries `{ markdown, node }`.
  function buildMarkdown(paragraphs, images) {
    const merged = [];
    let pi = 0;
    let ii = 0;
    while (pi < paragraphs.length && ii < images.length) {
      if (isNodeBeforeInDocument(images[ii].node, paragraphs[pi].node)) {
        merged.push(images[ii].markdown);
        ii += 1;
      } else {
        merged.push(paragraphs[pi].markdown);
        pi += 1;
      }
    }
    while (pi < paragraphs.length) merged.push(paragraphs[pi++].markdown);
    while (ii < images.length) merged.push(images[ii++].markdown);
    return merged
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  function titleFromParagraphs(paragraphs, fallbackTitle, surface) {
    const titleElement = surface?.querySelector?.(LONGFORM_TITLE_SELECTOR);
    const explicitTitle = titleElement ? compactText(titleElement.textContent || "") : "";
    if (explicitTitle) return explicitTitle;
    const candidate = paragraphs.find((paragraph) => {
      const plain = paragraph.markdown.replace(/^#+\s*/, "");
      return plain.length >= 8 && plain.length <= 140;
    })?.markdown.replace(/^#+\s*/, "");
    return candidate || fallbackTitle || "";
  }

  function extractXLongformArticle({
    document: doc,
    locationHref,
    fallbackTitle = "",
    fallbackByline = null,
  }) {
    const identity = parseStatusIdentity(locationHref || doc?.location?.href);
    if (!identity || !doc) return null;

    const targetArticle = targetArticleFromDocument(doc, identity);
    if (!targetArticle) return null;

    const longformSurface = targetArticle.querySelector(LONGFORM_READ_SELECTOR) || targetArticle;
    const hasSignal = hasLongformSignal(longformSurface);
    const paragraphs = collectDraftEditorBlocks(longformSurface, { excludeTweetText: false });
    if (paragraphs.length === 0) {
      paragraphs.push(...collectParagraphTexts(longformSurface, { excludeTweetText: true }));
    }
    const bodyText = plainTextFromMarkdown(
      paragraphs.map((paragraph) => paragraph.markdown).join(" "),
    );
    const hasBody =
      paragraphs.length >= MIN_PARAGRAPH_COUNT &&
      bodyText.length >= MIN_BODY_CHARS;

    if (!hasBody && !hasSignal) {
      return null;
    }

    if (!hasBody) {
      return {
        status: "empty",
        article: {
          title: fallbackTitle || "",
          content: "",
          byline: fallbackByline || `@${identity.authorHandle}`,
          excerpt: "",
          embeddedVideos: [],
        },
      };
    }

    const images = collectArticleImages(targetArticle);
    const content = buildMarkdown(paragraphs, images);
    const title = titleFromParagraphs(paragraphs, fallbackTitle, longformSurface);

    return {
      status: "article",
      article: {
        title,
        content,
        byline: fallbackByline || `@${identity.authorHandle}`,
        excerpt: bodyText.slice(0, 200),
        embeddedVideos: [],
      },
    };
  }

  root.MineXLongformArticleExtraction = {
    extractXLongformArticle,
    parseStatusIdentity,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
