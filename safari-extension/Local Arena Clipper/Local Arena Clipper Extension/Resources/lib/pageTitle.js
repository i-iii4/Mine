// The page's name: shared by the content script and the clipper
// (SPEC_CLIPPER.md, «Название страницы»).
(function (root) {
  "use strict";

  const LETTER_OR_DIGIT = /[\p{Alphabetic}\p{N}]/u;
  const BLANK = /[\s\p{Cc}]/u;
  // Unicode blocks of punctuation, dashes, separators and invisible marks.
  // The same table as `TITLE_PUNCTUATION_BLOCKS` in
  // mine-core/src/domain/block.rs: the save core applies this rule again.
  const PUNCTUATION_BLOCKS =
    /[\u00A0-\u00BF\u00D7\u00F7\u2000-\u206F\u2E00-\u2E7F\u3000-\u303F\u30FB\uFE10-\uFE1F\uFE30-\uFE6F\uFEFF\uFF01-\uFF65\uFFE0-\uFFEE]/u;
  // The separators a site's name is joined to a page title with, as
  // Defuddle's own title cleaning reads them.
  const SITE_SEPARATOR = "[|\\-\u2013\u2014]";
  const ASCII_LIMIT = 0x80;

  /** @param {string} character */
  function isNameCharacter(character) {
    if (LETTER_OR_DIGIT.test(character)) return true;
    const code = character.codePointAt(0) ?? 0;
    return !(BLANK.test(character) || code < ASCII_LIMIT || PUNCTUATION_BLOCKS.test(character));
  }

  /**
   * Whether `value` can name a card: it holds a letter, a digit or another
   * visible sign such as an emoji. Punctuation, dashes and separators alone
   * (`-`, `|`, `…`, `・`) are a template's placeholder, not a name.
   * @param {unknown} value
   */
  function hasNameText(value) {
    return typeof value === "string" && Array.from(value).some(isNameCharacter);
  }

  /** @param {string} value */
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * `title` without the site's name at its end or start, where a separator
   * joins it: Defuddle's rule, tried with each of the site's names. The
   * separators inside the title stay; a title that would be left without a
   * name stays whole.
   * @param {string} title
   * @param {ReadonlyArray<string | null | undefined>} siteNames
   */
  function withoutSiteName(title, siteNames) {
    const whole = title.trim();
    for (const raw of siteNames) {
      const site = typeof raw === "string" ? raw.trim() : "";
      if (!hasNameText(site)) continue;
      const name = escapeRegExp(site);
      for (const pattern of [`\\s*${SITE_SEPARATOR}\\s*${name}\\s*$`, `^\\s*${name}\\s*${SITE_SEPARATOR}\\s*`]) {
        const rest = whole.replace(new RegExp(pattern, "iu"), "").trim();
        if (rest !== whole && hasNameText(rest)) return rest;
      }
    }
    return whole;
  }

  /**
   * The page's name. A declared title (`og:title`, then `twitter:title`)
   * with name text wins. A declared title that has none is a placeholder:
   * the document title names the page then, without the site's name. With
   * no declared title the document title stays as it is. No candidate with
   * name text gives an empty name, and the save core names the card by its
   * address.
   * @param {ReadonlyArray<string | null | undefined>} declared
   * @param {string | null | undefined} documentTitle
   * @param {ReadonlyArray<string | null | undefined>} siteNames
   * @returns {string}
   */
  function choosePageTitle(declared, documentTitle, siteNames) {
    const named = declared.find(hasNameText);
    if (typeof named === "string") return named;
    if (typeof documentTitle !== "string" || !hasNameText(documentTitle)) return "";
    const placeholder = declared.some((value) => typeof value === "string" && value.trim() !== "");
    return placeholder ? withoutSiteName(documentTitle, siteNames) : documentTitle;
  }

  root.MinePageTitle = { hasNameText, withoutSiteName, choosePageTitle };
})(globalThis);
