// Pre-process Obsidian wikilink syntax into standard markdown before
// handing a body to `react-markdown`. Mine writes inline article media
// as `![[name]]` / `![[name|alt]]` (Phase 18.H.1) because wikilinks
// preserve the filename ↔ URL identity that the percent-encoded
// `![alt](url)` form breaks.
//
// react-markdown + remark-gfm do not understand wikilinks on their own.
// This helper rewrites wikilinks into `![alt](encoded-url)` form just
// before rendering, so the already-installed markdown pipeline does the
// rest. Encoding is isolated to the render boundary; the `.md` file on
// disk stays human-readable in Obsidian and Finder.

import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

// Lazy up to the first `]]`, and never across a line break. Barring `]`
// outright looked equivalent — filenames rarely hold one — until the clipper
// saved a tweet whose title was itself a markdown link:
// `[https example.com page…](https t.co abc) (image 1).jpg`. That `]` made the
// pattern fail to match at all, so the embed was left as raw text and the
// article rendered without any of its images. The closing `]]` is the real
// delimiter; the line bound keeps an unclosed link from swallowing the body.
const WIKILINK_EMBED = /!\[\[([^\n]*?)\]\]/g;
const WIKILINK_LINK = /(?<!!)\[\[([^\n]*?)\]\]/g;
const WIKILINK_HREF_PREFIX = "#mine-wikilink:";

export function decodeWikilinkHref(href: string | undefined): string | null {
  if (!href?.startsWith(WIKILINK_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(WIKILINK_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

function isRemoteMarkdownUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://");
}

function encodeMarkdownUrl(name: string): string {
  // Mirror the backend encoder (Phase 18.F.1): space, parens, percent.
  // encodeURI would also percent-encode Cyrillic, which we avoid to
  // keep the rendered URL human-readable for debug/dev-tools.
  return name
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/**
 * Rewrite Obsidian wikilinks in a markdown body into standard
 * `![alt](url)` / `[alt](url)` form so `react-markdown` can parse them.
 *
 * Wikilink embed:
 *   `![[name]]`        -> `![](name)` (alt empty)
 *   `![[name|alt]]`    -> `![alt](name)`
 *
 * Wikilink link (no leading !):
 *   `[[name]]`         -> `[name](name)`
 *   `[[name|alt]]`     -> `[alt](name)`
 *
 * URLs are percent-encoded (space, parens, %) so the downstream
 * markdown parser does not truncate on filenames containing those
 * characters.
 */
export function preprocessWikilinks(body: string): string {
  return body
    .replace(WIKILINK_EMBED, (_match, inner) => {
      const [rawName, altPart] = String(inner).split("|", 2);
      const name = (rawName ?? "").trim();
      const alt = (altPart ?? "").trim();
      if (!name) return "";
      return `![${alt}](${encodeMarkdownUrl(name)})`;
    })
    .replace(WIKILINK_LINK, (_match, inner) => {
      const [rawName, altPart] = String(inner).split("|", 2);
      const name = (rawName ?? "").trim();
      const alt = (altPart ?? "").trim();
      if (!name) return "";
      const display = alt || name;
      return `[${display}](${WIKILINK_HREF_PREFIX}${encodeURIComponent(name)})`;
    });
}

/** Map a renderer UTF-16 position back to a UTF-16 position of the original
 * Markdown. Rewrites are line-local; only unchanged spans and replacement
 * boundaries are addressable: the start of a rewritten wikilink maps to the
 * start of the wikilink. A position inside rewritten syntax is not guessed.
 */
export function markdownSourceOffset(body: string, renderedOffset: number): number | null {
  const lines = body.split("\n");
  let renderedStart = 0;
  let sourceStart = 0;
  for (const line of lines) {
    const rendered = preprocessWikilinks(line);
    if (renderedOffset <= renderedStart + rendered.length) {
      const offset = renderedOffset - renderedStart;
      if (offset < 0) return null;
      // Both wikilink forms are replaced by the same renderer used above.
      const pattern = /!?\[\[([^\n]*?)\]\]/g;
      let sourceCursor = 0;
      let renderedCursor = 0;
      for (const match of line.matchAll(pattern)) {
        const start = match.index;
        const unchanged = start - sourceCursor;
        if (offset <= renderedCursor + unchanged) {
          return sourceStart + sourceCursor + offset - renderedCursor;
        }
        renderedCursor += unchanged;
        const replacement = preprocessWikilinks(match[0]);
        if (offset < renderedCursor + replacement.length) return null;
        renderedCursor += replacement.length;
        sourceCursor = start + match[0].length;
      }
      return sourceStart + sourceCursor + offset - renderedCursor;
    }
    renderedStart += rendered.length + 1;
    sourceStart += line.length + 1;
  }
  return null;
}

/** Map renderer UTF-16 positions back to original Markdown UTF-8 boundaries
 * (`markdownSourceOffset`), the offsets the core addresses a body by.
 */
export function markdownSourceByteOffset(body: string, renderedOffset: number): number | null {
  const offset = markdownSourceOffset(body, renderedOffset);
  return offset === null ? null : new TextEncoder().encode(body.slice(0, offset)).length;
}

/**
 * Decode a local markdown URL back to the real filename on disk.
 *
 * Render-time markdown uses percent-encoding for a small set of characters
 * (space, parens, bare `%`) so the parser does not truncate. The source
 * vault and preview manifests keep the actual filenames, so any local path
 * crossing the render boundary must be decoded before it is used as a file
 * or preview-manifest lookup key.
 */
export function decodeLocalMarkdownUrl(src: string): string {
  if (!src || isRemoteMarkdownUrl(src)) {
    return src;
  }
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

const IMAGE_OPENER = "![";

/**
 * The clicked image's place in its card, as Remove names it to the core: how
 * many `![` precede the image's own `![` in the original body
 * (SPEC_AUDIT_FIXES.md, Г1.4). `renderedOffset` is where react-markdown's
 * image node starts in `preprocessWikilinks(body)`; a rewritten `![[name]]`
 * maps back to its own `!`.
 *
 * Counting openers needs no Markdown reading of its own, so it cannot
 * disagree with the core's about titles, angle brackets, parentheses in a
 * name or spellings of one file: the core finds the same `![` and removes the
 * reference that starts there. `null` when the offset maps to no `![`.
 */
export function inlineMediaOccurrenceIndex(body: string, renderedOffset: number): number | null {
  const sourceOffset = markdownSourceOffset(body, renderedOffset);
  if (sourceOffset === null || !body.startsWith(IMAGE_OPENER, sourceOffset)) {
    return null;
  }
  let count = 0;
  for (
    let index = body.indexOf(IMAGE_OPENER);
    index !== -1 && index < sourceOffset;
    index = body.indexOf(IMAGE_OPENER, index + IMAGE_OPENER.length)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Where the first image whose destination `matches` starts in
 * `processedBody`, the body react-markdown renders; `null` when there is
 * none. Images are visited in document order, as the reader sees them.
 */
export function firstImageOffset(
  processedBody: string,
  matches: (url: string) => boolean,
): number | null {
  let found: number | null = null;
  function visit(node: Nodes) {
    if (found !== null) return;
    if (node.type === "image") {
      if (matches(node.url)) found = node.position?.start.offset ?? null;
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(processedBody));
  return found;
}
