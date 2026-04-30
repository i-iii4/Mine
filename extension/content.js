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

  function absoluteUrl(url) {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  function youtubeIdFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url, document.baseURI);
      if (parsed.hostname.includes("youtu.be")) {
        return parsed.pathname.split("/").filter(Boolean)[0] || null;
      }
      if (parsed.hostname.includes("youtube.com")) {
        if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
        const embed = parsed.pathname.match(/\/(?:embed|shorts)\/([\w-]+)/);
        if (embed) return embed[1];
      }
    } catch {}
    return null;
  }

  function youtubePosterFromUrl(url) {
    const id = youtubeIdFromUrl(url);
    return id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null;
  }

  function pushUniqueVideo(out, video) {
    if (!video || (!video.src && !video.poster)) return;
    const key = video.src || video.poster;
    if (out.some((item) => (item.src || item.poster) === key)) return;
    out.push(video);
  }

  function isInlineVideoUrl(url) {
    return /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(url || "");
  }

  function pushVideoUrlPreview(out, src, poster, title) {
    const absoluteSrc = absoluteUrl(src);
    if (!absoluteSrc || !isInlineVideoUrl(absoluteSrc)) return;
    pushUniqueVideo(out, {
      src: absoluteSrc,
      poster: absoluteUrl(poster) || getMeta("og:image") || getMeta("twitter:image") || null,
      title: title || "",
    });
  }

  function extractEmbeddedVideoPreviews() {
    const root = document.querySelector("article") || document.body;
    if (!root) return [];

    const out = [];
    for (const video of root.querySelectorAll("video")) {
      const src = absoluteUrl(
        video.currentSrc ||
        video.getAttribute("src") ||
        video.querySelector("source[src]")?.getAttribute("src"),
      );
      const poster = absoluteUrl(video.getAttribute("poster"));
      pushUniqueVideo(out, {
        src,
        poster,
        title: video.getAttribute("aria-label") || video.getAttribute("title") || "",
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      });
      if (out.length >= 3) return out;
    }

    for (const iframe of root.querySelectorAll("iframe")) {
      const rawSrc = iframe.getAttribute("src") || iframe.getAttribute("data-src");
      const src = absoluteUrl(rawSrc);
      if (!src) continue;
      const lower = src.toLowerCase();
      const isKnownVideo =
        lower.includes("youtube.com/") ||
        lower.includes("youtu.be/") ||
        lower.includes("vimeo.com/") ||
        lower.includes("player.vimeo.com/");
      if (!isKnownVideo) continue;
      pushUniqueVideo(out, {
        src,
        poster: youtubePosterFromUrl(src),
        title: iframe.getAttribute("title") || "",
      });
      if (out.length >= 3) return out;
    }

    pushVideoUrlPreview(out, getMeta("og:video") || getMeta("og:video:url"), getMeta("og:image"), "");
    pushVideoUrlPreview(out, getMeta("twitter:player:stream"), getMeta("twitter:image"), "");

    return out;
  }

  function drawVideoFrameDataUrl(video) {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.86);
    } catch {
      return null;
    }
  }

  function captureVideoFrameDataUrl(video, timeoutMs = 350) {
    if (!video) return Promise.resolve(null);
    const readyFrame = drawVideoFrameDataUrl(video);
    if (readyFrame) return Promise.resolve(readyFrame);
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        video.removeEventListener("error", onError);
        resolve(value);
      };
      const onReady = () => finish(drawVideoFrameDataUrl(video));
      const onError = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      video.addEventListener("loadeddata", onReady, { once: true });
      video.addEventListener("canplay", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }

  function captureVideoUrlFrameDataUrl(src, targetTime = 0.2, timeoutMs = 650) {
    const absoluteSrc = absoluteUrl(src);
    if (!absoluteSrc || !isInlineVideoUrl(absoluteSrc)) return Promise.resolve(null);

    return new Promise((resolve) => {
      const video = document.createElement("video");
      let done = false;
      let waitingForSeek = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onMetadata);
        video.removeEventListener("loadeddata", onLoadedData);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        video.removeAttribute("src");
        video.load();
        resolve(value);
      };
      const draw = () => finish(drawVideoFrameDataUrl(video));
      const onSeeked = () => draw();
      const onLoadedData = () => {
        if (!waitingForSeek) draw();
      };
      const onError = () => finish(null);
      const onMetadata = () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const requestedTime = Number.isFinite(targetTime) ? targetTime : 0.2;
        const seekTime = duration > 0
          ? Math.min(Math.max(requestedTime, 0), Math.max(duration - 0.05, 0))
          : Math.max(requestedTime, 0);
        if (seekTime <= 0.01) return draw();
        try {
          waitingForSeek = true;
          video.currentTime = seekTime;
        } catch {
          draw();
        }
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.addEventListener("loadedmetadata", onMetadata, { once: true });
      video.addEventListener("loadeddata", onLoadedData, { once: true });
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = absoluteSrc;
      video.load();
    });
  }

  async function captureArticleVideoPosters(article, videoMedia, maxCount = 3) {
    if (!article) return [];
    const domVideos = Array.from(article.querySelectorAll("video")).slice(0, maxCount);
    const media = (videoMedia || []).slice(0, maxCount);
    const count = Math.max(domVideos.length, media.length);
    const posters = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const domVideo = domVideos[index] || null;
      const domPoster = await captureVideoFrameDataUrl(domVideo);
      if (domPoster) return domPoster;

      const candidate = media[index];
      if (!candidate || candidate.mediaType !== "animated_gif") return null;
      const currentTime = Number.isFinite(domVideo?.currentTime) ? domVideo.currentTime : 0.2;
      return captureVideoUrlFrameDataUrl(candidate.url, currentTime);
    }));
    return posters;
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
  async function fetchTweetMediaDetails(tweetId) {
    try {
      const resp = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      const media = [];
      for (const m of (data.mediaDetails || [])) {
        if (m.type === "photo" && m.media_url_https) {
          media.push({
            kind: "image",
            url: m.media_url_https + "?name=large",
            poster: m.media_url_https,
          });
        } else if (m.type === "video" || m.type === "animated_gif") {
          const variants = (m.video_info?.variants || [])
            .filter(v => v.content_type === "video/mp4" && v.bitrate != null)
            .sort((a, b) => b.bitrate - a.bitrate);
          if (variants.length > 0) {
            media.push({
              kind: "video",
              url: variants[0].url,
              poster: m.media_url_https || null,
              mediaType: m.type,
            });
          }
        }
      }
      return media;
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
    let apiMediaDetails = [];
    if (tweetId) {
      apiMediaDetails = await fetchTweetMediaDetails(tweetId);
    }
    const apiMedia = apiMediaDetails.map((m) => m.url);

    const tweets = [];
    let foundAuthorTweet = false;
    let firstAuthorArticle = null;

    for (const article of articles) {
      const isAuthor = isTweetByAuthor(article, authorHandleLc);

      if (!isAuthor) {
        if (foundAuthorTweet) break;
        continue;
      }

      foundAuthorTweet = true;
      if (!firstAuthorArticle) firstAuthorArticle = article;
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
        if (!firstAuthorArticle) firstAuthorArticle = articles[0];
      }
    }

    if (tweets.length === 0) return null;

    // For X/Twitter animated media, the API thumbnail can differ from the
    // actual frame the user sees in the page. Prefer a preview-only snapshot
    // from the visible tweet <video>; never change the saved video URL/body.
    const capturedPosters = await captureArticleVideoPosters(
      firstAuthorArticle,
      apiMediaDetails.filter((media) => media.kind === "video"),
    );
    if (capturedPosters.length > 0) {
      let posterIndex = 0;
      for (const media of apiMediaDetails) {
        if (media.kind !== "video") continue;
        const capturedPoster = capturedPosters[posterIndex];
        if (!capturedPoster) break;
        media.poster = capturedPoster;
        posterIndex += 1;
      }
    }

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
    const embeddedVideos = [];
    for (const media of apiMediaDetails) {
      if (media.kind === "video") {
        pushVideoUrlPreview(embeddedVideos, media.url, media.poster, "Tweet video preview");
      }
    }
    for (const tweet of tweets) {
      for (const src of (tweet.media || [])) {
        pushVideoUrlPreview(embeddedVideos, src, null, "Tweet video preview");
      }
    }
    // Twitter/X pages keep extra player <video> nodes in the DOM, often as
    // blob URLs with generic page posters. If the social/API path already
    // produced a direct mp4 + tweet_video_thumb poster, generic DOM fallback
    // would only add noisy duplicates to the popup preview.
    if (embeddedVideos.length === 0) {
      for (const video of extractEmbeddedVideoPreviews()) {
        pushUniqueVideo(embeddedVideos, video);
      }
    }

    return {
      title: tweetTitle,
      content: parts.join("\n\n"),
      byline: `@${authorHandle}`,
      excerpt: firstText.slice(0, 200),
      embeddedVideos,
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
      const mediaEntries = [];
      const carousel = item.carousel_media || [];
      if (carousel.length > 0) {
        for (const slide of carousel) {
          const poster = slide.image_versions2?.candidates?.[0]?.url || null;
          if (slide.video_versions?.length > 0) {
            mediaEntries.push({ kind: "video", url: slide.video_versions[0].url, poster });
          } else if (slide.image_versions2?.candidates?.length > 0) {
            mediaEntries.push({ kind: "image", url: slide.image_versions2.candidates[0].url, poster });
          }
        }
      } else {
        const poster = item.image_versions2?.candidates?.[0]?.url || null;
        if (item.video_versions?.length > 0) {
          mediaEntries.push({ kind: "video", url: item.video_versions[0].url, poster });
        } else if (item.image_versions2?.candidates?.length > 0) {
          mediaEntries.push({ kind: "image", url: item.image_versions2.candidates[0].url, poster });
        }
      }
      const mediaUrls = mediaEntries.map((entry) => entry.url);

      // Build markdown body
      const parts = [];
      if (caption) parts.push(caption);
      for (const url of mediaUrls) {
        parts.push(`![](${url})`);
      }

      const titleText = caption.replace(/\n/g, " ").trim().slice(0, 80) || `@${author}`;
      const embeddedVideos = [];
      for (const entry of mediaEntries) {
        if (entry.kind === "video") {
          pushVideoUrlPreview(embeddedVideos, entry.url, entry.poster, "Instagram video preview");
        }
      }
      for (const video of extractEmbeddedVideoPreviews()) {
        pushUniqueVideo(embeddedVideos, video);
      }

      return {
        title: titleText,
        content: parts.join("\n\n"),
        byline: author ? `@${author}` : null,
        excerpt: caption.slice(0, 200),
        embeddedVideos,
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

        const mediaEntries = [];
        const carousel = item.carousel_media || [];
        if (carousel.length > 0) {
          for (const slide of carousel) {
            const poster = slide.image_versions2?.candidates?.[0]?.url || null;
            if (slide.video_versions?.length > 0) {
              mediaEntries.push({ kind: "video", url: slide.video_versions[0].url, poster });
            } else if (slide.image_versions2?.candidates?.length > 0) {
              mediaEntries.push({ kind: "image", url: slide.image_versions2.candidates[0].url, poster });
            }
          }
        } else {
          const poster = item.image_versions2?.candidates?.[0]?.url || null;
          if (item.video_versions?.length > 0) {
            mediaEntries.push({ kind: "video", url: item.video_versions[0].url, poster });
          } else if (item.image_versions2?.candidates?.length > 0) {
            mediaEntries.push({ kind: "image", url: item.image_versions2.candidates[0].url, poster });
          }
        }
        const mediaUrls = mediaEntries.map((entry) => entry.url);
        const embeddedVideos = [];
        for (const entry of mediaEntries) {
          if (entry.kind === "video") {
            pushVideoUrlPreview(embeddedVideos, entry.url, entry.poster, "Instagram video preview");
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
            embeddedVideos,
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
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // Instagram: async only (GraphQL API)
    if (isInstagramPostUrl(window.location.href)) {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // YouTube: skip Defuddle sync (transcript comes from async path)
    if (isVideoUrl(window.location.href)) {
      return {
        title: getMeta("og:title") || document.title || "",
        content: "",
        html: "",
        byline: null,
        excerpt: getMeta("og:description") || "",
        embeddedVideos: extractEmbeddedVideoPreviews(),
      };
    }

    if (typeof Defuddle === "undefined") {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
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
        embeddedVideos: extractEmbeddedVideoPreviews(),
      };
    } catch {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }
  }

  // Async version — custom YouTube fetcher, Defuddle for everything else
  async function extractArticleAsync() {
    if (isTwitterUrl(window.location.href)) {
      return (await extractTwitterThread()) ||
        { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // Instagram: GraphQL API (same-origin, needs browser cookies)
    if (isInstagramPostUrl(window.location.href)) {
      return (await extractInstagramPost()) ||
        { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // YouTube: Defuddle parseAsync extracts transcript via InnerTube API (needs browser cookies).
    // Key: read result.variables.transcript (not contentMarkdown, which is an iframe embed).
    if (isVideoUrl(window.location.href)) {
      if (typeof Defuddle === "undefined") {
        return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
      }
      try {
        const result = await new Defuddle(document, { separateMarkdown: true }).parseAsync();
        return {
          title: result?.title || getMeta("og:title") || document.title || "",
          content: result?.variables?.transcript || "",
          html: "",
          byline: result?.author || null,
          excerpt: result?.description || getMeta("og:description") || "",
          embeddedVideos: extractEmbeddedVideoPreviews(),
        };
      } catch {
        return { title: getMeta("og:title") || document.title || "", content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
      }
    }

    // Other pages: use Defuddle
    if (typeof Defuddle === "undefined") {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }
    try {
      const result = await new Defuddle(document, {
        separateMarkdown: true,
      }).parseAsync();

      if (!result || !result.content) {
        return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
      }

      return {
        title: result.title || document.title,
        content: result.contentMarkdown || "",
        html: result.content || "",
        byline: result.author || null,
        excerpt: result.description || "",
        embeddedVideos: extractEmbeddedVideoPreviews(),
      };
    } catch {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
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

  function afterViewportPaint(callback) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      callback();
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(finish, 0);
      });
    });
    setTimeout(finish, 120);
  }

  function prepareViewportCapture(sendResponse) {
    // Hide every Mine-owned UI layer before background calls
    // captureVisibleTab. DOM mutations are not enough: Chrome can capture the
    // previous compositor frame, so we acknowledge only after a clean paint.
    if (window.__mineOverlay) {
      window.__mineOverlay.hide();
    }
    for (const host of document.querySelectorAll("[data-mine-clipper-overlay]")) {
      host.style.display = "none";
    }
    if (cropOverlayHost) {
      cropOverlayHost.style.visibility = "hidden";
    }
    if (cropToastHost) {
      cropToastHost.style.visibility = "hidden";
    }

    afterViewportPaint(() => sendResponse({ ok: true }));
  }

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
      if (payload.status === "done" && payload.dataUrl) {
        chrome.runtime.sendMessage(
          { target: "background", action: "cacheScreenshotUpload", dataUrl: payload.dataUrl },
          (resp) => {
            window.__mineOverlay.show();
            window.dispatchEvent(new CustomEvent("mine-crop-result", {
              detail: {
                dataUrl: payload.dataUrl,
                screenshotId: resp?.ok ? resp.screenshotId : null,
              },
            }));
          },
        );
        return;
      }
      window.__mineOverlay.show();
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
      selection.classList.remove("visible");
      sizeLabel.classList.remove("visible");
      dim.classList.remove("active");
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

  window.__mineCrop = {
    start: startCropOverlay,
  };

  // ── Message handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "prepareViewportCapture") {
      prepareViewportCapture(sendResponse);
      return true;
    }

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

    if (msg.action === "detectTwitterLightboxImage") {
      sendResponse(detectTwitterLightboxImage());
      return true;
    }

    return false;
  });

  // Detect Twitter/X lightbox overlay and extract the image URL.
  // Twitter renders the lightbox as a modal with role="dialog" (or a
  // layer with [data-testid="swipe-to-dismiss"]). Inside it, the main
  // image is either an <img> tag or a <div> with background-image.
  // Returns { src, width, height } or null if no lightbox is open.
  function detectTwitterLightboxImage() {
    if (!isTwitterUrl(window.location.href)) return null;

    // Strategy 1: look for <img> inside the lightbox dialog/layer
    const dialog = document.querySelector('[role="dialog"], [data-testid="swipe-to-dismiss"]');
    if (dialog) {
      // Find the largest <img> inside the dialog — that's the main image
      let best = null;
      let bestArea = 0;
      for (const img of dialog.querySelectorAll("img")) {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const area = w * h;
        if (area > bestArea && img.src && !img.src.includes("profile_images")) {
          bestArea = area;
          best = img;
        }
      }
      if (best) {
        return {
          src: best.src,
          alt: best.alt || null,
          width: best.naturalWidth || null,
          height: best.naturalHeight || null,
        };
      }
    }

    // Strategy 2: URL-based — Twitter photo URLs have /photo/ path
    const photoMatch = window.location.href.match(/\/status\/\d+\/photo\//);
    if (photoMatch) {
      // Find the largest visible <img> on the page (excluding avatars/icons)
      let best = null;
      let bestArea = 0;
      for (const img of document.querySelectorAll("img")) {
        if (!img.src || img.src.includes("profile_images") || img.src.includes("emoji")) continue;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const area = w * h;
        if (area > bestArea) {
          bestArea = area;
          best = img;
        }
      }
      if (best && bestArea > 10000) {
        return {
          src: best.src,
          alt: best.alt || null,
          width: best.naturalWidth || null,
          height: best.naturalHeight || null,
        };
      }
    }

    return null;
  }

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
    detectTwitterLightboxImage,
  };
})();
