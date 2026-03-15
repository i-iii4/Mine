// Content script: extracts page metadata and article content.
// Runs in the context of every page (document_idle).
// Responds to messages from the popup/background.
//
// Uses Defuddle (https://github.com/kepano/defuddle) for article extraction
// and Markdown conversion. Twitter/X threads use a specialized extractor.

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

  /** Upgrade YouTube thumbnail URL from hqdefault (480x360, 4:3 with bars) to maxresdefault (1280x720, 16:9). */
  function upgradeYoutubeThumbnail(imageUrl, pageUrl) {
    if (!imageUrl) return null;
    if (!pageUrl || !isVideoUrl(pageUrl)) return imageUrl;
    const match = imageUrl.match(/https?:\/\/i\.ytimg\.com\/vi\/([\w-]+)\//);
    if (match) {
      return `https://i.ytimg.com/vi/${match[1]}/maxresdefault.jpg`;
    }
    return imageUrl;
  }

  function extractMetadata() {
    const sel = window.getSelection();
    const selectionText = sel.toString().trim();

    const pageUrl = window.location.href;
    let title = getMeta("og:title") || getMeta("twitter:title") || document.title || "";
    let author = getMeta("author") || getMeta("article:author") || null;

    // Twitter/X: author from URL, title left as og:title (overridden by extractTwitterThread later)
    if (isTwitterUrl(pageUrl)) {
      const handleMatch = pageUrl.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status/i);
      if (handleMatch) {
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
      image: upgradeYoutubeThumbnail(getMeta("og:image") || getMeta("twitter:image") || null, pageUrl),
      author,
      ogType: getMeta("og:type") || null,
      favicon: getFavicon(),
      selection: selectionText,
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
   * so we traverse manually.
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
   * Extract a single tweet's text and media from DOM.
   * Used for thread tweets (not the main tweet, which uses syndication API).
   */
  function extractTweetContent(article) {
    const tweetTextEl = article.querySelector('div[data-testid="tweetText"]');
    let text = "";
    if (tweetTextEl) {
      text = tweetTextToMarkdown(tweetTextEl);
    }

    const media = [];

    // Static images
    for (const img of article.querySelectorAll('div[data-testid="tweetPhoto"] img')) {
      let src = img.src || "";
      if (src.includes("pbs.twimg.com/media")) {
        const base = src.split("?")[0];
        src = base + "?format=jpg&name=large";
        media.push(src);
      }
    }

    // GIFs — direct MP4 URLs
    for (const video of article.querySelectorAll("video")) {
      const src = video.src || video.querySelector("source")?.src || "";
      if (src && !src.startsWith("blob:") && src.includes("video.twimg.com/")) {
        media.push(src);
      }
    }

    return { text, media };
  }

  /**
   * Fetch all media URLs from Twitter syndication API.
   * Returns array of direct URLs (photos, GIFs as MP4, videos as MP4 highest bitrate).
   * More reliable than DOM parsing — doesn't depend on lazy-loaded elements.
   */
  async function fetchTweetMedia(tweetId) {
    try {
      const resp = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      const urls = [];
      for (const m of (data.mediaDetails || [])) {
        if (m.type === "photo" && m.media_url_https) {
          urls.push(m.media_url_https + "?name=large");
        } else if (m.type === "video" || m.type === "animated_gif") {
          const variants = (m.video_info?.variants || [])
            .filter(v => v.content_type === "video/mp4" && v.bitrate != null)
            .sort((a, b) => b.bitrate - a.bitrate);
          if (variants.length > 0) {
            urls.push(variants[0].url);
          }
        }
      }
      return urls;
    } catch {
      return [];
    }
  }

  async function extractTwitterThread() {
    const url = window.location.href;

    // Extract author handle and tweet ID from URL
    const urlMatch = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
    if (!urlMatch) return null;
    const authorHandle = urlMatch[1];
    const authorHandleLc = authorHandle.toLowerCase();
    const tweetId = urlMatch[2];

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length === 0) return null;

    // Fetch media from syndication API (includes videos that DOM can't capture)
    let apiMedia = [];
    if (tweetId) {
      apiMedia = await fetchTweetMedia(tweetId);
    }

    const tweets = [];
    let foundAuthorTweet = false;

    for (const article of articles) {
      const isAuthor = isTweetByAuthor(article, authorHandleLc);

      if (!isAuthor) {
        if (foundAuthorTweet) break;
        continue;
      }

      foundAuthorTweet = true;
      const { text, media } = extractTweetContent(article);
      // First tweet: prefer API media (complete — photos + GIFs + videos).
      // Fallback to DOM media if API returned nothing.
      const isFirstTweet = tweets.length === 0;
      const finalMedia = isFirstTweet && apiMedia.length > 0 ? apiMedia : media;
      if (text || finalMedia.length > 0) {
        tweets.push({ text, media: finalMedia });
      }
    }

    // Fallback: grab first tweet
    if (tweets.length === 0 && articles.length > 0) {
      const { text, media } = extractTweetContent(articles[0]);
      const finalMedia = apiMedia.length > 0 ? apiMedia : media;
      if (text || finalMedia.length > 0) {
        tweets.push({ text, media: finalMedia });
      }
    }

    if (tweets.length === 0) return null;

    // Build Markdown body
    const parts = [];
    for (let i = 0; i < tweets.length; i++) {
      const t = tweets[i];
      if (t.text) parts.push(t.text);
      for (const src of (t.media || [])) {
        parts.push(`![](${src})`);
      }
      if (i < tweets.length - 1) parts.push("---");
    }

    const firstText = (tweets[0]?.text || "").replace(/\n/g, " ").trim();
    const tweetTitle = firstText.slice(0, 80) || `@${authorHandle}`;

    return {
      title: tweetTitle,
      content: parts.join("\n\n"),
      byline: `@${authorHandle}`,
      excerpt: firstText.slice(0, 200),
    };
  }

  // ── Article extraction (Defuddle) ─────────────────────────────────────

  function extractArticle() {
    // Twitter/X: async only (extractTwitterThread uses syndication API)
    if (isTwitterUrl(window.location.href)) {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }

    // YouTube: skip Defuddle sync (transcript comes from async path)
    if (isVideoUrl(window.location.href)) {
      return {
        title: getMeta("og:title") || document.title || "",
        content: "",
        html: "",
        byline: null,
        excerpt: getMeta("og:description") || "",
      };
    }

    if (typeof Defuddle === "undefined") {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }
    try {
      const result = new Defuddle(document, {
        separateMarkdown: true,
      }).parse();

      if (!result || !result.content) {
        return { title: document.title, content: "", byline: null, excerpt: "" };
      }

      return {
        title: result.title || document.title,
        content: result.contentMarkdown || "",
        html: result.content || "",
        byline: result.author || null,
        excerpt: result.description || "",
      };
    } catch {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }
  }

  // Async version — custom YouTube fetcher, Defuddle for everything else
  async function extractArticleAsync() {
    if (isTwitterUrl(window.location.href)) {
      return (await extractTwitterThread()) ||
        { title: document.title, content: "", byline: null, excerpt: "" };
    }

    // YouTube: Defuddle parseAsync extracts transcript via InnerTube API (needs browser cookies).
    // Key: read result.variables.transcript (not contentMarkdown, which is an iframe embed).
    if (isVideoUrl(window.location.href)) {
      if (typeof Defuddle === "undefined") {
        return { title: document.title, content: "", byline: null, excerpt: "" };
      }
      try {
        const result = await new Defuddle(document, { separateMarkdown: true }).parseAsync();
        return {
          title: result?.title || getMeta("og:title") || document.title || "",
          content: result?.variables?.transcript || "",
          html: "",
          byline: result?.author || null,
          excerpt: result?.description || getMeta("og:description") || "",
        };
      } catch {
        return { title: getMeta("og:title") || document.title || "", content: "", byline: null, excerpt: "" };
      }
    }

    // Other pages: use Defuddle
    if (typeof Defuddle === "undefined") {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }
    try {
      const result = await new Defuddle(document, {
        separateMarkdown: true,
      }).parseAsync();

      if (!result || !result.content) {
        return { title: document.title, content: "", byline: null, excerpt: "" };
      }

      return {
        title: result.title || document.title,
        content: result.contentMarkdown || "",
        html: result.content || "",
        byline: result.author || null,
        excerpt: result.description || "",
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

    if (msg.action === "extractArticleAsync") {
      extractArticleAsync().then(sendResponse);
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
