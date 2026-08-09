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

  const MINE_OWNED_NODE_SELECTOR = "[data-mine-clipper-overlay], [data-la-clip]";

  function removeMineOwnedNodes(root) {
    if (!root?.querySelectorAll) return;
    for (const node of root.querySelectorAll(MINE_OWNED_NODE_SELECTOR)) {
      node.remove();
    }
  }

  function createExtractionDocument() {
    const clonedDocument = document.cloneNode(true);
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
    } catch {
      // Malformed URL — fall through to null.
    }
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

  let defuddleLoadPromise = null;

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
        (response) => {
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

  function extractEmbeddedVideoPreviews() {
    const root = document.querySelector("article") || document.body;
    if (!root) return [];

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
      bodyText: extractionBodyText().slice(0, 2000),
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
    const bodyText = extractionBodyText();
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

  function isTwitterUrl(url) {
    const lc = url.toLowerCase();
    return (
      (lc.includes("twitter.com/") || lc.includes("x.com/")) &&
      lc.includes("/status/")
    );
  }

  function extractTweetContentParts(article) {
    return window.MineTwitterTweetContent?.extractTweetContentParts?.(article) || {
      mainText: "",
      media: [],
      quotes: [],
    };
  }

  function composeTweetText(mainText, quotes) {
    return window.MineTwitterTweetContent?.composeTweetText?.(mainText, quotes) || String(mainText || "").trim();
  }

  function cleanSyndicationText(text, mediaDetails) {
    let cleaned = String(text || "");
    for (const media of mediaDetails || []) {
      if (media.shortUrl) cleaned = cleaned.replace(media.shortUrl, "");
    }
    return cleaned.trim();
  }

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
        .filter((variant) => variant.content_type === "video/mp4" && variant.bitrate != null)
        .sort((a, b) => b.bitrate - a.bitrate);
      if (variants.length > 0) {
        return {
          kind: "video",
          url: variants[0].url,
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
   */
  async function fetchTweetDetails(tweetId) {
    try {
      const resp = await fetch(
        `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`
      );
      if (!resp.ok) return { mediaDetails: [], quotedTweet: null };
      const data = await resp.json();
      const media = [];
      for (const m of (data.mediaDetails || [])) {
        const entry = syndicationMediaEntry(m);
        if (entry) media.push(entry);
      }

      let quotedTweet = null;
      if (data.quoted_tweet) {
        const quoteMedia = [];
        for (const m of (data.quoted_tweet.mediaDetails || [])) {
          const entry = syndicationMediaEntry(m);
          if (entry) quoteMedia.push(entry);
        }
        const quoteText = cleanSyndicationText(data.quoted_tweet.text || "", quoteMedia);
        if (quoteText || quoteMedia.length > 0) {
          quotedTweet = {
            text: quoteText,
            media: quoteMedia.map((entry) => entry.url),
            mediaDetails: quoteMedia,
          };
        }
      }

      return { mediaDetails: media, quotedTweet };
    } catch {
      return { mediaDetails: [], quotedTweet: null };
    }
  }

  async function extractTwitterThread() {
    const url = window.location.href;

    // Extract author handle and tweet ID from URL
    const urlMatch = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
    if (!urlMatch) return null;
    const authorHandle = urlMatch[1];
    const tweetId = urlMatch[2];

    const threadSelection = window.MineTwitterThreadSelection;
    const articles = threadSelection?.selectTwitterThreadArticles?.({
      document,
      targetTweetId: tweetId,
      authorHandle,
    }) || [];
    if (articles.length === 0) return null;
    const targetArticle = articles.find((article) => {
      return threadSelection?.getTweetIdentity?.(article)?.tweetId === tweetId;
    }) || articles[0];

    // Fetch media from syndication API (includes videos that DOM can't capture).
    // Quote tweets stay inside the parent tweet body; they are not thread items.
    let apiMediaDetails = [];
    let apiQuotedTweet = null;
    if (tweetId) {
      const tweetDetails = await fetchTweetDetails(tweetId);
      apiMediaDetails = tweetDetails.mediaDetails;
      apiQuotedTweet = tweetDetails.quotedTweet;
    }
    const apiMedia = apiMediaDetails.map((m) => m.url);

    const tweets = [];
    for (const article of articles) {
      const contentParts = extractTweetContentParts(article);
      // Target tweet: prefer API media (complete — photos + GIFs + videos).
      // Fallback to DOM media if API returned nothing.
      const isTargetTweet =
        threadSelection?.getTweetIdentity?.(article)?.tweetId === tweetId;
      const finalMedia = isTargetTweet && apiMedia.length > 0 ? apiMedia : contentParts.media;
      const quotes = isTargetTweet && apiQuotedTweet ? [apiQuotedTweet] : contentParts.quotes;
      const text = composeTweetText(contentParts.mainText, quotes);
      if (text || finalMedia.length > 0) {
        tweets.push({ text, media: finalMedia });
      }
    }

    if (tweets.length === 0) return null;

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
      for (const video of extractEmbeddedVideoPreviews()) {
        pushUniqueVideo(embeddedVideos, video);
      }
    }

    // A player in the page with nothing resolvable behind it means the tweet
    // has video the anonymous paths cannot see: the API answers with a
    // tombstone for age-restricted posts, and the DOM only carries a `blob:`
    // URL. Flag it so the save path can ask the authenticated route.
    const hasPlayerInPage = !!targetArticle?.querySelector("video");
    // A preview entry with no `src` is exactly the case this path exists for:
    // the player runs off a blob: URL, so the entry carries a poster and
    // nothing fetchable. Counting entries would treat that as resolved.
    const hasResolvedVideo =
      embeddedVideos.some((video) => !!video.src)
      || apiMediaDetails.some((media) => media.kind === "video");
    const needsAuthenticatedVideo = hasPlayerInPage && !hasResolvedVideo;

    return {
      title: tweetTitle,
      content: parts.join("\n\n"),
      byline: `@${authorHandle}`,
      excerpt: firstText.slice(0, 200),
      embeddedVideos,
      needsAuthenticatedVideo,
      tweetUrl: needsAuthenticatedVideo ? window.location.href : undefined,
      tweetId: needsAuthenticatedVideo ? tweetId : undefined,
    };
  }

  function extractXLongformArticle() {
    const extractor = window.MineXLongformArticleExtraction;
    if (!extractor?.extractXLongformArticle) return null;
    const urlMatch = window.location.href.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
    const fallbackByline = urlMatch ? `@${urlMatch[1]}` : null;
    return extractor.extractXLongformArticle({
      document,
      locationHref: window.location.href,
      fallbackTitle: getMeta("og:title") || getMeta("twitter:title") || document.title || "",
      fallbackByline,
    });
  }


  // ── Bluesky post extraction ────────────────────────────────────────────

  function isBlueskyPostUrl(url) {
    return /(?:^|\/\/)(?:[\w.-]*\.)?bsky\.app\/profile\/[^/]+\/post\/[\w]+/i.test(url ?? "");
  }

  /// Split a Bluesky video playlist URL into the repository it lives in.
  ///
  /// The playlist path carries both halves of the blob's address —
  /// `/watch/<did>/<cid>/playlist.m3u8` — so it is preferred over the embed's
  /// own fields, which describe the view rather than the record.
  function parseBlueskyPlaylist(playlist) {
    const match = String(playlist ?? "").match(
      /\/watch\/([^/]+)\/([^/]+)\/playlist\.m3u8/i,
    );
    if (!match) return null;
    try {
      return { did: decodeURIComponent(match[1]), cid: decodeURIComponent(match[2]) };
    } catch {
      return null;
    }
  }

  /// Find the personal data server holding a DID's repository.
  ///
  /// `did:plc` identifiers are looked up in the PLC directory; `did:web` ones
  /// resolve against the domain itself. Both return a DID document whose
  /// AT Protocol service entry names the host.
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
    const services = (await resp.json())?.service;
    if (!Array.isArray(services)) return null;

    const pds = services.find(
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
  async function extractBlueskyPost() {
    const match = window.location.href.match(
      /bsky\.app\/profile\/([^/]+)\/post\/([\w]+)/i,
    );
    if (!match) return null;
    const [, handleOrDid, rkey] = match;

    try {
      // A handle in the URL has to be resolved; a DID is already one.
      let did = handleOrDid;
      if (!did.startsWith("did:")) {
        const resolved = await fetch(
          `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handleOrDid)}`,
        );
        if (!resolved.ok) return null;
        did = (await resolved.json())?.did;
        if (!did) return null;
      }

      const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
      const resp = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`,
      );
      if (!resp.ok) return null;

      const post = (await resp.json())?.thread?.post;
      if (!post) return null;

      const text = (post.record?.text || "").trim();
      const handle = post.author?.handle || handleOrDid;

      const mediaEntries = [];
      const embeddedVideos = [];
      // Media sits under one of a few embed shapes: when a post both quotes
      // another and carries media, its own media moves under `media`.
      const embeds = [post.embed, post.embed?.media].filter(Boolean);
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
    const BUTTON_VERSION = "3";

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
        // Ask background to show the in-page overlay. Instagram preloads
        // overlay.js as a static content script because this page-injected
        // button does not grant activeTab permission for executeScript.
        await chrome.runtime.sendMessage({
          target: "background",
          action: "showOverlayInThisTab",
          pageUrl: window.location.href,
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
        const existing = article.querySelector(`[${BUTTON_ATTR}]`);
        if (existing?.getAttribute("data-la-clip-version") === BUTTON_VERSION) continue;
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
  async function extractArticleAsync() {
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
      if (!(await ensureDefuddleLoaded())) {
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
    if (!(await ensureDefuddleLoaded())) {
      return { title: document.title, content: "", byline: null, excerpt: "", embeddedVideos: extractEmbeddedVideoPreviews() };
    }
    try {
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
