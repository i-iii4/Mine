// Content script: extracts page metadata and article content.
// Runs in the context of every page (document_idle).
// Responds to messages from the popup/background.

(() => {
  "use strict";

  // ── Metadata extraction ─────────────────────────────────────────────────

  function getMeta(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute("content") : null;
  }

  function getCanonicalUrl() {
    const link = document.querySelector('link[rel="canonical"]');
    return link ? link.getAttribute("href") : null;
  }

  function getFavicon() {
    const link =
      document.querySelector('link[rel="icon"]') ||
      document.querySelector('link[rel="shortcut icon"]');
    if (link) return link.getAttribute("href");
    return "/favicon.ico";
  }

  function htmlToMarkdown(html) {
    if (!html || typeof TurndownService === "undefined") return null;
    try {
      const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
        emDelimiter: "*",
      });
      return turndown.turndown(html);
    } catch (e) {
      console.error("[Local Arena] htmlToMarkdown failed:", e);
      return null;
    }
  }

  function extractMetadata() {
    const sel = window.getSelection();
    let selectionText = sel.toString().trim();
    let selectionMarkdown = selectionText;

    // Convert selection HTML to Markdown
    if (sel.rangeCount > 0 && selectionText.length > 0) {
      try {
        const range = sel.getRangeAt(0);
        const div = document.createElement("div");
        div.appendChild(range.cloneContents());
        const md = htmlToMarkdown(div.innerHTML);
        if (md) selectionMarkdown = md;
      } catch {
        // Fallback to plain text
      }
    }

    const pageUrl = window.location.href;
    let title = getMeta("og:title") || getMeta("twitter:title") || document.title || "";
    let author = getMeta("author") || getMeta("article:author") || null;

    // Twitter/X: override title and author from URL
    if (isTwitterUrl(pageUrl)) {
      const handleMatch = pageUrl.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status/i);
      if (handleMatch) {
        title = `Thread by @${handleMatch[1]}`;
        author = `@${handleMatch[1]}`;
      }
    }

    return {
      url: getCanonicalUrl() || getMeta("og:url") || pageUrl,
      title,
      description:
        getMeta("og:description") ||
        getMeta("twitter:description") ||
        getMeta("description") ||
        "",
      image: getMeta("og:image") || getMeta("twitter:image") || null,
      author,
      ogType: getMeta("og:type") || null,
      favicon: getFavicon(),
      selection: selectionMarkdown,
      bodyText: (document.body ? document.body.innerText : "").slice(0, 2000),
    };
  }

  // ── Auto-detection heuristic ────────────────────────────────────────────

  function isVideoUrl(url) {
    const lc = url.toLowerCase();
    return (
      lc.includes("youtube.com/watch") ||
      lc.includes("youtu.be/") ||
      lc.includes("vimeo.com/")
    );
  }

  function isArticlePage(meta) {
    let signals = 0;
    if (document.querySelector("article")) signals++;
    if (meta.ogType === "article") signals++;
    if (typeof isProbablyReaderable === "function" && isProbablyReaderable(document)) {
      signals++;
    }
    const bodyText = document.body ? document.body.innerText : "";
    if (bodyText.length > 2000) signals++;
    return signals >= 2;
  }

  function detectType(meta) {
    // Selection takes priority
    if (meta.selection.length > 0) return "selection";
    // Video pages
    if (isVideoUrl(meta.url)) return "video";
    // Twitter threads — always save as article
    if (isTwitterUrl(meta.url)) return "article";
    // Article pages
    if (isArticlePage(meta)) return "article";
    // Default
    return "link";
  }

  // ── Twitter/X thread extraction ──────────────────────────────────────────

  function isTwitterUrl(url) {
    const lc = url.toLowerCase();
    return (
      (lc.includes("twitter.com/") || lc.includes("x.com/")) &&
      lc.includes("/status/")
    );
  }

  /**
   * Check if a tweet article element belongs to a given author.
   * Handles both relative (/handle) and absolute (https://x.com/handle) hrefs.
   */
  function isTweetByAuthor(article, authorHandleLc) {
    const userName = article.querySelector('div[data-testid="User-Name"]');
    if (!userName) return false;
    for (const link of userName.querySelectorAll("a[href]")) {
      const href = (link.getAttribute("href") || "").toLowerCase();
      if (href === `/${authorHandleLc}` || href.endsWith(`/${authorHandleLc}`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Walk a tweet's DOM tree and produce Markdown.
   * Twitter uses non-semantic HTML (<span> + CSS) instead of <br>/<p>,
   * so TurndownService can't handle it — we traverse manually.
   */
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
        // Hashtags and mentions — keep as plain text
        if (href.startsWith("/hashtag/") || href.startsWith("/")) {
          result += text;
        } else {
          result += `[${text}](${href})`;
        }
      } else if (node.nodeName === "IMG") {
        // Emoji images — use alt text
        result += node.getAttribute("alt") || "";
      } else if (node.childNodes.length > 0) {
        // Nested spans — recurse
        result += tweetTextToMarkdown(node);
      } else {
        result += node.textContent || "";
      }
    }
    return result;
  }

  /**
   * Extract a single tweet's text and media images from an article element.
   * Skips emoji, avatars, and card images — only pbs.twimg.com/media counts.
   */
  function extractTweetContent(article) {
    const tweetTextEl = article.querySelector('div[data-testid="tweetText"]');
    let text = "";
    if (tweetTextEl) {
      text = tweetTextToMarkdown(tweetTextEl);
    }

    const images = [];
    for (const img of article.querySelectorAll('div[data-testid="tweetPhoto"] img')) {
      let src = img.src || "";
      if (src.includes("pbs.twimg.com/media")) {
        const base = src.split("?")[0];
        src = base + "?format=jpg&name=large";
        images.push(src);
      }
    }

    return { text, images };
  }

  function extractTwitterThread() {
    const url = window.location.href;

    // Extract author handle from URL: x.com/handle/status/123
    const urlMatch = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status/i);
    if (!urlMatch) return null;
    const authorHandle = urlMatch[1];
    const authorHandleLc = authorHandle.toLowerCase();

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length === 0) return null;

    const tweets = [];
    let foundAuthorTweet = false;

    for (const article of articles) {
      const isAuthor = isTweetByAuthor(article, authorHandleLc);

      if (!isAuthor) {
        // Once we've seen author's tweets and hit a non-author tweet, stop.
        // Everything below is replies from other users.
        if (foundAuthorTweet) break;
        // Haven't found author yet — skip (promoted/pinned content above)
        continue;
      }

      foundAuthorTweet = true;
      const { text, images } = extractTweetContent(article);
      if (text || images.length > 0) {
        tweets.push({ text, images });
      }
    }

    // If author matching failed entirely, grab just the first tweet
    // (it's always the main tweet on the page)
    if (tweets.length === 0 && articles.length > 0) {
      const { text, images } = extractTweetContent(articles[0]);
      if (text || images.length > 0) {
        tweets.push({ text, images });
      }
    }

    if (tweets.length === 0) return null;

    // Build Markdown body
    const parts = [];
    for (let i = 0; i < tweets.length; i++) {
      const t = tweets[i];
      if (t.text) parts.push(t.text);
      for (const imgUrl of t.images) {
        parts.push(`![](${imgUrl})`);
      }
      if (i < tweets.length - 1) parts.push("---");
    }

    return {
      title: `Thread by @${authorHandle}`,
      content: parts.join("\n\n"),
      byline: `@${authorHandle}`,
      excerpt: (tweets[0]?.text || "").slice(0, 200),
    };
  }

  // ── Article extraction (Readability.js) ─────────────────────────────────

  function extractArticle() {
    // Twitter/X: use specialized thread extractor, never Readability
    // (Readability grabs comments, cards, and recommended content)
    if (isTwitterUrl(window.location.href)) {
      return extractTwitterThread() ||
        { title: document.title, content: "", byline: null, excerpt: "" };
    }

    if (typeof Readability === "undefined") {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }
    try {
      const clone = document.cloneNode(true);
      const reader = new Readability(clone);
      const article = reader.parse();
      if (!article) {
        return { title: document.title, content: "", byline: null, excerpt: "" };
      }

      // Convert Readability HTML to Markdown
      const markdown = htmlToMarkdown(article.content) || "";

      return {
        title: article.title || document.title,
        content: markdown,
        byline: article.byline || null,
        excerpt: article.excerpt || "",
      };
    } catch {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }
  }

  // ── Message handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "extractMetadata") {
      const meta = extractMetadata();
      meta.detectedType = detectType(meta);
      meta.isArticle = isArticlePage(meta);
      sendResponse(meta);
      return true;
    }

    if (msg.action === "extractArticle") {
      const article = extractArticle();
      sendResponse(article);
      return true;
    }

    if (msg.action === "getImageInfo") {
      // Find the image element at the given src
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        if (img.src === msg.src || img.currentSrc === msg.src) {
          sendResponse({
            src: img.src,
            alt: img.alt || null,
            title: img.title || null,
            width: img.naturalWidth || null,
            height: img.naturalHeight || null,
          });
          return true;
        }
      }
      sendResponse({ src: msg.src, alt: null, title: null, width: null, height: null });
      return true;
    }

    return false;
  });
})();
