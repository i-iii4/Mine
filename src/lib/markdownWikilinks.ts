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
import type { Nodes, Root } from "mdast";
import { parseReadingSyntax } from "@/lib/reading/syntax";
// The feed decodes local addresses too and must not take this module, which
// holds the reading parser, into the first screen's bundle.
export { decodeLocalMarkdownUrl } from "./markdownUrl";

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

/** One wikilink the pre-processing rewrote: where it stands in the body as
 *  written and where its replacement stands in the rendered Markdown. */
export interface WikilinkRewrite {
  sourceStart: number;
  sourceEnd: number;
  renderedStart: number;
  renderedEnd: number;
}

/** A body with its wikilinks rewritten, and the list of rewrites in order. */
export interface PreprocessedBody {
  text: string;
  rewrites: readonly WikilinkRewrite[];
}

/** Node types whose text the pipeline does not read as Markdown: code, math
 *  and HTML. A wikilink that touches one is left as written (Ч0.2). */
const VERBATIM_NODE_TYPES: ReadonlySet<string> = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
  "html",
]);

/** The ranges of code, math and HTML in `body`, ascending, from one parse
 *  with the pipeline's own syntax. */
function verbatimRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  function visit(node: Nodes) {
    if (VERBATIM_NODE_TYPES.has(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  }
  visit(parseReadingSyntax(body));
  return ranges.sort((left, right) => left[0] - right[0]);
}

function overlapsAny(ranges: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && rangeStart < end);
}

function embedReplacement(inner: string): string {
  const [rawName, altPart] = inner.split("|", 2);
  const name = (rawName ?? "").trim();
  const alt = (altPart ?? "").trim();
  if (!name) return "";
  return `![${alt}](${encodeMarkdownUrl(name)})`;
}

function linkReplacement(inner: string): string {
  const [rawName, altPart] = inner.split("|", 2);
  const name = (rawName ?? "").trim();
  const alt = (altPart ?? "").trim();
  if (!name) return "";
  const display = alt || name;
  return `[${display}](${wikilinkHref(name)})`;
}

/** The href of a rewritten wikilink to `name`, which the article's link
 *  opens as a note (`decodeWikilinkHref`). */
export function wikilinkHref(name: string): string {
  return `${WIKILINK_HREF_PREFIX}${encodeURIComponent(name)}`;
}

function computePreprocessedBody(body: string): PreprocessedBody {
  const verbatim = verbatimRanges(body);
  const found: Array<{ start: number; end: number; replacement: string }> = [];
  for (const match of body.matchAll(WIKILINK_EMBED)) {
    const end = match.index + match[0].length;
    if (overlapsAny(verbatim, match.index, end)) continue;
    found.push({ start: match.index, end, replacement: embedReplacement(match[1] ?? "") });
  }
  // Links are found in the body as written, outside the embeds: an embed's
  // replacement holds no `]]`, so this finds what a second pass over the
  // rewritten text would.
  const embeds = found.map(({ start, end }) => [start, end] as const);
  for (const match of body.matchAll(WIKILINK_LINK)) {
    const end = match.index + match[0].length;
    if (overlapsAny(verbatim, match.index, end) || overlapsAny(embeds, match.index, end)) continue;
    found.push({ start: match.index, end, replacement: linkReplacement(match[1] ?? "") });
  }
  found.sort((left, right) => left.start - right.start);

  let text = "";
  let sourceCursor = 0;
  const rewrites: WikilinkRewrite[] = [];
  for (const { start, end, replacement } of found) {
    text += body.slice(sourceCursor, start);
    const renderedStart = text.length;
    text += replacement;
    rewrites.push({ sourceStart: start, sourceEnd: end, renderedStart, renderedEnd: text.length });
    sourceCursor = end;
  }
  text += body.slice(sourceCursor);
  return { text, rewrites };
}

/** Texts whose pre-processing and Markdown tree are kept: the open card's
 *  body, the bodies the reading mode's derivations read and the sources of
 *  the editor's widgets come and go together, and one of them must not push
 *  another out (SPEC_EDITING.md, Л14). */
export const PARSED_TEXT_CACHE_LIMIT = 8;

/** A small cache of what a text gave, the latest last; a text is looked up by
 *  its value, as a body arrives anew with every read of its card. */
class TextCache<Value> {
  private readonly entries = new Map<string, Value>();

  get(text: string, compute: (text: string) => Value): Value {
    const found = this.entries.get(text);
    if (found !== undefined) {
      this.entries.delete(text);
      this.entries.set(text, found);
      return found;
    }
    const value = compute(text);
    this.entries.set(text, value);
    while (this.entries.size > PARSED_TEXT_CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }
}

// The body is drawn, measured and mapped back many times: the selection
// handle asks for offsets on every change of the selection, and the body
// parses once.
const preprocessed = new TextCache<PreprocessedBody>();
const renderedTrees = new TextCache<Root>();

/** The Markdown tree of `processedBody`, a body after `preprocessWikilinks`,
 *  parsed once while it is kept (SPEC_EDITING.md, Л14). */
export function renderedMarkdownTree(processedBody: string): Root {
  return renderedTrees.get(processedBody, (text) => fromMarkdown(text));
}

/**
 * Rewrite Obsidian wikilinks in a markdown body into standard
 * `![alt](url)` / `[alt](url)` form so `react-markdown` can parse them, with
 * the list of rewrites that maps positions back (Ч0.2).
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
 * characters. A wikilink inside code (a block, an indented block, code in a
 * line), math (`$…$`, `$$…$$`) or HTML stays as written: Mermaid's `A[[Sub]]`,
 * the matrix `$[[1,2],[3,4]]$` and a `[[x]]` in an example reach their block
 * as they are.
 */
export function preprocessWikilinksWithMap(body: string): PreprocessedBody {
  return preprocessed.get(body, computePreprocessedBody);
}

/** The rendered Markdown of `body` (`preprocessWikilinksWithMap`). */
export function preprocessWikilinks(body: string): string {
  return preprocessWikilinksWithMap(body).text;
}

/** Map a renderer UTF-16 position back to a UTF-16 position of the original
 * Markdown, by the list of rewrites the pre-processing made. Only unchanged
 * spans and replacement boundaries are addressable: the start of a rewritten
 * wikilink maps to the start of the wikilink. A position inside rewritten
 * syntax is not guessed.
 */
export function markdownSourceOffset(body: string, renderedOffset: number): number | null {
  const { text, rewrites } = preprocessWikilinksWithMap(body);
  if (!Number.isInteger(renderedOffset) || renderedOffset < 0 || renderedOffset > text.length) return null;
  let delta = 0;
  for (const rewrite of rewrites) {
    if (renderedOffset <= rewrite.renderedStart) return renderedOffset - (rewrite.renderedStart - rewrite.sourceStart);
    if (renderedOffset < rewrite.renderedEnd) return null;
    delta = rewrite.sourceEnd - rewrite.renderedEnd;
  }
  return renderedOffset + delta;
}

/** Map renderer UTF-16 positions back to original Markdown UTF-8 boundaries
 * (`markdownSourceOffset`), the offsets the core addresses a body by.
 */
export function markdownSourceByteOffset(body: string, renderedOffset: number): number | null {
  const offset = markdownSourceOffset(body, renderedOffset);
  return offset === null ? null : new TextEncoder().encode(body.slice(0, offset)).length;
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
  visit(renderedMarkdownTree(processedBody));
  return found;
}
