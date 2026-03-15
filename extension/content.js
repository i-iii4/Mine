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
    // Instagram posts — always save as article
    if (isInstagramPostUrl(meta.url)) return "article";
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

  // ── Instagram post extraction ──────────────────────────────────────────

  function isInstagramPostUrl(url) {
    const lc = url.toLowerCase();
    return lc.includes("instagram.com/p/") || lc.includes("instagram.com/reel/") || lc.includes("instagram.com/stories/");
  }

  function extractInstagramShortcode(url) {
    const match = url.match(/instagram\.com\/(?:p|reel)\/([\w-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Convert Instagram shortcode to numeric media ID.
   * Shortcodes are base64-encoded (custom alphabet) media IDs.
   */
  function shortcodeToMediaId(shortcode) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = BigInt(0);
    for (const char of shortcode) {
      id = id * BigInt(64) + BigInt(alphabet.indexOf(char));
    }
    return id.toString();
  }

  async function extractInstagramPost() {
    const url = window.location.href;

    // Stories: numeric ID directly from URL. Posts/Reels: shortcode → media ID.
    const storyMatch = url.match(/instagram\.com\/stories\/[\w.]+\/(\d+)/);
    const shortcode = extractInstagramShortcode(url);

    let mediaId;
    if (storyMatch) {
      mediaId = storyMatch[1];
    } else if (shortcode) {
      mediaId = shortcodeToMediaId(shortcode);
    } else {
      return null;
    }

    try {

      const resp = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
        headers: {
          "X-IG-App-ID": "936619743392459",
        },
        credentials: "include",
      });

      if (!resp.ok) return null;
      const json = await resp.json();

      const items = json.items || [];
      if (items.length === 0) return null;
      const item = items[0];

      // Caption
      const caption = item.caption?.text || "";

      // Author
      const author = item.user?.username || "";

      // Media URLs (carousel or single)
      const mediaUrls = [];
      const carousel = item.carousel_media || [];
      if (carousel.length > 0) {
        for (const slide of carousel) {
          if (slide.video_versions?.length > 0) {
            mediaUrls.push(slide.video_versions[0].url);
          } else if (slide.image_versions2?.candidates?.length > 0) {
            mediaUrls.push(slide.image_versions2.candidates[0].url);
          }
        }
      } else {
        if (item.video_versions?.length > 0) {
          mediaUrls.push(item.video_versions[0].url);
        } else if (item.image_versions2?.candidates?.length > 0) {
          mediaUrls.push(item.image_versions2.candidates[0].url);
        }
      }

      // Build markdown body
      const parts = [];
      if (caption) parts.push(caption);
      for (const url of mediaUrls) {
        parts.push(`![](${url})`);
      }

      const titleText = caption.replace(/\n/g, " ").trim().slice(0, 80) || `@${author}`;

      return {
        title: titleText,
        content: parts.join("\n\n"),
        byline: author ? `@${author}` : null,
        excerpt: caption.slice(0, 200),
      };
    } catch (e) {
      console.error("[Local Arena] Instagram extraction failed:", e);
      return null;
    }
  }

  // ── Instagram feed clip button ─────────────────────────────────────────

  function initInstagramFeedButton() {
    if (!window.location.hostname.includes("instagram.com")) return;

    const BUTTON_ATTR = "data-la-clip";

    function findShortcode(article) {
      for (const a of article.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
        const match = a.getAttribute("href")?.match(/\/(p|reel)\/([\w-]+)/);
        if (match) return match[2];
      }
      return null;
    }

    function createClipButton() {
      const btn = document.createElement("button");
      btn.setAttribute(BUTTON_ATTR, "");
      btn.title = "Save to Local Arena";
      Object.assign(btn.style, {
        position: "absolute",
        top: "62px",
        right: "12px",
        zIndex: "10",
        width: "32px",
        height: "32px",
        borderRadius: "50%",
        background: "rgba(0,0,0,0.6)",
        border: "none",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: "1",
        padding: "0",
      });
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
      return btn;
    }

    async function clipPost(shortcode, btn) {
      btn.style.opacity = "0.5";
      btn.style.pointerEvents = "none";

      try {
        const mediaId = shortcodeToMediaId(shortcode);
        const resp = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
          headers: { "X-IG-App-ID": "936619743392459" },
          credentials: "include",
        });
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        const json = await resp.json();

        const item = (json.items || [])[0];
        if (!item) throw new Error("No items");

        const caption = item.caption?.text || "";
        const author = item.user?.username || "";

        const mediaUrls = [];
        const carousel = item.carousel_media || [];
        if (carousel.length > 0) {
          for (const slide of carousel) {
            if (slide.video_versions?.length > 0) {
              mediaUrls.push(slide.video_versions[0].url);
            } else if (slide.image_versions2?.candidates?.length > 0) {
              mediaUrls.push(slide.image_versions2.candidates[0].url);
            }
          }
        } else {
          if (item.video_versions?.length > 0) {
            mediaUrls.push(item.video_versions[0].url);
          } else if (item.image_versions2?.candidates?.length > 0) {
            mediaUrls.push(item.image_versions2.candidates[0].url);
          }
        }

        const parts = [];
        if (caption) parts.push(caption);
        for (const url of mediaUrls) {
          parts.push(`![](${url})`);
        }

        const titleText = caption.replace(/\n/g, " ").trim().slice(0, 80) || `@${author}`;
        const postUrl = `https://www.instagram.com/p/${shortcode}/`;

        // Store pre-extracted data and open popup
        const preloadData = {
          metadata: {
            url: postUrl,
            title: titleText,
            description: caption.slice(0, 200),
            image: mediaUrls[0] || null,
            author: `@${author}`,
            ogType: null,
            favicon: null,
            selection: "",
            detectedType: "article",
            isArticle: true,
          },
          article: {
            title: titleText,
            content: parts.join("\n\n"),
            byline: `@${author}`,
            excerpt: caption.slice(0, 200),
          },
        };

        chrome.runtime.sendMessage({
          target: "background",
          action: "openClipperWithData",
          data: preloadData,
        });

        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
      } catch (e) {
        console.error("[Local Arena] Instagram feed clip failed:", e);
        btn.style.opacity = "1";
        btn.style.background = "rgba(239,68,68,0.8)";
        btn.style.pointerEvents = "auto";
      }
    }

    function scanArticles() {
      for (const article of document.querySelectorAll("article")) {
        if (article.querySelector(`[${BUTTON_ATTR}]`)) continue;
        const shortcode = findShortcode(article);
        if (!shortcode) continue;

        if (getComputedStyle(article).position === "static") {
          article.style.position = "relative";
        }

        const btn = createClipButton();
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          clipPost(shortcode, btn);
        });

        article.appendChild(btn);
      }
    }

    // Scan every 500ms for new posts (Instagram is SPA, DOM changes dynamically)
    setInterval(scanArticles, 500);
    scanArticles();
  }

  // Start Instagram feed button injection
  initInstagramFeedButton();

  // ── Article extraction (Defuddle) ─────────────────────────────────────

  function extractArticle() {
    // Twitter/X: async only (extractTwitterThread uses syndication API)
    if (isTwitterUrl(window.location.href)) {
      return { title: document.title, content: "", byline: null, excerpt: "" };
    }

    // Instagram: async only (GraphQL API)
    if (isInstagramPostUrl(window.location.href)) {
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

    // Instagram: GraphQL API (same-origin, needs browser cookies)
    if (isInstagramPostUrl(window.location.href)) {
      return (await extractInstagramPost()) ||
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
