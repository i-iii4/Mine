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

  function extractMetadata() {
    return {
      url: getCanonicalUrl() || getMeta("og:url") || window.location.href,
      title: getMeta("og:title") || getMeta("twitter:title") || document.title || "",
      description:
        getMeta("og:description") ||
        getMeta("twitter:description") ||
        getMeta("description") ||
        "",
      image: getMeta("og:image") || getMeta("twitter:image") || null,
      author: getMeta("author") || getMeta("article:author") || null,
      ogType: getMeta("og:type") || null,
      favicon: getFavicon(),
      selection: window.getSelection().toString().trim(),
    };
  }

  // ── Auto-detection heuristic ────────────────────────────────────────────

  function detectType(meta) {
    // 1. Selection takes priority
    if (meta.selection.length > 0) return "selection";

    // 2. Video URLs
    const url = meta.url.toLowerCase();
    if (
      url.includes("youtube.com/watch") ||
      url.includes("youtu.be/") ||
      url.includes("vimeo.com/")
    ) {
      return "video";
    }

    // 3. Direct file URLs
    const path = url.split("?")[0] || "";
    if (/\.(pdf|zip|dmg|exe|tar\.gz|rar|7z)$/i.test(path)) {
      return "file";
    }

    // 4. Article heuristic: need >= 2 signals
    let articleSignals = 0;
    if (document.querySelector("article")) articleSignals++;
    if (meta.ogType === "article") articleSignals++;
    if (typeof isProbablyReaderable === "function" && isProbablyReaderable(document)) {
      articleSignals++;
    }
    // Check text content length
    const bodyText = document.body ? document.body.innerText : "";
    if (bodyText.length > 2000) articleSignals++;
    if (articleSignals >= 2) return "article";

    // 5. Default: link
    return "link";
  }

  // ── Article extraction (Readability.js) ─────────────────────────────────

  function extractArticle() {
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
      return {
        title: article.title || document.title,
        content: article.textContent || "",
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
