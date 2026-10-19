(function (root) {
  "use strict";

  const PROTECTED_TAGS = new Set(["ARTICLE", "MAIN", "FIGURE", "PICTURE"]);
  const CONTENT_TOKEN_RE =
    /(^|[-_\s])(?:article|post|entry|prose|markdown|content)(?:[-_\s]|$)|articlebody|postbody|entrycontent|postcontent|articlecontent/i;
  const NON_CONTENT_ASSET_RE =
    /(^|[-_/.\s])(?:tracking|tracker|beacon|pixel|spacer|transparent|shim|blank|1x1)(?:[-_/.\s]|$)/i;
  const APP_SHELL_ASSET_RE =
    /(^|\/)(?:template[-_])?app[-_]icon(?:[-_.]|$)|(^|\/)(?:favicon|apple-touch-icon)(?:[-_.]|$)/i;
  // Copies a looping slider adds around its slides, each marked by the
  // slider's own class: Swiper up to version 8, Slick, bxSlider, Owl
  // Carousel 2, Glide, Splide. The slide each copies stays in the slider
  // (SPEC_CLIPPER.md, «Копии слайдов»).
  const SLIDER_CLONE_SELECTOR = [
    ".swiper-slide-duplicate",
    ".slick-cloned",
    ".bx-clone",
    ".owl-item.cloned",
    ".glide__slide--clone",
    ".splide__slide--clone",
  ].join(", ");

  /** @param {unknown} value */
  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  /** @param {Element} element */
  function elementIdentity(element) {
    return [
      element.getAttribute("src"),
      element.getAttribute("srcset"),
      element.getAttribute("class"),
      element.getAttribute("id"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-test-id"),
    ].map(compact).filter(Boolean).join(" ");
  }

  /**
   * @param {Element} element
   * @param {string} name
   */
  function numericAttribute(element, name) {
    const raw = element.getAttribute(name);
    if (!raw) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * @param {string} style
   * @param {string} property
   */
  function numericStyleValue(style, property) {
    const digits = style.match(new RegExp(`${property}\\s*:\\s*([0-9.]+)px`, "i"))?.[1];
    if (!digits) return null;
    const value = Number.parseFloat(digits);
    return Number.isFinite(value) ? value : null;
  }

  /** @param {Element} img */
  function hasTinyDeclaredSize(img) {
    const width = numericAttribute(img, "width") ?? numericStyleValue(img.getAttribute("style") || "", "width");
    const height = numericAttribute(img, "height") ?? numericStyleValue(img.getAttribute("style") || "", "height");
    return width !== null && height !== null && width <= 8 && height <= 8;
  }

  /** @param {Element} element */
  function hasContentAncestor(element) {
    let current = element.parentElement;
    while (current && current.tagName !== "BODY" && current.tagName !== "HTML") {
      if (PROTECTED_TAGS.has(current.tagName)) return true;
      if (current.getAttribute("role") === "main") return true;
      if (/\barticleBody\b/i.test(current.getAttribute("itemprop") || "")) return true;
      if (CONTENT_TOKEN_RE.test(`${current.className || ""} ${current.id || ""}`)) return true;
      current = current.parentElement;
    }
    return false;
  }

  /** @param {Element} img */
  function hasImageSemantics(img) {
    if (compact(img.getAttribute("alt"))) return true;
    if (compact(img.getAttribute("title"))) return true;
    if (compact(img.getAttribute("aria-label"))) return true;
    if (img.closest("figure")?.querySelector("figcaption")) return true;
    const link = img.closest("a[href]");
    if (link) {
      const href = compact(link.getAttribute("href"));
      if (href && href !== "#") return true;
    }
    return false;
  }

  /** @param {HTMLElement} img */
  function isExplicitlyHidden(img) {
    if (img.hidden || img.getAttribute("aria-hidden") === "true") return true;
    const role = img.getAttribute("role");
    if (role === "presentation" || role === "none") return true;
    const style = img.getAttribute("style") || "";
    return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style);
  }

  /** @param {HTMLImageElement | null | undefined} img */
  function shouldRemoveExtractionImage(img) {
    if (!img || img.tagName !== "IMG") return false;
    if (hasContentAncestor(img)) return false;
    if (hasImageSemantics(img)) return false;

    const identity = elementIdentity(img);
    if (!identity) return false;
    if (isExplicitlyHidden(img)) return true;
    if (hasTinyDeclaredSize(img) && NON_CONTENT_ASSET_RE.test(identity)) return true;
    if (NON_CONTENT_ASSET_RE.test(identity)) return true;
    return APP_SHELL_ASSET_RE.test(identity);
  }

  /** @param {Element} img */
  function removeImage(img) {
    const parent = img.parentElement;
    img.remove();
    if (parent?.tagName === "PICTURE" && !parent.querySelector("img")) {
      parent.remove();
    }
  }

  /**
   * Remove the copies a looping slider made of its slides: the clip keeps
   * each slide once, in the slider's own order.
   * @param {Document} doc
   */
  function removeSliderClones(doc) {
    for (const clone of Array.from(doc.querySelectorAll(SLIDER_CLONE_SELECTOR))) {
      clone.remove();
    }
  }

  /** @param {Document} doc */
  function sanitizeExtractionDocument(doc) {
    if (!doc?.querySelectorAll) return doc;
    removeSliderClones(doc);
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      if (shouldRemoveExtractionImage(img)) {
        removeImage(img);
      }
    }
    return doc;
  }

  root.MineExtractionDocumentSanitizer = {
    sanitizeExtractionDocument,
    shouldRemoveExtractionImage,
  };
})(globalThis);
