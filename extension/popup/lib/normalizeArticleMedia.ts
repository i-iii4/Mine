import { fromMarkdown } from "mdast-util-from-markdown";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { ArticleData, EmbeddedVideoPreview } from "./messaging";
import { videoPreviewKey } from "./videoPreview";

type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};
type Range = { start: number; end: number };
type Edit = Range & { text: string };

function attribute(node: Element, name: string): string {
  return node.attrs.find((attr) => attr.name === name)?.value.trim() ?? "";
}

function httpUrl(raw: string, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // Match the existing native inline scanner's plain Markdown URL contract.
    return url.href.replace(/[()]/g, (char) => char === "(" ? "%28" : "%29");
  } catch {
    return null;
  }
}

function directVideo(node: Element, baseUrl: string): string | null {
  const url = httpUrl(attribute(node, "src"), baseUrl);
  const type = (attribute(node, "type").split(";")[0] ?? "").toLowerCase();
  if (!url || /\.(m3u8|mpd)(?:[?#]|$)/i.test(url)) return null;
  if (type && !["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"].includes(type)) return null;
  return url;
}

/** Normalize extracted HTML players once, before both preview and save consume body.
 * Only source spans change: Markdown prose, code and existing embeds stay intact.
 * No page-wide preview scan is promoted into saved content.
 */
export function normalizeArticleMedia(article: ArticleData, baseUrl: string): ArticleData {
  const body = article.content;
  if (!/<video[\s>]/i.test(body)) return article;

  const htmlRanges: Range[] = [];
  const codeRanges: Range[] = [];
  function collect(node: MarkdownNode) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "html") htmlRanges.push({ start, end });
      if (node.type === "code" || node.type === "inlineCode") codeRanges.push({ start, end });
    }
    node.children?.forEach(collect);
  }
  fromMarkdown(body).children.forEach(collect);
  if (!htmlRanges.length) return article;

  // Code may contain deliberately unclosed tags. Mask it before HTML parsing,
  // retaining offsets, so examples cannot swallow a later real player.
  let parseInput = body;
  for (const range of codeRanges.sort((a, b) => b.start - a.start)) {
    parseInput = parseInput.slice(0, range.start)
      + parseInput.slice(range.start, range.end).replace(/[^\r\n]/g, " ")
      + parseInput.slice(range.end);
  }
  const edits: Edit[] = [];
  const videos: EmbeddedVideoPreview[] = [...(article.embeddedVideos ?? [])];
  function visit(node: HtmlNode) {
    if (!("tagName" in node)) {
      if ("childNodes" in node) node.childNodes.forEach(visit);
      return;
    }
    if (["pre", "code", "script", "style", "template", "textarea"].includes(node.tagName)) return;
    if (node.tagName !== "video") {
      node.childNodes.forEach(visit);
      return;
    }
    const location = node.sourceCodeLocation;
    if (!location?.startTag || !location.endTag) return;
    if (!htmlRanges.some((range) => location.startOffset >= range.start && location.startOffset < range.end)) return;
    const sources = node.childNodes.filter((child): child is Element => "tagName" in child && child.tagName === "source");
    // HTML's src wins over source alternatives; never silently switch a blob
    // player to some unrelated fallback rendition.
    const src = attribute(node, "src")
      ? directVideo(node, baseUrl)
      : sources.map((source) => directVideo(source, baseUrl)).find(Boolean) ?? null;
    if (!src) {
      if (!attribute(node, "src") && !sources.length
        && !body.slice(location.startTag.endOffset, location.endTag.startOffset).trim()
        && !attribute(node, "poster")) {
        edits.push({ start: location.startOffset, end: location.endOffset, text: "" });
      }
      return;
    }

    const title = attribute(node, "aria-label") || attribute(node, "title") || "Video preview";
    const poster = httpUrl(attribute(node, "poster"), baseUrl);
    const key = videoPreviewKey(src);
    const index = videos.findIndex((video) => videoPreviewKey(video.src) === key);
    const existing = videos[index];
    if (!existing) videos.push({ src, poster, title });
    else videos[index] = { ...existing, poster: existing.poster || poster };

    // Blank lines also make the embed visible inside a raw HTML wrapper.
    // Keep blockquote/list continuation indentation when breaking that block.
    const lineStart = body.lastIndexOf("\n", location.startOffset - 1) + 1;
    const linePrefix = body.slice(lineStart, location.startOffset);
    const prefix = linePrefix.match(/^(?:[ \t]*>[ \t]?)*[ \t]*/)?.[0] ?? "";
    const list = linePrefix.slice(prefix.length).match(/^(?:[-+*]|\d+[.)])[ \t]+/);
    const continuation = prefix + (list ? " ".repeat(list[0].length) : "");
    const boundary = `\n${continuation}\n${continuation}`;
    const leadingBoundary = linePrefix.slice(prefix.length + (list?.[0].length ?? 0)).trim() ? boundary : "";
    edits.push({ start: location.startOffset, end: location.startTag.endOffset, text: `${leadingBoundary}![](${src})${boundary}` });
    edits.push({ start: location.endTag.startOffset, end: location.endOffset, text: "" });
    for (const child of node.childNodes) {
      if ("tagName" in child && ["source", "track"].includes(child.tagName) && child.sourceCodeLocation) {
        edits.push({ start: child.sourceCodeLocation.startOffset, end: child.sourceCodeLocation.endOffset, text: "" });
      }
    }
  }
  visit(parseFragment(parseInput, { sourceCodeLocationInfo: true }));
  if (!edits.length) return article;
  let content = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  }
  return { ...article, content, embeddedVideos: videos };
}
