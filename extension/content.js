// Content script: extracts page metadata and article content.
// Runs in the context of every page (document_idle).
// Responds to messages from the popup/background.
//
// Uses Defuddle (https://github.com/kepano/defuddle) for article extraction
// and Markdown conversion. Twitter/X threads use a specialized extractor.

/** @typedef {import("./popup/lib/messaging").ArticleData} ArticleData */
/** @typedef {import("./popup/lib/messaging").PageMetadata} PageMetadata */
/** @typedef {import("./popup/lib/messaging").CaptureDocument} CaptureDocument */
/** @typedef {import("./popup/lib/messaging").EmbeddedVideoPreview} EmbeddedVideoPreview */
/** @typedef {import("./popup/lib/messaging").TwitterLightboxResult} TwitterLightboxResult */
/** @typedef {import("./pageGlobals.types").PageImageInfo} PageImageInfo */
/** @typedef {import("./pageGlobals.types").MineContentHelpers} MineContentHelpers */
/** @typedef {import("./pageGlobals.types").MinePageCrop} MinePageCrop */
/** @typedef {import("./lib/xThread.types").XPostContent} XPostContent */
/** @typedef {import("./lib/xThread.types").XPostMedia} XPostMedia */
/** @typedef {import("./lib/twitterTweetContent.types").TweetContentParts} TweetContentParts */
/** @typedef {import("./lib/twitterTweetContent.types").TweetQuoteGroup} TweetQuoteGroup */
/** @typedef {import("./lib/twitterTweetContent.types").TweetQuoteText} TweetQuoteText */
/** @typedef {import("./lib/xLongformArticleExtraction.types").XLongformResult} XLongformResult */
/** @typedef {import("./lib/feedButtonSettings.types").FeedButtonSettings} FeedButtonSettings */
/** @typedef {import("./lib/youtubeSource.types").YoutubeSource} YoutubeSource */

/**
 * The metadata of the page before its type is detected.
 * @typedef {Omit<PageMetadata, "detectedType" | "isArticle">} PageMetadataDraft
 */

/**
 * A request this script answers: from background, or from the clipper
 * window through `chrome.tabs.sendMessage`.
 * @typedef {{ action: "startCropOverlay", cropId?: string | null }
 *   | { action: "getImageInfo", src: string }
 *   | { action: "prepareViewportCapture" | "finishViewportCapture" | "extractMetadata" | "extractArticle"
 *       | "extractArticleAsync" | "detectTwitterLightboxImage" }} ContentRequest
 */

/**
 * What background answers the requests of this script; each action fills
 * its own fields.
 * @typedef {object} BackgroundAnswer
 * @property {boolean} [ok]
 * @property {unknown} [data] `readXSyndication`: the service's answer for the post, as it came.
 * @property {XPostContent | null} [post] `readXPost`: the post as the page's feeds delivered it.
 * @property {string} [mode] `showOverlayInThisTab`, `restoreOpenClip`: how the clipper opens.
 * @property {string} [error]
 */

/**
 * The author chain background collects from the page's own world.
 * @typedef {object} CollectedThread
 * @property {XPostContent[]} [posts]
 * @property {string[]} [issues]
 */

/**
 * One medium of a post in X's syndication answer; only the fields read here.
 * @typedef {object} XSyndicationMedia
 * @property {string} [type] `photo`, `video` or `animated_gif`.
 * @property {string} [media_url_https] The picture, or the poster of a video.
 * @property {string} [url] The short link the post's text carries for the medium.
 * @property {{ variants?: XSyndicationVariant[] }} [video_info]
 */

/**
 * @typedef {object} XSyndicationVariant
 * @property {string} [content_type]
 * @property {number | null} [bitrate]
 * @property {string} url
 */

/**
 * A post in X's syndication answer; only the fields read here.
 * @typedef {object} XSyndicationPost
 * @property {unknown} [text]
 * @property {unknown} [display_text_range]
 * @property {string} [id_str]
 * @property {{ screen_name?: string, name?: string }} [user]
 * @property {XSyndicationMedia[]} [mediaDetails]
 * @property {XSyndicationPost} [quoted_tweet]
 */

/**
 * A medium read from the syndication answer.
 * @typedef {object} SyndicationMediaEntry
 * @property {"image" | "video"} kind
 * @property {string} url
 * @property {string | null} poster
 * @property {string | null} shortUrl The short link to strip from the post's text.
 * @property {string} [mediaType] The syndication type of a video: `video` or `animated_gif`.
 */

/**
 * A quoted post: as the card shows it, or as syndication gives it with the
 * details of its media.
 * @typedef {TweetQuoteGroup & { mediaDetails?: SyndicationMediaEntry[] }} QuotedPost
 */

/**
 * The post's syndication reading: its media, its quote and its text.
 * @typedef {object} TweetDetails
 * @property {SyndicationMediaEntry[]} mediaDetails
 * @property {QuotedPost | null} quotedTweet
 * @property {string} text
 */

/**
 * A service entry of a DID document; only the fields read here.
 * @typedef {object} DidService
 * @property {string} [type]
 * @property {string} [id]
 * @property {string} [serviceEndpoint]
 */

/**
 * An embed of a Bluesky post: pictures, or a video's playlist and poster.
 * @typedef {object} BlueskyEmbed
 * @property {{ fullsize?: string }[]} [images]
 * @property {string} [playlist]
 * @property {string} [thumbnail]
 * @property {string} [cid]
 * @property {BlueskyEmbed} [media] The post's own media when it also quotes a post.
 */

/**
 * A post of Bluesky's `getPostThread` answer; only the fields read here.
 * @typedef {object} BlueskyPost
 * @property {{ text?: string }} [record]
 * @property {{ handle?: string }} [author]
 * @property {BlueskyEmbed} [embed]
 */

/**
 * A medium of Instagram's media info answer.
 * @typedef {object} InstagramMediaItem
 * @property {{ text?: string } | null} [caption]
 * @property {{ username?: string }} [user]
 * @property {InstagramMediaItem[]} [carousel_media] The slides of a carousel.
 * @property {{ candidates?: { url: string }[] }} [image_versions2]
 * @property {{ url: string }[]} [video_versions]
 */

/**
 * A medium of a post, as Bluesky and Instagram posts list them here.
 * @typedef {object} PostMediaEntry
 * @property {"image" | "video"} kind
 * @property {string} url
 * @property {string | null} [poster]
 */

/**
 * The clip a Mine button of a feed opens the clipper with.
 * @typedef {{ metadata: PageMetadata, article: ArticleData }} PreloadedClip
 */

/**
 * The crop under way: the clipper's name for it, and how its clipper
 * cancels it.
 * @typedef {object} ActiveCrop
 * @property {string | null} id
 * @property {() => void} cancel
 */

/**
 * The crop's result for the clipper.
 * @typedef {{ status: "done", dataUrl: string } | { status: "cancelled", error?: string }} CropResult
 */

(() => {
  "use strict";

  // ── One content script per page (SPEC_CLIPPER.md, К4) ───────────────────
  //
  // A reload or an update of the extension leaves this script running in the
  // pages it was put in, cut off from the extension: its buttons, observers
  // and listeners stay, and nothing it sends arrives. The worker of the new
  // build puts a new content script into every open page, in a world of its
  // own, or in this one when the page got both at once. The new script tells
  // the page first; this one then takes its buttons and observers away and
  // stops answering. Cut off with no successor, it gives the page up at the
  // first press of its buttons.
  const CONTENT_SCRIPT_STARTED = "mine-content-script-started";
  const contentScript = {};
  const extensionAtStart = extensionNow();
  /** @type {(() => void)[]} */
  const stopsOnRetire = [];
  let retired = false;

  /// The extension this script's runtime names: none once the extension
  /// that put it here reloaded or went.
  function extensionNow() {
    try {
      return chrome.runtime?.id;
    } catch {
      return undefined;
    }
  }

  /// `stop` takes something of this script off the page when it retires.
  /** @param {() => void} stop */
  function onRetire(stop) {
    stopsOnRetire.push(stop);
  }

  function retire() {
    if (retired) return;
    retired = true;
    document.removeEventListener(CONTENT_SCRIPT_STARTED, retireIfReplaced);
    for (const stop of stopsOnRetire.splice(0).reverse()) {
      try {
        stop();
      } catch (error) {
        console.warn("[Mine] a part of the previous content script stayed:", error);
      }
    }
  }

  /// Give the page up when this script no longer belongs to the running
  /// extension: its runtime was cut off, or a later content script took the
  /// page over in this script's world. A page dispatching the event cannot
  /// make a current script retire. Returns whether this script is retired.
  function retireIfReplaced() {
    if (!retired && (extensionNow() !== extensionAtStart || window.__mineContentScript !== contentScript)) retire();
    return retired;
  }

  window.__mineContentScript = contentScript;
  document.dispatchEvent(new window.Event(CONTENT_SCRIPT_STARTED));
  document.addEventListener(CONTENT_SCRIPT_STARTED, retireIfReplaced);

  const captureInstanceId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  let navigationEpoch = 0;
  let observedDocumentUrl = window.location.href;
  function invalidateCaptureDocument() {
    navigationEpoch += 1;
    observedDocumentUrl = window.location.href;
  }
  const NAVIGATION_EVENTS = ["popstate", "hashchange", "yt-navigate-start"];
  for (const event of NAVIGATION_EVENTS) {
    window.addEventListener(event, invalidateCaptureDocument);
  }
  window.navigation?.addEventListener("navigate", invalidateCaptureDocument);
  onRetire(() => {
    for (const event of NAVIGATION_EVENTS) window.removeEventListener(event, invalidateCaptureDocument);
    window.navigation?.removeEventListener("navigate", invalidateCaptureDocument);
  });

  function captureDocumentSnapshot() {
    if (observedDocumentUrl !== window.location.href) invalidateCaptureDocument();
    return Object.freeze({
      documentUrl: window.location.href,
      captureGeneration: `${captureInstanceId}:${navigationEpoch}`,
    });
  }

  /** @param {CaptureDocument} snapshot */
  function assertCaptureDocument(snapshot) {
    const current = captureDocumentSnapshot();
    if (current.documentUrl !== snapshot.documentUrl || current.captureGeneration !== snapshot.captureGeneration) {
      throw new Error("Capture document changed");
    }
  }

  /**
   * @param {unknown} url
   * @returns {YoutubeSource | null}
   */
  function youtubeSource(url) {
    return globalThis.MineYoutubeSource?.parse(url) || null;
  }

  // ── Metadata extraction ─────────────────────────────────────────────────

  /** @param {string} name */
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

  // Metadata is only a candidate source, never authority over a concrete post.
  /** @param {string} pageUrl */
  function capturePageSource(pageUrl) {
    const youtube = youtubeSource(pageUrl);
    if (youtube) return youtube.sourceUrl;
    const page = new URL(pageUrl);
    // X, X Pro and Twitter by one rule (SPEC_DEEP_AUDIT.md, Е3.15).
    const post = xPostAddress(pageUrl);
    if (post) return `https://x.com/${post.handle}/status/${post.id}`;
    if (page.hostname === "bsky.app" && /^\/profile\/[^/]+\/post\/[^/]+/.test(page.pathname)) {
      return `${page.origin}${page.pathname.replace(/\/$/, "")}`;
    }
    if (/^(www\.)?instagram\.com$/.test(page.hostname) && /^\/(p|reel)\/[^/]+/.test(page.pathname)) {
      return `${page.origin}${page.pathname}`;
    }
    for (const candidate of [getCanonicalUrl(), getMeta("og:url")]) {
      if (!candidate?.trim()) continue;
      try {
        const source = new URL(candidate, pageUrl);
        if (!/^https?:$/.test(source.protocol)) continue;
        if (source.pathname === "/" && page.pathname !== "/") continue;
        return source.href;
      } catch { /* Invalid metadata cannot replace the document address. */ }
    }
    return pageUrl;
  }

  function getFavicon() {
    const link =
      document.querySelector('link[rel="icon"]') ||
      document.querySelector('link[rel="shortcut icon"]');
    if (link) return link.getAttribute("href");
    return "/favicon.ico";
  }

  /**
   * A YouTube page poster belongs to its current address, regardless of stale metadata.
   * @param {string | null} imageUrl
   * @param {string} pageUrl
   */
  function upgradeYoutubeThumbnail(imageUrl, pageUrl) {
    return youtubeSource(pageUrl)?.posterUrl || imageUrl || null;
  }

  /**
   * @param {string | null | undefined} url
   * @returns {string | null}
   */
  function absoluteUrl(url) {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  const MINE_OWNED_NODE_SELECTOR = "[data-mine-clipper-overlay], [data-la-clip], [data-mine-x-post]";

  /** @param {ParentNode | null | undefined} root */
  function removeMineOwnedNodes(root) {
    if (!root?.querySelectorAll) return;
    for (const node of root.querySelectorAll(MINE_OWNED_NODE_SELECTOR)) {
      node.remove();
    }
  }

  function createExtractionDocument() {
    // A deep clone of a document is a document; `cloneNode` is declared on
    // Node and answers Node for every kind of node.
    const clonedDocument = /** @type {Document} */ (document.cloneNode(true));
    removeMineOwnedNodes(clonedDocument);
    rootSanitizeExtractionDocument(clonedDocument);

    const head = clonedDocument.querySelector?.("head");
    if (head && !clonedDocument.querySelector("base[href]")) {
      const base = clonedDocument.createElement("base");
      base.setAttribute("href", document.baseURI);
      head.prepend(base);
    }

    return clonedDocument;
  }

  /** @param {Document} extractionDocument */
  function rootSanitizeExtractionDocument(extractionDocument) {
    const sanitizer = globalThis.MineExtractionDocumentSanitizer;
    if (!sanitizer?.sanitizeExtractionDocument) return;
    sanitizer.sanitizeExtractionDocument(extractionDocument);
  }

  function extractionBodyText() {
    const extractionDocument = createExtractionDocument();
    const body = extractionDocument.body;
    if (!body) return "";
    return body.innerText || body.textContent || "";
  }

  /** @param {string | null | undefined} url */
  function youtubeIdFromUrl(url) {
    return youtubeSource(absoluteUrl(url))?.videoId || null;
  }

  /** @param {string | null | undefined} url */
  function youtubePosterFromUrl(url) {
    const id = youtubeIdFromUrl(url);
    return id ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null;
  }

  /**
   * @param {EmbeddedVideoPreview[]} out
   * @param {EmbeddedVideoPreview | null | undefined} video
   */
  function pushUniqueVideo(out, video) {
    if (!video || (!video.src && !video.poster)) return;
    const key = video.src || video.poster;
    if (out.some((item) => (item.src || item.poster) === key)) return;
    out.push(video);
  }

  /** @param {string | null | undefined} url */
  function isInlineVideoUrl(url) {
    return /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(url || "");
  }

  /**
   * @param {EmbeddedVideoPreview[]} out
   * @param {string | null | undefined} src
   * @param {string | null | undefined} poster
   * @param {string} title
   */
  function pushVideoUrlPreview(out, src, poster, title) {
    const absoluteSrc = absoluteUrl(src);
    if (!absoluteSrc || !isInlineVideoUrl(absoluteSrc)) return;
    pushUniqueVideo(out, {
      src: absoluteSrc,
      poster: absoluteUrl(poster) || getMeta("og:image") || getMeta("twitter:image") || null,
      title: title || "",
    });
  }

  /** @type {Promise<boolean> | null} */
  let defuddleLoadPromise = null;

  /** @returns {Promise<boolean>} */
  async function ensureDefuddleLoaded() {
    if (typeof Defuddle !== "undefined") return true;
    if (defuddleLoadPromise) return defuddleLoadPromise;

    defuddleLoadPromise = new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
        resolve(false);
        return;
      }
      chrome.runtime.sendMessage(
        { target: "background", action: "ensureDefuddle" },
        (/** @type {BackgroundAnswer | undefined} */ response) => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(Boolean(response?.ok) && typeof Defuddle !== "undefined");
        },
      );
    });

    const loaded = await defuddleLoadPromise;
    if (!loaded) defuddleLoadPromise = null;
    return loaded;
  }

  /// `scope`: the post the clip is of, when the page shows many (an X feed).
  /**
   * @param {ParentNode | null} [scope]
   * @returns {EmbeddedVideoPreview[]}
   */
  function extractEmbeddedVideoPreviews(scope = null) {
    const youtube = youtubeSource(window.location.href);
    if (youtube) return [{ src: youtube.embedUrl, poster: youtube.posterUrl, title: document.title }];
    const root = scope || document.querySelector("article") || document.body;
    if (!root) return [];

    /** @type {EmbeddedVideoPreview[]} */
    const out = [];
    for (const video of root.querySelectorAll("video")) {
      const rawSrc = absoluteUrl(
        video.currentSrc ||
        video.getAttribute("src") ||
        video.querySelector("source[src]")?.getAttribute("src"),
      );
      // Player-runtime sources (blob:/mediasource:) are useless to the clipper:
      // they cannot be re-fetched, saved, or keyed against a canonical embed
      // URL, so on a page like YouTube the DOM player's blob <video> would push a
      // duplicate preview that the markdown-body embed (canonical URL) cannot
      // dedup against. Treat them as no source and fall back to the poster.
      const src = rawSrc && /^(blob|mediasource):/i.test(rawSrc) ? null : rawSrc;
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
      if (!isVideoUrl(src)) continue;
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

  /** @param {HTMLVideoElement | null} video */
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

  /**
   * @param {HTMLVideoElement | null} video
   * @returns {Promise<string | null>}
   */
  function captureVideoFrameDataUrl(video, timeoutMs = 350) {
    if (!video) return Promise.resolve(null);
    const readyFrame = drawVideoFrameDataUrl(video);
    if (readyFrame) return Promise.resolve(readyFrame);
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let done = false;
      /** @param {string | null} value */
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

  /**
   * @param {string | null | undefined} src
   * @returns {Promise<string | null>}
   */
  function captureVideoUrlFrameDataUrl(src, targetTime = 0.2, timeoutMs = 650) {
    const absoluteSrc = absoluteUrl(src);
    if (!absoluteSrc || !isInlineVideoUrl(absoluteSrc)) return Promise.resolve(null);

    return new Promise((resolve) => {
      const video = document.createElement("video");
      let done = false;
      let waitingForSeek = false;
      /** @param {string | null} value */
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

  /**
   * @param {Element | null} article
   * @param {SyndicationMediaEntry[] | null} videoMedia
   * @returns {Promise<(string | null)[]>}
   */
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
      const currentTime = domVideo && Number.isFinite(domVideo.currentTime) ? domVideo.currentTime : 0.2;
      return captureVideoUrlFrameDataUrl(candidate.url, currentTime);
    }));
    return posters;
  }

  /** @returns {PageMetadataDraft} */
  function extractMetadata() {
    const snapshot = captureDocumentSnapshot();
    const sel = window.getSelection();
    // `getSelection` answers null only for a document without a browsing
    // context: nothing is selected there.
    const selectionText = sel ? sel.toString().trim() : "";

    const pageUrl = snapshot.documentUrl;
    let title = youtubeSource(pageUrl) ? document.title || ""
      : getMeta("og:title") || getMeta("twitter:title") || document.title || "";
    let author = getMeta("author") || getMeta("article:author") || null;

    // Twitter/X: author from URL, title left as og:title (overridden by extractTwitterThread later)
    const xPost = xPostAddress(pageUrl);
    if (xPost) author = `@${xPost.handle}`;

    return {
      url: capturePageSource(pageUrl),
      documentUrl: pageUrl,
      captureGeneration: snapshot.captureGeneration,
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
      bodyText: extractionBodyText().slice(0, 2000),
    };
  }

  /**
   * The metadata of the page with its type detected.
   * @returns {PageMetadata}
   */
  function extractDetectedMetadata() {
    const meta = extractMetadata();
    const detectedType = detectType(meta);
    return { ...meta, detectedType, isArticle: isArticlePage(meta) };
  }

  // ── Auto-detection heuristic ────────────────────────────────────────────

  /** @param {string} url */
  function isVideoUrl(url) {
    if (youtubeSource(url)) return true;
    try {
      const parsed = new URL(url);
      return ["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(parsed.hostname)
        && /^https?:$/.test(parsed.protocol) && parsed.pathname !== "/";
    } catch { return false; }
  }

  /** @param {PageMetadataDraft} meta */
  function isArticlePage(meta) {
    let signals = 0;
    if (document.querySelector("article")) signals++;
    if (meta.ogType === "article") signals++;
    const bodyText = extractionBodyText();
    if (bodyText.length > 2000) signals++;
    return signals >= 2;
  }

  /** @param {PageMetadataDraft} meta */
  function detectType(meta) {
    // Selection takes priority
    if (meta.selection.length > 0) return "selection";
    // Video pages
    if (isVideoUrl(meta.url)) return "video";
    // Twitter threads — always save as article
    if (isTwitterUrl(meta.url)) return "article";
    // Bluesky posts — always save as article
    if (isBlueskyPostUrl(meta.url)) return "article";
    // Instagram posts — always save as article
    if (isInstagramPostUrl(meta.url)) return "article";
    // Article pages
    if (isArticlePage(meta)) return "article";
    // Default
    return "link";
  }

  // ── Twitter/X thread extraction ──────────────────────────────────────────

  /// The post an address of X names, by the one rule of lib/xThread.js: a
  /// host that merely ends in "x.com" is not X (SPEC_DEEP_AUDIT.md, Е3.15).
  /** @param {string | null | undefined} url */
  function xPostAddress(url) {
    return globalThis.MineXThread?.postAddress?.(url) ?? null;
  }

  /** @param {string | null | undefined} url */
  function isTwitterUrl(url) {
    return xPostAddress(url) !== null;
  }

  /**
   * @param {Element} article
   * @returns {TweetContentParts}
   */
  function extractTweetContentParts(article) {
    return window.MineTwitterTweetContent?.extractTweetContentParts?.(article) || {
      mainText: "",
      media: [],
      hasVideo: false,
      quotes: [],
    };
  }

  /**
   * @param {string} mainText
   * @param {readonly TweetQuoteText[]} quotes
   */
  function composeTweetText(mainText, quotes) {
    return window.MineTwitterTweetContent?.composeTweetText?.(mainText, quotes) || String(mainText || "").trim();
  }

  /**
   * @param {string} domText
   * @param {string} apiText
   */
  function preferCompleteTweetText(domText, apiText) {
    return window.MineTweetTextCompletion?.preferCompleteTweetText?.(domText, apiText)
      ?? String(domText || "").trim();
  }

  /// The text a syndication answer shows, without the links of its media: a
  /// reply's leading mentions left out and what X escapes decoded
  /// (lib/xThread.js, SPEC_DEEP_AUDIT.md, Е3.6).
  /**
   * @param {XSyndicationPost} data
   * @param {readonly SyndicationMediaEntry[]} mediaDetails
   */
  function cleanSyndicationText(data, mediaDetails) {
    let cleaned = globalThis.MineXThread?.syndicationText?.(data) ?? String(data?.text || "");
    for (const media of mediaDetails || []) {
      if (media.shortUrl) cleaned = cleaned.replace(media.shortUrl, "");
    }
    return cleaned.trim();
  }

  /**
   * @param {XSyndicationMedia} media
   * @returns {SyndicationMediaEntry | null}
   */
  function syndicationMediaEntry(media) {
    if (media.type === "photo" && media.media_url_https) {
      return {
        kind: "image",
        url: media.media_url_https + "?name=large",
        poster: media.media_url_https,
        shortUrl: media.url || null,
      };
    }
    if (media.type === "video" || media.type === "animated_gif") {
      const variants = (media.video_info?.variants || [])
        .filter(
          /** @returns {variant is XSyndicationVariant & { bitrate: number }} */
          (variant) => variant.content_type === "video/mp4" && variant.bitrate != null)
        .sort((a, b) => b.bitrate - a.bitrate);
      const best = variants[0];
      if (best) {
        return {
          kind: "video",
          url: best.url,
          poster: media.media_url_https || null,
          mediaType: media.type,
          shortUrl: media.url || null,
        };
      }
    }
    return null;
  }

  /**
   * Fetch all media URLs from Twitter syndication API.
   * Returns array of direct URLs (photos, GIFs as MP4, videos as MP4 highest bitrate).
   * More reliable than DOM parsing — doesn't depend on lazy-loaded elements.
   * Background asks the service: it answers only https://platform.twitter.com,
   * so a request from this page fails on CORS (SPEC_CLIPPER.md, «Кнопка Mine
   * в ленте X», rule 6, 13.10.2026).
   */
  /**
   * @param {string} tweetId
   * @returns {Promise<TweetDetails>}
   */
  async function fetchTweetDetails(tweetId) {
    try {
      const reply = await askBackground({ action: "readXSyndication", tweetId: String(tweetId) });
      if (!reply?.ok || typeof reply.data !== "object" || reply.data === null) {
        return { mediaDetails: [], quotedTweet: null, text: "" };
      }
      // Background hands the service's JSON object over as it came. Every
      // field is read optionally, and a field of another shape throws into
      // the catch below, which answers no details.
      const data = /** @type {XSyndicationPost} */ (reply.data);
      /** @type {SyndicationMediaEntry[]} */
      const media = [];
      for (const m of (data.mediaDetails || [])) {
        const entry = syndicationMediaEntry(m);
        if (entry) media.push(entry);
      }

      /** @type {QuotedPost | null} */
      let quotedTweet = null;
      if (data.quoted_tweet) {
        /** @type {SyndicationMediaEntry[]} */
        const quoteMedia = [];
        for (const m of (data.quoted_tweet.mediaDetails || [])) {
          const entry = syndicationMediaEntry(m);
          if (entry) quoteMedia.push(entry);
        }
        const quoteText = cleanSyndicationText(data.quoted_tweet, quoteMedia);
        if (quoteText || quoteMedia.length > 0) {
          quotedTweet = {
            tweetId: data.quoted_tweet.id_str || null,
            handle: data.quoted_tweet.user?.screen_name || "",
            name: data.quoted_tweet.user?.name || "",
            text: quoteText,
            media: quoteMedia.map((entry) => entry.url),
            mediaDetails: quoteMedia,
          };
        }
      }

      return {
        mediaDetails: media,
        quotedTweet,
        text: cleanSyndicationText(data, media),
      };
    } catch {
      return { mediaDetails: [], quotedTweet: null, text: "" };
    }
  }

  /// The clip of collected X posts: the body every X path composes alike
  /// (SPEC_CLIPPER.md, «Пост с цитатой как в оригинале»).
  /**
   * @param {XPostContent[]} posts
   * @param {string} authorHandle
   * @returns {ArticleData}
   */
  function articleFromXPosts(posts, authorHandle) {
    const content = globalThis.MineXThread.compose(posts);
    /** @type {EmbeddedVideoPreview[]} */
    const embeddedVideos = [];
    for (const part of posts) {
      for (const media of [...part.media, ...(part.quote?.media || [])]) {
        if (media.kind === "video") pushVideoUrlPreview(embeddedVideos, media.url, media.poster, "Tweet video preview");
      }
    }
    // Every caller brings at least one post.
    const leadText = posts[0]?.text ?? "";
    const title = leadText.replace(/\n/g, " ").slice(0, 80) || `@${authorHandle}`;
    return { title, content, twitterPosts: posts, byline: `@${authorHandle}`, excerpt: leadText.slice(0, 200),
      embeddedVideos, threadPostCount: posts.length };
  }

  /** @returns {Promise<ArticleData | null>} */
  async function extractTwitterThread() {
    const url = window.location.href;

    // Extract author handle and tweet ID from URL
    const address = xPostAddress(url);
    if (!address) return null;
    const authorHandle = address.handle;
    const tweetId = address.id;

    /** @type {CollectedThread | null} */
    const snapshot = await new Promise(resolve => {
      chrome.runtime.sendMessage({ target: "background", action: "collectXThread", tweetId },
        (/** @type {CollectedThread | undefined} */ result) => {
          resolve(chrome.runtime.lastError ? null : result ?? null);
        });
    });
    if (window.location.href !== url) return null;
    if (snapshot?.posts?.length) {
      return { ...articleFromXPosts(snapshot.posts, authorHandle), threadWarning: snapshot.issues?.join(" ") || undefined };
    }
    // Keep a single-post preview when a page predates the observer. Never
    // silently claim that the old DOM window is a complete author thread.
    const threadWarning = snapshot?.issues?.join(" ") || "Thread data is unavailable. Reload this X page and retry.";

    const threadSelection = window.MineTwitterThreadSelection;
    const candidates = threadSelection?.selectTwitterThreadArticles?.({
      document,
      targetTweetId: tweetId,
      authorHandle,
    }) || [];
    const targetArticle = candidates.find(article => threadSelection?.getTweetIdentity?.(article)?.tweetId === tweetId);
    if (!targetArticle) return { title: document.title, content: "", byline: null, excerpt: "", threadWarning };
    const post = await extractTwitterPostFromArticle(targetArticle, tweetId, authorHandle, { postUrl: window.location.href });
    return post && { ...post, threadWarning };
  }

  /// One X post from its card in the page and the syndication API: the
  /// fallback of a post page without collected thread data, and of a feed
  /// post its page's feeds did not deliver. `postUrl` is the post's address;
  /// `videoScope` narrows the page-wide video scan to this card. With
  /// `requireApi` the card alone is not enough (SPEC_CLIPPER.md, «Кнопка Mine
  /// в ленте X», rule 6): a feed cuts long text and keeps video behind `blob:`.
  /**
   * @param {Element} targetArticle
   * @param {string} tweetId
   * @param {string} authorHandle
   * @param {object} options
   * @param {string} options.postUrl
   * @param {ParentNode | null} [options.videoScope]
   * @param {boolean} [options.requireApi]
   * @returns {Promise<ArticleData | null>}
   */
  async function extractTwitterPostFromArticle(targetArticle, tweetId, authorHandle, { postUrl, videoScope = null, requireApi = false }) {
    // Fetch media from syndication API (includes videos that DOM can't capture).
    // Quote tweets stay inside the parent tweet body; they are not thread items.
    const tweetDetails = await fetchTweetDetails(tweetId);
    const apiMediaDetails = tweetDetails.mediaDetails;
    const apiQuotedTweet = tweetDetails.quotedTweet;
    const apiTargetText = tweetDetails.text || "";
    if (requireApi && !apiTargetText && apiMediaDetails.length === 0 && !apiQuotedTweet) return null;
    const apiMedia = apiMediaDetails.map((m) => m.url);

    const contentParts = extractTweetContentParts(targetArticle);
    // Prefer API media (complete — photos + GIFs + videos).
    // Fallback to DOM media if API returned nothing.
    const finalMedia = apiMedia.length > 0 ? apiMedia : contentParts.media;
    /** @type {QuotedPost[]} */
    const quotes = apiQuotedTweet ? [apiQuotedTweet] : contentParts.quotes;
    // X collapses a long post behind "Show more" and keeps only the visible
    // half in the markup, so DOM text can stop mid-word. The syndication API
    // answers with the whole post.
    const mainText = preferCompleteTweetText(contentParts.mainText, apiTargetText);
    const text = composeTweetText(mainText, quotes);
    if (!text && finalMedia.length === 0 && !contentParts.hasVideo && !quotes.some(quote => quote.hasVideo)) return null;
    const target = { text, mainText, quotes, media: finalMedia, hasVideo: contentParts.hasVideo };
    const tweets = [target];

    // For X/Twitter animated media, the API thumbnail can differ from the
    // actual frame the user sees in the page. Prefer a preview-only snapshot
    // from the visible tweet <video>; never change the saved video URL/body.
    const capturedPosters = await captureArticleVideoPosters(
      targetArticle,
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

    const firstText = (target.text || "").replace(/\n/g, " ").trim();
    const tweetTitle = firstText.slice(0, 80) || `@${authorHandle}`;
    /** @type {EmbeddedVideoPreview[]} */
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
    for (const media of apiQuotedTweet?.mediaDetails || []) {
      if (media.kind === "video") {
        pushVideoUrlPreview(embeddedVideos, media.url, media.poster, "Tweet video preview");
      }
    }
    // Twitter/X pages keep extra player <video> nodes in the DOM, often as
    // blob URLs with generic page posters. If the social/API path already
    // produced a direct mp4 + tweet_video_thumb poster, generic DOM fallback
    // would only add noisy duplicates to the popup preview.
    if (embeddedVideos.length === 0) {
      for (const video of extractEmbeddedVideoPreviews(videoScope)) {
        pushUniqueVideo(embeddedVideos, video);
      }
    }

    // A player in the page with nothing resolvable behind it means the tweet
    // has video the anonymous paths cannot see: the API answers with a
    // tombstone for age-restricted posts, and the DOM only carries a `blob:`
    // URL. Flag it so the save path can ask the authenticated route.
    const hasPlayerInPage = !!target.hasVideo;
    // A preview entry with no `src` is exactly the case this path exists for:
    // the player runs off a blob: URL, so the entry carries a poster and
    // nothing fetchable. Counting entries would treat that as resolved.
    const hasResolvedVideo =
      embeddedVideos.some((video) => !!video.src)
      || apiMediaDetails.some((media) => media.kind === "video");
    const needsAuthenticatedVideo = hasPlayerInPage && !hasResolvedVideo;

    // A single quote with its own post id stands as the post's quote; the
    // post's text is then its own, without the quote's blockquote.
    const onlyQuote = target.quotes.length === 1 ? target.quotes[0] : undefined;
    /** @type {(urls: readonly string[], details?: readonly SyndicationMediaEntry[]) => XPostMedia[]} */
    const structuredMedia = (urls, details = []) => urls.map(src => ({ url: src,
      kind: isInlineVideoUrl(src) ? "video" : "image",
      poster: details.find(media => media.url === src)?.poster || null }));
    /** @type {XPostContent | null} */
    const quote = onlyQuote?.tweetId
      ? { id: onlyQuote.tweetId, handle: onlyQuote.handle || "", name: onlyQuote.name || "", text: onlyQuote.text,
        media: structuredMedia(onlyQuote.media || [], onlyQuote.mediaDetails), hasVideo: !!onlyQuote.hasVideo }
      : null;
    /** @type {XPostContent[]} */
    const twitterPosts = [{ id: tweetId, text: quote ? target.mainText : target.text,
      media: structuredMedia(target.media || [], apiMediaDetails),
      hasVideo: hasPlayerInPage,
      quote }];
    return {
      title: tweetTitle,
      twitterPosts,
      threadPostCount: 1,
      // The same composer as the collected thread: the post's text and media
      // first, then the quote block with its author (SPEC_CLIPPER.md).
      content: globalThis.MineXThread.compose(twitterPosts),
      byline: `@${authorHandle}`,
      excerpt: firstText.slice(0, 200),
      embeddedVideos,
      needsAuthenticatedVideo,
      tweetUrl: needsAuthenticatedVideo ? postUrl : undefined,
      tweetId: needsAuthenticatedVideo ? tweetId : undefined,
    };
  }

  /** @returns {XLongformResult | null} */
  function extractXLongformArticle() {
    const extractor = window.MineXLongformArticleExtraction;
    if (!extractor?.extractXLongformArticle) return null;
    const address = xPostAddress(window.location.href);
    const fallbackByline = address ? `@${address.handle}` : null;
    return extractor.extractXLongformArticle({
      document,
      locationHref: window.location.href,
      fallbackTitle: getMeta("og:title") || getMeta("twitter:title") || document.title || "",
      fallbackByline,
    });
  }


  // ── Bluesky post extraction ────────────────────────────────────────────

  /** @param {string | null | undefined} url */
  function isBlueskyPostUrl(url) {
    return /(?:^|\/\/)(?:[\w.-]*\.)?bsky\.app\/profile\/[^/]+\/post\/[\w]+/i.test(url ?? "");
  }

  /// Split a Bluesky video playlist URL into the repository it lives in.
  ///
  /// The playlist path carries both halves of the blob's address —
  /// `/watch/<did>/<cid>/playlist.m3u8` — so it is preferred over the embed's
  /// own fields, which describe the view rather than the record.
  /** @param {unknown} playlist */
  function parseBlueskyPlaylist(playlist) {
    const match = String(playlist ?? "").match(
      /\/watch\/([^/]+)\/([^/]+)\/playlist\.m3u8/i,
    );
    const [, did, cid] = match ?? [];
    if (did === undefined || cid === undefined) return null;
    try {
      return { did: decodeURIComponent(did), cid: decodeURIComponent(cid) };
    } catch {
      return null;
    }
  }

  /// Find the personal data server holding a DID's repository.
  ///
  /// `did:plc` identifiers are looked up in the PLC directory; `did:web` ones
  /// resolve against the domain itself. Both return a DID document whose
  /// AT Protocol service entry names the host.
  /**
   * @param {string} did
   * @returns {Promise<string | null>}
   */
  async function resolveBlueskyPds(did) {
    let documentUrl;
    if (did.startsWith("did:plc:")) {
      documentUrl = `https://plc.directory/${encodeURIComponent(did)}`;
    } else if (did.startsWith("did:web:")) {
      const domain = decodeURIComponent(did.slice("did:web:".length)).replace(/:/g, "/");
      documentUrl = `https://${domain}/.well-known/did.json`;
    } else {
      return null;
    }

    const resp = await fetch(documentUrl);
    if (!resp.ok) return null;
    /** @type {unknown} */
    const services = (await resp.json())?.service;
    if (!Array.isArray(services)) return null;

    // The entries of a DID document's `service` list; every field is read
    // optionally and checked as a string below.
    const pds = /** @type {(DidService | null | undefined)[]} */ (services).find(
      (service) =>
        service?.type === "AtprotoPersonalDataServer" ||
        String(service?.id ?? "").endsWith("#atproto_pds"),
    );
    const endpoint = String(pds?.serviceEndpoint ?? "");
    return endpoint.startsWith("https://") ? endpoint.replace(/\/+$/, "") : null;
  }

  /// Build a direct URL to a Bluesky video's original file.
  ///
  /// Returns null when the address cannot be determined, leaving the caller to
  /// fall back to the poster rather than emitting a link that would download a
  /// playlist instead of a video.
  /**
   * @param {BlueskyEmbed} embed
   * @param {string} authorDid
   * @returns {Promise<string | null>}
   */
  async function resolveBlueskyVideoBlobUrl(embed, authorDid) {
    const parsed = parseBlueskyPlaylist(embed?.playlist);
    const did = parsed?.did || authorDid;
    const cid = parsed?.cid || embed?.cid;
    if (!did || !cid) return null;

    try {
      const pds = await resolveBlueskyPds(did);
      if (!pds) return null;
      return `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
    } catch {
      return null;
    }
  }

  /// Extract a Bluesky post through the public AT Protocol API.
  ///
  /// Unlike the other social sources here, this needs no session and no
  /// scraping: `public.api.bsky.app` is a documented, unauthenticated interface
  /// that returns the post record with direct CDN links to its media. That also
  /// makes it stable — there is no private endpoint to break.
  /** @returns {Promise<ArticleData | null>} */
  async function extractBlueskyPost() {
    const match = window.location.href.match(
      /bsky\.app\/profile\/([^/]+)\/post\/([\w]+)/i,
    );
    const [, handleOrDid, rkey] = match ?? [];
    if (handleOrDid === undefined || rkey === undefined) return null;

    try {
      // A handle in the URL has to be resolved; a DID is already one.
      let did = handleOrDid;
      if (!did.startsWith("did:")) {
        const resolved = await fetch(
          `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handleOrDid)}`,
        );
        if (!resolved.ok) return null;
        /** @type {unknown} */
        const resolvedDid = (await resolved.json())?.did;
        if (typeof resolvedDid !== "string" || !resolvedDid) return null;
        did = resolvedDid;
      }

      const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
      const resp = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`,
      );
      if (!resp.ok) return null;

      // The post of Bluesky's `getPostThread` answer: every field is read
      // optionally, and a field of another shape throws into the catch below.
      /** @type {BlueskyPost | undefined} */
      const post = (await resp.json())?.thread?.post;
      if (!post) return null;

      const text = (post.record?.text || "").trim();
      const handle = post.author?.handle || handleOrDid;

      /** @type {PostMediaEntry[]} */
      const mediaEntries = [];
      /** @type {EmbeddedVideoPreview[]} */
      const embeddedVideos = [];
      // Media sits under one of a few embed shapes: when a post both quotes
      // another and carries media, its own media moves under `media`.
      const embeds = [post.embed, post.embed?.media].filter((embed) => !!embed);
      for (const embed of embeds) {
        for (const image of embed.images || []) {
          if (image.fullsize) mediaEntries.push({ kind: "image", url: image.fullsize });
        }
        if (embed.playlist || embed.thumbnail) {
          // The playlist is HLS and cannot be saved as a file, but it is only a
          // streaming derivative: the uploaded file itself is a blob in the
          // author's repository, addressable by content hash and served whole.
          const blob = await resolveBlueskyVideoBlobUrl(embed, did);
          if (blob) {
            mediaEntries.push({ kind: "video", url: blob });
            // Registered directly rather than through pushVideoUrlPreview,
            // which admits a source only if its URL ends in a video extension.
            // A blob URL names a method and a hash, never a file type — but
            // here the embed already told us this is video.
            pushUniqueVideo(embeddedVideos, {
              src: blob,
              poster: embed.thumbnail || null,
              title: "Bluesky video",
            });
          } else if (embed.thumbnail) {
            // No repository to read the blob from — keep the poster so the post
            // still carries something visual.
            mediaEntries.push({ kind: "image", url: embed.thumbnail });
          }
        }
      }

      /** @type {string[]} */
      const parts = [];
      if (text) parts.push(text);
      for (const entry of mediaEntries) parts.push(`![](${entry.url})`);
      if (parts.length === 0) return null;

      return {
        title: text.replace(/\n/g, " ").trim().slice(0, 80) || `@${handle}`,
        content: parts.join("\n\n"),
        byline: `@${handle}`,
        excerpt: text.slice(0, 200),
        embeddedVideos,
      };
    } catch {
      return null;
    }
  }

  // ── Instagram post extraction ──────────────────────────────────────────

  /** @param {string} url */
  function isInstagramPostUrl(url) {
    const lc = url.toLowerCase();
    return lc.includes("instagram.com/p/") || lc.includes("instagram.com/reel/") || lc.includes("instagram.com/stories/");
  }

  /** @param {string} url */
  function extractInstagramShortcode(url) {
    const match = url.match(/instagram\.com\/(?:p|reel)\/([\w-]+)/);
    return match?.[1] ?? null;
  }

  /**
   * Convert Instagram shortcode to numeric media ID.
   * Shortcodes are base64-encoded (custom alphabet) media IDs.
   */
  /** @param {string} shortcode */
  function shortcodeToMediaId(shortcode) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = BigInt(0);
    for (const char of shortcode) {
      id = id * BigInt(64) + BigInt(alphabet.indexOf(char));
    }
    return id.toString();
  }

  /// The pictures and videos of an Instagram medium, a carousel's slides in
  /// order, each with its poster.
  /**
   * @param {InstagramMediaItem} item
   * @returns {PostMediaEntry[]}
   */
  function instagramMediaEntries(item) {
    /** @type {PostMediaEntry[]} */
    const mediaEntries = [];
    const carousel = item.carousel_media || [];
    for (const slide of carousel.length > 0 ? carousel : [item]) {
      const poster = slide.image_versions2?.candidates?.[0]?.url || null;
      const video = slide.video_versions?.[0];
      const image = slide.image_versions2?.candidates?.[0];
      if (video) {
        mediaEntries.push({ kind: "video", url: video.url, poster });
      } else if (image) {
        mediaEntries.push({ kind: "image", url: image.url, poster });
      }
    }
    return mediaEntries;
  }

  /** @returns {Promise<ArticleData | null>} */
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
      // Instagram's media info answer: every field is read optionally, and a
      // field of another shape throws into the catch below.
      /** @type {{ items?: InstagramMediaItem[] }} */
      const json = await resp.json();

      const item = (json.items || [])[0];
      if (!item) return null;

      // Caption
      const caption = item.caption?.text || "";

      // Author
      const author = item.user?.username || "";

      // Media URLs (carousel or single)
      const mediaEntries = instagramMediaEntries(item);
      const mediaUrls = mediaEntries.map((entry) => entry.url);

      // Build markdown body
      /** @type {string[]} */
      const parts = [];
      if (caption) parts.push(caption);
      for (const url of mediaUrls) {
        parts.push(`![](${url})`);
      }

      const titleText = caption.replace(/\n/g, " ").trim().slice(0, 80) || `@${author}`;
      /** @type {EmbeddedVideoPreview[]} */
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

  // ── The switches of the Mine buttons (SPEC_CLIPPER.md, Р11) ─────────────

  /// Keeps a page's Mine buttons with their switch in the clipper's "…" menu:
  /// on and off at once, without a reload. `start` puts the buttons on the
  /// page and returns the function that stops them and takes them away. They
  /// go for good when this content script retires (К4).
  /**
   * @param {keyof FeedButtonSettings} key
   * @param {() => () => void} start
   */
  function followFeedButtonSetting(key, start) {
    const settings = window.MineFeedButtonSettings;
    /** @type {(() => void) | null} */
    let stop = null;
    let ended = false;
    /** @param {boolean} enabled */
    const apply = (enabled) => {
      if (ended) return;
      if (enabled && !stop) stop = start();
      else if (!enabled && stop) {
        stop();
        stop = null;
      }
    };
    /** @type {(() => void) | null} */
    let unwatch = null;
    onRetire(() => {
      ended = true;
      try {
        unwatch?.();
      } catch {
        // The storage of a cut-off script may refuse even this.
      }
      stop?.();
      stop = null;
    });
    let storage = null;
    try {
      storage = chrome.storage?.local && chrome.storage.onChanged ? chrome.storage : null;
    } catch {
      // A context the browser has torn down refuses storage: the buttons stay
      // on, as they were before the switches existed.
    }
    if (!settings || !storage) {
      apply(true);
      return;
    }
    unwatch = settings.watch(storage, (value) => apply(value[key]));
    void settings.read(storage.local).then((value) => apply(value[key]));
  }

  // ── Instagram feed clip button ─────────────────────────────────────────

  // Instagram is a single-page app: new posts are looked for this often.
  const INSTAGRAM_SCAN_INTERVAL_MS = 500;

  function initInstagramFeedButton() {
    if (!window.location.hostname.includes("instagram.com")) return;

    const BUTTON_ATTR = "data-la-clip";
    const BUTTON_VERSION = "3";
    const INSTAGRAM_POST_UNAVAILABLE = "Mine couldn't read this Instagram post. Save it as Screenshot or Link.";

    /** @param {Element} article */
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
      btn.setAttribute("data-la-clip-version", BUTTON_VERSION);
      btn.title = "Save to Mine";
      Object.assign(btn.style, {
        position: "absolute",
        top: "62px",
        right: "12px",
        zIndex: "10",
        width: "34px",
        height: "34px",
        borderRadius: "50%",
        background: "rgba(255,255,255,0.92)",
        border: "2px solid #ffffff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.28)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: "1",
        padding: "0",
      });
      const icon = document.createElement("img");
      icon.src = chrome.runtime.getURL("icons/clipper-overlay-32.png");
      icon.alt = "";
      Object.assign(icon.style, {
        width: "28px",
        height: "28px",
        display: "block",
      });
      btn.appendChild(icon);
      return btn;
    }

    /// The clipper opens for the post, read through Instagram's API, or with
    /// the reason it could not be read; a clipper that does not open says why
    /// on the button. Nothing fails only in the console (SPEC_DEEP_AUDIT.md,
    /// Е3.16, the way of the X button, SPEC_CLIPPER.md, «Кнопка Mine в ленте
    /// X», rule 7).
    /**
     * @param {string} shortcode
     * @param {HTMLButtonElement} btn
     */
    async function clipPost(shortcode, btn) {
      btn.style.opacity = "0.5";
      btn.style.pointerEvents = "none";
      const postUrl = `https://www.instagram.com/p/${shortcode}/`;
      let preloadData;
      try {
        preloadData = await readInstagramPost(shortcode, postUrl);
      } catch (e) {
        console.warn("[Mine] Instagram post unavailable:", e);
        preloadData = instagramPostUnavailable(postUrl);
      }
      /** @type {BackgroundAnswer | undefined} */
      let response;
      try {
        // The post read here travels with this opening only: background keeps
        // it for this tab, and the overlay that opens here reads it once.
        // Instagram preloads overlay.js as a static content script because
        // this page-injected button does not grant activeTab permission for
        // executeScript.
        response = await chrome.runtime.sendMessage({
          target: "background",
          action: "showOverlayInThisTab",
          pageUrl: window.location.href,
          preloaded: preloadData,
        });
      } catch (e) {
        response = { ok: false, error: String(errorMessage(e) ?? e) };
      }
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
      // `deferred`: the clipper opens after the extension's reload into the
      // build on disk (К4).
      if (response?.ok || response?.mode === "deferred") {
        btn.style.background = "rgba(255,255,255,0.92)";
        btn.title = "Save to Mine";
        return;
      }
      btn.style.background = "rgba(239,68,68,0.8)";
      btn.title = `Mine could not open: ${response?.error ?? "the extension did not answer"}`;
    }

    /**
     * @param {string} postUrl
     * @returns {PreloadedClip}
     */
    function instagramPostUnavailable(postUrl) {
      return {
        metadata: {
          url: postUrl, title: "", description: "", image: null, author: null, ogType: null, favicon: null,
          selection: "", detectedType: "article", isArticle: true,
        },
        article: { title: "", content: "", byline: null, excerpt: "", embeddedVideos: [], unavailableReason: INSTAGRAM_POST_UNAVAILABLE },
      };
    }

    /**
     * @param {string} shortcode
     * @param {string} postUrl
     * @returns {Promise<PreloadedClip>}
     */
    async function readInstagramPost(shortcode, postUrl) {
      const mediaId = shortcodeToMediaId(shortcode);
      const resp = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
        headers: { "X-IG-App-ID": "936619743392459" },
        credentials: "include",
      });
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      // Instagram's media info answer: every field is read optionally, and a
      // field of another shape throws to the caller, which reports the post
      // unavailable.
      /** @type {{ items?: InstagramMediaItem[] }} */
      const json = await resp.json();

      const item = (json.items || [])[0];
      if (!item) throw new Error("No items");

      const caption = item.caption?.text || "";
      const author = item.user?.username || "";

      const mediaEntries = instagramMediaEntries(item);
      const mediaUrls = mediaEntries.map((entry) => entry.url);
      /** @type {EmbeddedVideoPreview[]} */
      const embeddedVideos = [];
      for (const entry of mediaEntries) {
        if (entry.kind === "video") {
          pushVideoUrlPreview(embeddedVideos, entry.url, entry.poster, "Instagram video preview");
        }
      }

      /** @type {string[]} */
      const parts = [];
      if (caption) parts.push(caption);
      for (const url of mediaUrls) {
        parts.push(`![](${url})`);
      }

      const titleText = caption.replace(/\n/g, " ").trim().slice(0, 80) || `@${author}`;

      return {
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
    }

    // The buttons this script put. A button of the current version that
    // another content script put, one an extension reload cut off in this
    // page (К4), is replaced: that script's scan keeps any button of its
    // version, so it leaves this script's button alone.
    const ownButtons = new WeakSet();

    function scanArticles() {
      for (const article of document.querySelectorAll("article")) {
        const existing = article.querySelector(`[${BUTTON_ATTR}]`);
        if (existing && ownButtons.has(existing) && existing.getAttribute("data-la-clip-version") === BUTTON_VERSION) continue;
        existing?.remove();

        const shortcode = findShortcode(article);
        if (!shortcode) continue;

        if (getComputedStyle(article).position === "static") {
          article.style.position = "relative";
        }

        const btn = createClipButton();
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (retireIfReplaced()) return;
          clipPost(shortcode, btn);
        });

        ownButtons.add(btn);
        article.appendChild(btn);
      }
    }

    followFeedButtonSetting("instagram", () => {
      const timer = setInterval(scanArticles, INSTAGRAM_SCAN_INTERVAL_MS);
      scanArticles();
      return () => {
        clearInterval(timer);
        for (const button of document.querySelectorAll(`[${BUTTON_ATTR}]`)) if (ownButtons.has(button)) button.remove();
      };
    });
  }

  // Start Instagram feed button injection
  initInstagramFeedButton();

  // ── X feed Mine button (SPEC_CLIPPER.md, «Кнопка Mine в ленте X») ────────

  const X_POST_UNAVAILABLE = "Mine couldn't read this post here. Open the post and save it from its page.";

  /// One request to background; `null` when it does not answer, including
  /// an extension reloaded under the page.
  /**
   * @param {{ action: string } & Record<string, unknown>} message
   * @returns {Promise<BackgroundAnswer | null>}
   */
  function askBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ target: "background", ...message }, (/** @type {BackgroundAnswer | undefined} */ response) => {
          resolve(chrome.runtime.lastError ? null : response ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /// The post a feed card stands for: its ID and its author's handle as the
  /// timestamp link spells it, or as the post's own links spell them where
  /// the time is not a link (the post X Pro opened, «Доработки после живого
  /// просмотра», Р3). A repost card stands for the reposted post.
  /**
   * @param {Element} article
   * @returns {{ tweetId: string, handle: string } | null}
   */
  function xFeedPostIdentity(article) {
    const identity = window.MineXFeedButton?.postIdentity?.(article);
    return identity?.tweetId ? { tweetId: identity.tweetId, handle: identity.handle } : null;
  }

  /** @param {readonly XPostContent[] | undefined} posts */
  function firstXPostPicture(posts) {
    const post = posts?.[0];
    const media = [...(post?.media || []), ...(post?.quote?.media || [])][0];
    if (!media) return null;
    return media.kind === "image" ? media.url : media.poster || null;
  }

  /// What the clipper opens with for one post of an X feed: the post as the
  /// page's feeds delivered it, else as syndication gives it through
  /// background, else the reason it could not be read (rules 4, 6, 7). Never
  /// the thread, never the feed.
  /**
   * @param {Element} article
   * @param {{ tweetId: string, handle: string }} identity
   * @returns {Promise<PreloadedClip & { snapshot: Readonly<CaptureDocument> }>}
   */
  async function readXFeedPost(article, identity) {
    const snapshot = captureDocumentSnapshot();
    const { tweetId } = identity;
    const cached = (await askBackground({ action: "readXPost", tweetId }))?.post || null;
    const handle = cached?.handle || identity.handle;
    const postUrl = `https://x.com/${handle}/status/${tweetId}`;
    const post = cached
      ? articleFromXPosts([cached], handle)
      : await extractTwitterPostFromArticle(article, tweetId, handle, { postUrl, videoScope: article, requireApi: true });
    /** @type {ArticleData} */
    const extracted = post || {
      title: `@${handle}`, content: "", byline: `@${handle}`, excerpt: "",
      twitterPosts: [], embeddedVideos: [], threadPostCount: 0, unavailableReason: X_POST_UNAVAILABLE,
    };
    const capture = { sourceUrl: postUrl, documentUrl: snapshot.documentUrl, captureGeneration: snapshot.captureGeneration };
    return {
      snapshot,
      metadata: {
        url: postUrl,
        documentUrl: snapshot.documentUrl,
        captureGeneration: snapshot.captureGeneration,
        title: extracted.title,
        description: extracted.excerpt,
        image: firstXPostPicture(extracted.twitterPosts),
        author: `@${handle}`,
        ogType: null,
        favicon: getFavicon(),
        selection: "",
        detectedType: "article",
        isArticle: true,
      },
      article: { ...extracted, ...capture },
    };
  }

  // Controls whose post is being read; a second press meanwhile does nothing.
  const xFeedOpenings = new WeakSet();

  /// The Mine button of an X post was pressed: the clipper opens in this page
  /// with this post, the way the Instagram button opens it (rule 3).
  /**
   * @param {Element} article
   * @param {Element} control
   */
  async function clipXFeedPost(article, control) {
    if (retireIfReplaced() || xFeedOpenings.has(control)) return;
    const identity = xFeedPostIdentity(article);
    if (!identity) return;
    xFeedOpenings.add(control);
    control.setAttribute("aria-busy", "true");
    try {
      const { snapshot, metadata, article: post } = await readXFeedPost(article, identity);
      // A page that moved on meanwhile gets no clipper for the post it left.
      const current = captureDocumentSnapshot();
      if (current.documentUrl !== snapshot.documentUrl || current.captureGeneration !== snapshot.captureGeneration) return;
      const response = await askBackground({
        action: "showOverlayInThisTab",
        pageUrl: window.location.href,
        preloaded: { metadata, article: post },
      });
      // `deferred`: the clipper opens after the extension's reload into the
      // build on disk (К4).
      if (!response?.ok && response?.mode !== "deferred") {
        console.warn("[Mine] The clipper did not open for this X post:", response?.error ?? "no answer");
      }
    } finally {
      xFeedOpenings.delete(control);
      control.removeAttribute("aria-busy");
    }
  }

  function initXFeedButton() {
    const feedButton = window.MineXFeedButton;
    if (!feedButton?.isXHost(window.location.hostname)) return;
    followFeedButtonSetting("x", () => {
      const stopWatching = feedButton.watch(document, (article, control) => {
        void clipXFeedPost(article, control);
      });
      return () => {
        stopWatching();
        feedButton.removeAll(document);
      };
    });
  }

  initXFeedButton();

  // ── The clip of an overlay open before this document ─────────────────────
  //
  // A new document in a tab whose overlay was open (a link, a reload, a page
  // back from the history cache) asks background for the clip it keeps for
  // the tab, and the overlay opens again with it (SPEC_CLIPPER.md, «Доработки
  // после живого просмотра», Р7). The list of tabs with an open clip is read
  // first: a page of a browser with no open overlay does not wake background.
  const OPEN_CLIP_TABS_KEY = "mineOpenClipTabs";

  async function restoreOpenClip() {
    try {
      /** @type {unknown} */
      const tabs = (await chrome.storage.session.get(OPEN_CLIP_TABS_KEY))?.[OPEN_CLIP_TABS_KEY];
      if (!Array.isArray(tabs) || tabs.length === 0) return;
    } catch {
      // Pages may not read session storage until background has opened it to
      // them, which it does before any overlay opens: nothing is kept yet.
      return;
    }
    askBackground({ action: "restoreOpenClip" });
  }

  if (window.top === window) {
    void restoreOpenClip();
    /** @param {PageTransitionEvent} event */
    const onPageShow = (event) => {
      if (event.persisted) void restoreOpenClip();
    };
    window.addEventListener("pageshow", onPageShow);
    onRetire(() => window.removeEventListener("pageshow", onPageShow));
  }

  // ── Article extraction (Defuddle) ─────────────────────────────────────

  /** @returns {ArticleData} */
  function extractArticle() {
    const snapshot = captureDocumentSnapshot();
    const sourceUrl = capturePageSource(snapshot.documentUrl);
    const article = extractArticleForCurrentDocument();
    assertCaptureDocument(snapshot);
    return { ...article, sourceUrl, documentUrl: snapshot.documentUrl, captureGeneration: snapshot.captureGeneration };
  }

  /** @returns {ArticleData} */
  function extractArticleForCurrentDocument() {
    // Twitter/X: long-form article can be extracted synchronously; tweet/thread
    // fallback is async because it can use the syndication API.
    if (isTwitterUrl(window.location.href)) {
      const longform = extractXLongformArticle();
      if (longform?.status === "article" || longform?.status === "empty") {
        return longform.article;
      }
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // Instagram: async only (GraphQL API)
    if (isInstagramPostUrl(window.location.href)) {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // YouTube: skip Defuddle sync (transcript comes from async path)
    if (isVideoUrl(window.location.href)) {
      return {
        title: youtubeSource(window.location.href) ? document.title || "" : getMeta("og:title") || document.title || "",
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
      const product = extractProductArticle();
      if (product) return product;
      const result = new Defuddle(createExtractionDocument(), {
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
  /** @returns {ArticleData | null} */
  function extractProductArticle() {
    const extractor = globalThis.MineProductExtraction;
    // Both callers load Defuddle first; without it there is no converter.
    if (!extractor || typeof Defuddle === "undefined" || typeof Defuddle.createMarkdownContent !== "function") return null;
    const defuddle = Defuddle;
    return extractor.extractProductArticle(document, window.location.href,
      (html, url) => defuddle.createMarkdownContent(html, url));
  }

  /** @returns {Promise<ArticleData>} */
  async function extractArticleAsync() {
    const snapshot = captureDocumentSnapshot();
    const pageUrl = snapshot.documentUrl;
    const sourceUrl = capturePageSource(pageUrl);
    const article = await extractArticleForCurrentPage();
    assertCaptureDocument(snapshot);
    return { ...article, sourceUrl, documentUrl: pageUrl, captureGeneration: snapshot.captureGeneration };
  }

  /** @returns {Promise<ArticleData>} */
  async function extractArticleForCurrentPage() {
    if (isTwitterUrl(window.location.href)) {
      const longform = extractXLongformArticle();
      if (longform?.status === "article" || longform?.status === "empty") {
        return longform.article;
      }
      return (await extractTwitterThread()) ||
        { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }

    // Bluesky: public AT Protocol API — no session, no scraping.
    if (isBlueskyPostUrl(window.location.href)) {
      return (await extractBlueskyPost()) ||
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
      // `ensureDefuddleLoaded` answers true only with Defuddle on the page.
      if (!(await ensureDefuddleLoaded()) || typeof Defuddle === "undefined") {
        return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
      }
      try {
        const result = await new Defuddle(document, { separateMarkdown: true }).parseAsync();
        return {
          title: result?.title || (youtubeSource(window.location.href) ? document.title || "" : getMeta("og:title") || document.title || ""),
          content: result?.variables?.transcript || "",
          html: "",
          byline: result?.author || null,
          excerpt: result?.description || getMeta("og:description") || "",
          embeddedVideos: extractEmbeddedVideoPreviews(),
        };
      } catch {
        return { title: youtubeSource(window.location.href) ? document.title || "" : getMeta("og:title") || document.title || "", content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
      }
    }

    // Other pages: use Defuddle
    if (!(await ensureDefuddleLoaded()) || typeof Defuddle === "undefined") {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }
    try {
      const product = extractProductArticle();
      if (product) return product;
      const result = await new Defuddle(createExtractionDocument(), {
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

  /** @type {HTMLDivElement | null} */
  let cropOverlayHost = null;
  /** @type {HTMLDivElement | null} */
  let cropToastHost = null;
  // The crop under way, from its start until its result is handed over,
  // capture included. One at a time: another start meanwhile is ignored
  // (SPEC_AUDIT_FIXES.md, В4.3). It carries the id the clipper named it with:
  // its result goes out under that id, only that clipper takes it, and that
  // clipper cancels it when it closes (Г3.3).
  /** @type {ActiveCrop | null} */
  let activeCrop = null;

  /** @param {() => void} callback */
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

  /** @param {(response: { ok: boolean }) => void} sendResponse */
  function prepareViewportCapture(sendResponse) {
    // Hide every Mine-owned UI layer before background calls
    // captureVisibleTab. DOM mutations are not enough: Chrome can capture the
    // previous compositor frame, so we acknowledge only after a clean paint.
    if (window.__mineOverlay) {
      window.__mineOverlay.hide();
    }
    // The overlay's hosts are <div> elements (popup/overlay-entry.tsx).
    for (const host of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-mine-clipper-overlay]"))) {
      host.style.display = "none";
    }
    if (cropOverlayHost) {
      cropOverlayHost.style.visibility = "hidden";
    }
    if (cropToastHost) {
      cropToastHost.style.visibility = "hidden";
    }
    hideFeedButtonsForCapture();

    afterViewportPaint(() => sendResponse({ ok: true }));
  }

  // The Mine buttons on X and Instagram posts are part of the page, not of
  // what the person saves: a screenshot is taken without them, and they come
  // back once background has the frame (SPEC_DEEP_AUDIT.md, Е3.13). A frame
  // background never reports still brings them back after
  // FEED_BUTTONS_HIDDEN_AT_MOST_MS.
  const FEED_BUTTONS_HIDDEN_AT_MOST_MS = 5_000;
  /** @type {{ style: HTMLStyleElement, timer: ReturnType<typeof setTimeout> | undefined } | null} */
  let feedButtonsHidden = null;

  function hideFeedButtonsForCapture() {
    if (!feedButtonsHidden) {
      const style = document.createElement("style");
      style.setAttribute("data-mine-capture", "");
      style.textContent = "[data-mine-x-post], [data-la-clip] { visibility: hidden !important; }";
      (document.head ?? document.documentElement).appendChild(style);
      feedButtonsHidden = { style, timer: undefined };
    }
    clearTimeout(feedButtonsHidden.timer);
    feedButtonsHidden.timer = setTimeout(showFeedButtonsAfterCapture, FEED_BUTTONS_HIDDEN_AT_MOST_MS);
  }

  function showFeedButtonsAfterCapture() {
    if (!feedButtonsHidden) return;
    clearTimeout(feedButtonsHidden.timer);
    feedButtonsHidden.style.remove();
    feedButtonsHidden = null;
  }
  onRetire(showFeedButtonsAfterCapture);

  function destroyCropOverlay() {
    if (cropOverlayHost) {
      cropOverlayHost.remove();
      cropOverlayHost = null;
    }
    document.documentElement.style.cursor = "";
  }

  /** @param {string} message */
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

  /// Hand `crop`'s result over, unless its clipper cancelled it meanwhile:
  /// then nothing is shown and nothing is reported (Г3.3).
  /**
   * @param {ActiveCrop} crop
   * @param {CropResult} payload
   */
  function sendCropResult(crop, payload) {
    // Restore clipper overlay (hidden on crop start). In the overlay
    // architecture the React state is still live — we just toggle the
    // host's display:none, no rehydrate needed, no toast needed.
    const overlay = window.__mineOverlay;
    if (overlay) {
      /** @param {{ error?: string, dataUrl?: string, screenshotId?: string | null }} detail */
      const handOver = (detail) => {
        if (activeCrop !== crop) return;
        activeCrop = null;
        overlay.show();
        window.dispatchEvent(new CustomEvent("mine-crop-result", { detail: { cropId: crop.id, ...detail } }));
      };
      if (payload.status === "cancelled" && payload.error) {
        handOver({ error: payload.error });
        return;
      }
      if (payload.status === "done" && payload.dataUrl) {
        const dataUrl = payload.dataUrl;
        chrome.runtime.sendMessage(
          { target: "background", action: "cacheScreenshotUpload", dataUrl },
          (/** @type {{ ok?: boolean, screenshotId?: string } | undefined} */ resp) =>
            handOver({ dataUrl, screenshotId: resp?.ok ? resp.screenshotId : null }),
        );
        return;
      }
      // Cancelled on the page: the clipper learns that its crop is over.
      handOver({});
      return;
    }
    if (activeCrop !== crop) return;
    activeCrop = null;
    // Fallback path (detached window): persist result + show toast so
    // user can reopen detached popup manually (used when overlay isn't
    // available, e.g. after chrome:// navigation that killed content script).
    if (payload.status === "done") {
      showCropToast("Screenshot ready — click the Mine icon to save");
    }
    chrome.runtime.sendMessage({ target: "background", action: "cropDone", ...payload, cropId: crop.id }, () => {
      void chrome.runtime.lastError;
    });
  }

  /// The crop's result: `{status:"done", dataUrl}` or `{status:"cancelled"}`
  /// with the reason when the capture was refused.
  /**
   * @param {{ x: number, y: number, width: number, height: number }} rect
   * @returns {Promise<CropResult>}
   */
  async function performCrop(rect) {
    // Ask background for a full viewport capture
    /** @type {{ ok?: boolean, dataUrl?: string, error?: string }} */
    const captureResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        // The page shown now, for any clip (SPEC_CLIPPER.md, «Доработки после
        // живого просмотра», Р9).
        { target: "background", action: "captureForCrop" },
        (/** @type {{ ok?: boolean, dataUrl?: string, error?: string } | undefined} */ resp) =>
          resolve(resp || { ok: false, error: "No response" }),
      );
    });

    const capturedDataUrl = captureResp.dataUrl;
    if (!captureResp.ok || !capturedDataUrl) {
      return { status: "cancelled", error: captureResp.error || "Screenshot capture failed" };
    }

    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);

    try {
      // Load the captured viewport into an image
      /** @type {HTMLImageElement} */
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Failed to load captured image"));
        el.src = capturedDataUrl;
      });

      // Crop via OffscreenCanvas (or fall back to regular canvas)
      /** @type {string} */
      let croppedDataUrl;
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(sw, sh);
        drawCrop(canvas.getContext("2d"), img, sx, sy, sw, sh);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
        croppedDataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          // `readAsDataURL` leaves a string in `result`.
          reader.onloadend = () => resolve(/** @type {string} */ (reader.result));
          reader.readAsDataURL(blob);
        });
      } else {
        const canvas = Object.assign(document.createElement("canvas"), { width: sw, height: sh });
        drawCrop(canvas.getContext("2d"), img, sx, sy, sw, sh);
        croppedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      }

      return { status: "done", dataUrl: croppedDataUrl };
    } catch (e) {
      console.error("[Mine] crop failed:", e);
      return { status: "cancelled" };
    }
  }

  /// Draws the picked part `sx, sy, sw, sh` of the captured viewport onto a
  /// canvas of that size. A canvas without a 2D context throws, and the crop
  /// fails as a whole.
  /**
   * @param {CanvasDrawImage | null} ctx
   * @param {HTMLImageElement} img
   * @param {number} sx
   * @param {number} sy
   * @param {number} sw
   * @param {number} sh
   */
  function drawCrop(ctx, img, sx, sy, sw, sh) {
    if (!ctx) throw new Error("The canvas has no 2D context");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  }

  /// `cropId` is the clipper's name for this crop; the result carries it.
  /** @param {unknown} cropId */
  function startCropOverlay(cropId) {
    // A crop already under way, its capture included, is not started again.
    if (activeCrop) return;
    /** @type {ActiveCrop} */
    const crop = { id: typeof cropId === "string" ? cropId : null, cancel: () => undefined };

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
    activeCrop = crop;

    // The markup just written holds every one of these <div> elements.
    const overlay = /** @type {HTMLDivElement} */ (shadow.querySelector(".overlay"));
    const dim = /** @type {HTMLDivElement} */ (shadow.querySelector(".dim"));
    const selection = /** @type {HTMLDivElement} */ (shadow.querySelector(".selection"));
    const sizeLabel = /** @type {HTMLDivElement} */ (shadow.querySelector(".size-label"));

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

    /** @param {MouseEvent} e */
    function onMouseDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      rect = { x: startX, y: startY, width: 0, height: 0 };
    }

    /** @param {MouseEvent} e */
    function onMouseMove(e) {
      if (!dragging) return;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      rect = { x, y, width: w, height: h };
      updateSelection();
    }

    // Escape is taken in the capture phase, before the page sees it. The
    // same options remove it: a listener removed without the capture flag
    // stays, and every later Escape of the page would be taken, restore an
    // old scroll lock and bring the clipper back (SPEC_AUDIT_FIXES.md, В4.3).
    const keyListenerOptions = { capture: true };
    let cleanedUp = false;
    let finished = false;

    // Takes the crop's layer and listeners away once, however it ends.
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      overlay.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown, keyListenerOptions);
      document.documentElement.style.overflow = prevOverflow;
      destroyCropOverlay();
    }

    // Hands the result over once; the next crop may start after it.
    /** @param {CropResult} payload */
    function finish(payload) {
      if (finished) return;
      finished = true;
      sendCropResult(crop, payload);
    }

    // The clipper that started this crop closed: the page gets its keyboard
    // and scroll back, and a capture still out is dropped unreported.
    crop.cancel = () => {
      if (activeCrop !== crop) return;
      activeCrop = null;
      finished = true;
      cleanup();
    };

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
      performCrop(finalRect).then(finish, (/** @type {unknown} */ e) => {
        console.error("[Mine] crop failed:", e);
        finish({ status: "cancelled" });
      });
    }

    /** @param {KeyboardEvent} e */
    function onKeyDown(e) {
      if (e.key !== "Escape" || cleanedUp) return;
      e.preventDefault();
      cleanup();
      finish({ status: "cancelled" });
    }

    overlay.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown, keyListenerOptions);
  }

  /// Cancel the crop under way when it is the one named `cropId`.
  /** @param {unknown} cropId */
  function cancelCropOverlay(cropId) {
    if (activeCrop !== null && typeof cropId === "string" && activeCrop.id === cropId) activeCrop.cancel();
  }

  // The overlay clipper starts a crop directly, naming the crop, and cancels
  // it when it closes. The crop id comes second: the first argument named the
  // page of a Save link clip until 12.10.2026 and is not read. The overlay is
  // read from disk at every opening, this script only when the extension
  // loads, so an overlay of a later build keeps the same order of arguments
  // for a script of an earlier one.
  /** @type {MinePageCrop} */
  const pageCrop = {
    start: (_page, cropId) => startCropOverlay(cropId),
    cancel: cancelCropOverlay,
  };
  window.__mineCrop = pageCrop;
  onRetire(() => {
    activeCrop?.cancel();
    activeCrop = null;
    destroyCropOverlay();
    cropToastHost?.remove();
    cropToastHost = null;
    if (window.__mineCrop === pageCrop) delete window.__mineCrop;
  });

  // ── Message handler ─────────────────────────────────────────────────────

  // A retired script does not answer (К4); its listener goes with it.
  chrome.runtime.onMessage.addListener(answerMessage);
  onRetire(() => chrome.runtime.onMessage.removeListener(answerMessage));

  /**
   * @param {ContentRequest} msg
   * @param {chrome.runtime.MessageSender} _sender
   * @param {(response?: unknown) => void} sendResponse
   * @returns {boolean} whether the answer comes later
   */
  function answerMessage(msg, _sender, sendResponse) {
    if (retireIfReplaced()) return false;
    if (msg.action === "prepareViewportCapture") {
      prepareViewportCapture(sendResponse);
      return true;
    }

    if (msg.action === "finishViewportCapture") {
      showFeedButtonsAfterCapture();
      return false;
    }

    if (msg.action === "startCropOverlay") {
      try {
        startCropOverlay(msg.cropId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return false; // synchronous — response already sent
    }

    if (msg.action === "extractMetadata") {
      sendResponse(extractDetectedMetadata());
      return true;
    }

    if (msg.action === "extractArticle") {
      const article = extractArticle();
      sendResponse(article);
      return true;
    }

    if (msg.action === "extractArticleAsync") {
      const snapshot = captureDocumentSnapshot();
      const title = document.title;
      const sourceUrl = capturePageSource(snapshot.documentUrl);
      extractArticleAsync().then(sendResponse).catch((/** @type {unknown} */ error) => sendResponse({
        title, content: "", byline: null, excerpt: "",
        sourceUrl, documentUrl: snapshot.documentUrl, captureGeneration: snapshot.captureGeneration,
        threadWarning: `Content extraction failed: ${errorMessage(error) || "unknown error"}`,
      }));
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
  }

  /// The `message` of what a promise rejected with, read as it comes: an
  /// Error of another world is not an `instanceof Error` here.
  /** @param {unknown} error */
  function errorMessage(error) {
    return typeof error === "object" && error !== null && "message" in error ? error.message : undefined;
  }

  // Detect Twitter/X lightbox overlay and extract the image URL.
  // Twitter renders the lightbox as a modal with role="dialog" (or a
  // layer with [data-testid="swipe-to-dismiss"]). Inside it, the main
  // image is either an <img> tag or a <div> with background-image.
  // Returns { src, width, height } or null if no lightbox is open.
  /** @returns {TwitterLightboxResult | null} */
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

  /**
   * @param {string} src
   * @returns {PageImageInfo}
   */
  function getImageInfoBySrc(src) {
    const img = findImageBySrc(src);
    if (img) {
      return {
        src: img.src,
        alt: img.alt || null,
        title: img.title || null,
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
        postUrl: findPostUrlForImage(img),
      };
    }
    return { src, alt: null, title: null, width: null, height: null, postUrl: null };
  }

  /** @param {string} src */
  function findImageBySrc(src) {
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      if (img.src === src || img.currentSrc === src) return img;
    }
    // Lightboxes serve the same picture under a different size variant:
    // `pbs.twimg.com/media/<id>?name=large` in the overlay against `?name=small`
    // in the feed, `feed_fullsize/<cid>` against `feed_thumbnail/<cid>`. The
    // stable id ties them together, and the feed copy is the one that sits
    // inside the post's own markup.
    const id = stableImageId(src);
    if (!id) return null;
    for (const img of imgs) {
      const candidate = stableImageId(img.currentSrc || img.src);
      if (candidate && candidate === id) return img;
    }
    return null;
  }

  /** @param {string} url */
  function stableImageId(url) {
    const value = String(url ?? "");
    const twitter = value.match(/pbs\.twimg\.com\/media\/([\w-]+)/i);
    if (twitter) return `twimg:${twitter[1]}`;
    const bsky = value.match(/cdn\.bsky\.app\/img\/[^/]+\/plain\/([^/]+)\/([\w]+)/i);
    if (bsky) return `bsky:${bsky[1]}/${bsky[2]}`;
    return null;
  }

  /// The permalink of the publication the image belongs to, read from the
  /// markup around it. This is the only place the image→post relation exists:
  /// neither X nor Bluesky offers a public file→post lookup.
  /**
   * @param {HTMLImageElement} img
   * @returns {string | null}
   */
  function findPostUrlForImage(img) {
    /** @param {string} href */
    const isPostHref = (href) =>
      /\/(?:[\w]+)\/status\/\d+/i.test(href) || /\/profile\/[^/]+\/post\/[\w]+/i.test(href);

    // A quoted image's own photo link is more specific than the outer
    // article's timestamp, which belongs to the quoting post.
    // `a[href]` matches anchors; the page's are HTML <a> elements.
    const imageLink = /** @type {HTMLAnchorElement | null} */ (img.closest("a[href]"));
    if (imageLink && isPostHref(imageLink.getAttribute("href") || "")) return imageLink.href;

    // X wraps a tweet in <article>; the timestamp link is the tweet's own
    // permalink and survives quoted tweets, which bring a second status link
    // into the same article.
    const article = img.closest("article");
    if (article) {
      const timestamp = article.querySelector("time");
      const timestampLink = timestamp ? timestamp.closest("a") : null;
      if (timestampLink && isPostHref(timestampLink.getAttribute("href") || "")) {
        return timestampLink.href;
      }
    }

    // Generic walk: the nearest container whose post links all agree. Stops
    // before a feed-level container, where links to different posts collide.
    let node = img.parentElement;
    while (node && node !== document.body) {
      // `a[href]` matches anchors; the page's are HTML <a> elements.
      const links = /** @type {NodeListOf<HTMLAnchorElement>} */ (node.querySelectorAll("a[href]"));
      /** @type {Set<string>} */
      const hrefs = new Set();
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        if (isPostHref(href)) hrefs.add(link.href.split("?")[0] ?? "");
      }
      if (hrefs.size === 1) {
        const [only] = hrefs;
        return only ?? null;
      }
      if (hrefs.size > 1) return null;
      node = node.parentElement;
    }
    return null;
  }

  // Expose extractors to other scripts running in the same content-script
  // isolated world (e.g., the overlay entry injected via
  // chrome.scripting.executeScript). They can call these directly without
  // round-tripping through chrome.runtime.sendMessage → background → tabs.
  //
  // The isolated world `window` is shared between all scripts injected
  // into the same frame by this extension, so this assignment is visible
  // from overlay.js as `window.__mineClipper`.
  /** @type {MineContentHelpers} */
  const helpers = {
    extractMetadata: extractDetectedMetadata,
    extractArticle,
    extractArticleAsync,
    captureDocumentSnapshot,
    getImageInfo: getImageInfoBySrc,
    detectTwitterLightboxImage,
  };
  window.__mineClipper = helpers;
  onRetire(() => {
    if (window.__mineClipper === helpers) delete window.__mineClipper;
  });
})();
