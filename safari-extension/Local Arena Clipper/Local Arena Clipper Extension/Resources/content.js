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
      console.error("[Mine] Instagram extraction failed:", e);
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
      btn.title = "Save to Mine";
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
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
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

        // Write preloaded data to session storage, then show the overlay.
        // useClipperState will pick this up in init() via preloadedClipData.
        await chrome.storage.session.set({ preloadedClipData: preloadData });
        // Ask background to inject the overlay bundle and show it.
        // Background will call executeScript({files: ["dist/overlay.js"]})
        // which defines window.__mineOverlay, then we receive the show message.
        await chrome.runtime.sendMessage({
          target: "background",
          action: "showOverlayInThisTab",
        });

        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
      } catch (e) {
        console.error("[Mine] Instagram feed clip failed:", e);
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

  // ── Crop overlay ────────────────────────────────────────────────────────
  //
  // User clicks "Crop Area" in popup → popup persists state + closes → background
  // messages us with "startCropOverlay". We inject a Shadow-DOM overlay on top of
  // the page, user drags a rectangle, we ask background for a full-viewport
  // screenshot, crop it on OffscreenCanvas (scaling by devicePixelRatio), and send
  // the cropped dataUrl back to background with "cropDone". Background persists
  // the result and reopens the popup, which rehydrates state from session storage.

  let cropOverlayHost = null;
  let cropToastHost = null;

  function destroyCropOverlay() {
    if (cropOverlayHost) {
      cropOverlayHost.remove();
      cropOverlayHost = null;
    }
    document.documentElement.style.cursor = "";
  }

  function showCropToast(message) {
    if (cropToastHost) cropToastHost.remove();

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .toast {
          background: rgba(0,0,0,0.85);
          color: #fff;
          padding: 10px 16px;
          border-radius: 3px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          font-weight: 600;
          box-shadow: 0 4px 24px rgba(0,0,0,0.4);
        }
      </style>
      <div class="toast">${message}</div>
    `;
    document.body.appendChild(host);
    cropToastHost = host;

    setTimeout(() => {
      if (cropToastHost === host) {
        host.remove();
        cropToastHost = null;
      }
    }, 6000);
  }

  function sendCropResult(payload) {
    // Restore clipper overlay (hidden on crop start). In the overlay
    // architecture the React state is still live — we just toggle the
    // host's display:none, no rehydrate needed, no toast needed.
    if (window.__mineOverlay) {
      window.__mineOverlay.show();
      // Tell the overlay to accept the new cropped screenshot via a
      // custom event dispatched on its isolated-world window.
      if (payload.status === "done" && payload.dataUrl) {
        window.dispatchEvent(new CustomEvent("mine-crop-result", {
          detail: { dataUrl: payload.dataUrl },
        }));
      }
      return;
    }
    // Fallback path (detached window): persist result + show toast so
    // user can reopen detached popup manually (used when overlay isn't
    // available, e.g. after chrome:// navigation that killed content script).
    if (payload.status === "done") {
      showCropToast("Screenshot ready — click the Mine icon to save");
    }
    chrome.runtime.sendMessage({ target: "background", action: "cropDone", ...payload }, () => {
      void chrome.runtime.lastError;
    });
  }

  async function performCrop(rect) {
    // Ask background for a full viewport capture
    const captureResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { target: "background", action: "captureForCrop" },
        (resp) => resolve(resp || { ok: false, error: "No response" }),
      );
    });

    if (!captureResp.ok || !captureResp.dataUrl) {
      sendCropResult({ status: "cancelled" });
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);

    try {
      // Load the captured viewport into an image
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Failed to load captured image"));
        el.src = captureResp.dataUrl;
      });

      // Crop via OffscreenCanvas (or fall back to regular canvas)
      const canvas = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(sw, sh)
        : Object.assign(document.createElement("canvas"), { width: sw, height: sh });
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      let croppedDataUrl;
      if (canvas.convertToBlob) {
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
        croppedDataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } else {
        croppedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      }

      sendCropResult({ status: "done", dataUrl: croppedDataUrl });
    } catch (e) {
      console.error("[Mine] crop failed:", e);
      sendCropResult({ status: "cancelled" });
    }
  }

  function startCropOverlay() {
    // Guard against double-start
    if (cropOverlayHost) return;

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });

    // Styles and markup inside shadow — isolated from page CSS
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .overlay {
          position: fixed;
          inset: 0;
          pointer-events: auto;
          cursor: crosshair;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          color: #fff;
          user-select: none;
          -webkit-user-select: none;
        }
        .dim {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          transition: background 120ms;
        }
        .dim.active { background: transparent; }
        .selection {
          position: absolute;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
          outline: 1px solid #fff;
          pointer-events: none;
          display: none;
        }
        .selection.visible { display: block; }
        .size-label {
          position: absolute;
          background: rgba(0, 0, 0, 0.75);
          color: #fff;
          padding: 3px 6px;
          border-radius: 3px;
          font-variant-numeric: tabular-nums;
          pointer-events: none;
          display: none;
        }
        .size-label.visible { display: block; }
        .hint {
          position: fixed;
          top: 16px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0, 0, 0, 0.8);
          color: #fff;
          padding: 8px 14px;
          border-radius: 6px;
          pointer-events: none;
          white-space: nowrap;
        }
        kbd {
          background: rgba(255, 255, 255, 0.15);
          padding: 1px 5px;
          border-radius: 3px;
          font-family: inherit;
          font-size: 11px;
        }
      </style>
      <div class="overlay">
        <div class="dim"></div>
        <div class="selection"></div>
        <div class="size-label"></div>
        <div class="hint">Click and drag to select area &nbsp;•&nbsp; <kbd>Esc</kbd> to cancel</div>
      </div>
    `;

    document.body.appendChild(host);
    cropOverlayHost = host;

    const overlay = shadow.querySelector(".overlay");
    const dim = shadow.querySelector(".dim");
    const selection = shadow.querySelector(".selection");
    const sizeLabel = shadow.querySelector(".size-label");

    // Lock page scroll so coordinates stay stable throughout the drag
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let rect = { x: 0, y: 0, width: 0, height: 0 };

    function updateSelection() {
      selection.style.left = `${rect.x}px`;
      selection.style.top = `${rect.y}px`;
      selection.style.width = `${rect.width}px`;
      selection.style.height = `${rect.height}px`;
      selection.classList.add("visible");
      dim.classList.add("active");

      sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      sizeLabel.classList.add("visible");
      // Place label inside top-left of selection, fall back to outside if too small
      const labelX = rect.x + 4;
      const labelY = rect.height > 28 ? rect.y + 4 : Math.max(0, rect.y - 22);
      sizeLabel.style.left = `${labelX}px`;
      sizeLabel.style.top = `${labelY}px`;
    }

    function onMouseDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      rect = { x: startX, y: startY, width: 0, height: 0 };
    }

    function onMouseMove(e) {
      if (!dragging) return;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      rect = { x, y, width: w, height: h };
      updateSelection();
    }

    function cleanup() {
      overlay.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
      document.documentElement.style.overflow = prevOverflow;
      destroyCropOverlay();
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;

      // Reject tiny selections — probably an accidental click
      if (rect.width < 20 || rect.height < 20) {
        selection.classList.remove("visible");
        sizeLabel.classList.remove("visible");
        dim.classList.remove("active");
        return;
      }

      const finalRect = { ...rect };
      cleanup();
      performCrop(finalRect);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        sendCropResult({ status: "cancelled" });
      }
    }

    overlay.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown, true);
  }

  // ── Message handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "startCropOverlay") {
      try {
        startCropOverlay();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return false; // synchronous — response already sent
    }

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
      sendResponse(getImageInfoBySrc(msg.src));
      return true;
    }

    return false;
  });

  function getImageInfoBySrc(src) {
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      if (img.src === src || img.currentSrc === src) {
        return {
          src: img.src,
          alt: img.alt || null,
          title: img.title || null,
          width: img.naturalWidth || null,
          height: img.naturalHeight || null,
        };
      }
    }
    return { src, alt: null, title: null, width: null, height: null };
  }

  // Expose extractors to other scripts running in the same content-script
  // isolated world (e.g., the overlay entry injected via
  // chrome.scripting.executeScript). They can call these directly without
  // round-tripping through chrome.runtime.sendMessage → background → tabs.
  //
  // The isolated world `window` is shared between all scripts injected
  // into the same frame by this extension, so this assignment is visible
  // from overlay.js as `window.__mineClipper`.
  window.__mineClipper = {
    extractMetadata: () => {
      const meta = extractMetadata();
      meta.detectedType = detectType(meta);
      meta.isArticle = isArticlePage(meta);
      return meta;
    },
    extractArticle,
    extractArticleAsync,
    getImageInfo: getImageInfoBySrc,
  };
})();
