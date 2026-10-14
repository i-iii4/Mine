(function (root) {
  "use strict";

  const ROOT = "main [data-product-root]";
  const MEDIA = "[data-product-single-media-wrapper]";
  const ALLOWED_TAGS = new Set("p br strong b em i u s del a ul ol li blockquote pre code table thead tbody tfoot tr th td caption h2 h3 h4 h5 h6 img figure figcaption hr sup sub".split(" "));
  const REMOVED_TAGS = "script,style,form,button,input,select,textarea,nav,header,footer,aside,iframe,object,embed,template,noscript,svg,meta,link";

  /** @typedef {Record<string, unknown>} JsonObject */

  /** @param {unknown} value */
  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  /**
   * @param {string | null | undefined} value
   * @param {string} base
   */
  function httpUrl(value, base) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  /**
   * @param {string} value
   * @param {string} pageUrl
   */
  function samePage(value, pageUrl) {
    const resolved = httpUrl(value, pageUrl);
    if (!resolved) return false;
    const candidate = new URL(resolved);
    const page = new URL(pageUrl);
    // Shopify variants and schema fragments identify the same product page.
    return candidate.origin === page.origin && candidate.pathname.replace(/\/$/, "") === page.pathname.replace(/\/$/, "");
  }

  /**
   * @param {Document} doc
   * @returns {JsonObject[] | null}
   */
  function products(doc) {
    /** @type {JsonObject[]} */
    const found = [];
    /** @param {unknown} value */
    function visit(value) {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      // A non-array object of parsed JSON: every key reads as a JSON value or
      // as undefined.
      const node = /** @type {JsonObject} */ (value);
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (types.includes("Product")) found.push(node);
      if (node["@graph"]) visit(node["@graph"]);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      // The text of an element is never null.
      try { visit(JSON.parse(script.textContent ?? "")); }
      catch { return null; }
    }
    return found;
  }

  /**
   * @param {JsonObject} product
   * @param {string} pageUrl
   * @param {string} title
   */
  function matchesProduct(product, pageUrl, title) {
    if (compact(product.name) !== title) return false;
    /** @type {unknown[]} */
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    return [product.url, product["@id"], ...offers.map(offer => offer && typeof offer === "object" && "url" in offer ? offer.url : undefined)]
      .some(value => typeof value === "string" && samePage(value, pageUrl));
  }

  /**
   * @param {Element} img
   * @param {string} pageUrl
   */
  function imageUrl(img, pageUrl) {
    const rawSet = img.getAttribute("srcset") || img.getAttribute("data-srcset")
      || img.closest("picture")?.querySelector("source:not([media])[srcset]")?.getAttribute("srcset") || "";
    // A comma can belong to a URL. Only split after a completed descriptor.
    const candidates = Array.from(rawSet.matchAll(/(?:^|,\s*)(\S+)\s+(\d+(?:\.\d+)?)(w|x)(?=\s*(?:,|$))/g), match => ({
      url: httpUrl(match[1], pageUrl), size: Number(match[2]), unit: match[3],
    })).filter(candidate => candidate.url);
    // Invalid mixed descriptor sets cannot establish a largest rendition.
    const first = candidates[0];
    if (first && candidates.every(item => item.unit === first.unit)) {
      return candidates.reduce((best, item) => item.size > best.size ? item : best).url;
    }
    return httpUrl(img.getAttribute("data-src"), pageUrl) || httpUrl(img.getAttribute("src"), pageUrl);
  }

  /**
   * @param {Element} element
   * @param {string} pageUrl
   */
  function cleanDescription(element, pageUrl) {
    // A deep clone of an element is an element.
    const copy = /** @type {Element} */ (element.cloneNode(true));
    copy.querySelectorAll(REMOVED_TAGS).forEach(node => node.remove());
    for (const node of Array.from(copy.querySelectorAll("*"))) {
      const tag = node.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
      const href = tag === "a" ? httpUrl(node.getAttribute("href"), pageUrl) : null;
      const src = tag === "img" ? imageUrl(node, pageUrl) : null;
      const alt = tag === "img" ? node.getAttribute("alt") || "" : null;
      for (const attribute of Array.from(node.attributes)) node.removeAttribute(attribute.name);
      if (href) node.setAttribute("href", href);
      if (tag === "img") {
        if (!src) { node.remove(); continue; }
        node.setAttribute("src", src);
        node.setAttribute("alt", alt ?? "");
      }
    }
    return copy.innerHTML;
  }

  /** Extract only a schema-confirmed Shopify product, without mutating the page.
   * Unsupported/ambiguous structures return null to preserve the generic path.
   * Conversion errors propagate to the caller's existing error handling.
   */
  /**
   * @param {Document} doc
   * @param {string} pageUrl
   * @param {import("./productExtraction.types").MarkdownConverter} toMarkdown
   * @returns {import("../popup/lib/messaging").ArticleData | null}
   */
  function extractProductArticle(doc, pageUrl, toMarkdown) {
    const roots = Array.from(doc.querySelectorAll(ROOT));
    const productRoot = roots[0];
    if (roots.length !== 1 || !productRoot) return null;
    if (productRoot.closest("article,aside,nav,header,footer")) return null;
    const headings = productRoot.querySelectorAll("h1");
    if (headings.length !== 1) return null;
    const title = compact(headings[0]?.textContent);
    const candidates = products(doc);
    const product = candidates?.length === 1 ? candidates[0] : undefined;
    if (!title || !product || !matchesProduct(product, pageUrl, title)) return null;

    const descriptions = productRoot.querySelectorAll(".product-content-container .rte");
    const media = Array.from(productRoot.querySelectorAll(MEDIA));
    // Existing preview puts videos before the body. Do not claim ordered mixed
    // galleries or silently drop unsupported media while that contract remains.
    if (productRoot.querySelector("video,iframe,model-viewer")
      || media.some(node => !node.hasAttribute("data-product-media-type-image"))) return null;
    if (!descriptions.length && !media.length) return null;

    const fragment = doc.createElement("div");
    /** @type {Set<string>} */
    const ids = new Set();
    /** @type {Set<string>} */
    const urls = new Set();
    for (const item of media) {
      const img = item.querySelector("img");
      if (!img) return null;
      const src = imageUrl(img, pageUrl);
      if (!src) return null;
      const id = item.getAttribute("data-media-id");
      if ((id && ids.has(id)) || urls.has(src)) continue;
      if (id) ids.add(id);
      urls.add(src);
      const image = doc.createElement("img");
      image.setAttribute("src", src);
      image.setAttribute("alt", img.getAttribute("alt") || "");
      const paragraph = doc.createElement("p");
      paragraph.append(image);
      fragment.append(paragraph);
    }
    /** @type {Set<string>} */
    const descriptionsSeen = new Set();
    for (const description of descriptions) {
      const cleaned = cleanDescription(description, pageUrl);
      if (descriptionsSeen.has(cleaned)) continue;
      descriptionsSeen.add(cleaned);
      const section = doc.createElement("section");
      section.innerHTML = cleaned;
      fragment.append(section);
    }
    const html = fragment.innerHTML;
    const content = toMarkdown(html, pageUrl);
    if (!content?.trim()) return null;
    return { title, content, html, byline: null, excerpt: "", embeddedVideos: [] };
  }

  root.MineProductExtraction = { extractProductArticle };
})(globalThis);
