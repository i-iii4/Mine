// The Markdown the editor parses, as the reading pipeline reads it
// (SPEC_EDITING.md, Л0.5, Л6; SPEC_READING_MODE.md, Ч0.1): CommonMark and
// GFM's tables, task lists and literal links from @lezer/markdown, and the
// constructs of Obsidian the reading pipeline understands, as extensions of
// the Lezer parser:
//
// - strikethrough with one or two tildes, as remark-gfm reads it;
// - `==highlight==`, exactly two signs, flanking as strikethrough (Ч3);
// - wikilinks `[[Note|label]]` and embeds `![[Note]]`, up to the first `]]`
//   on their line, as `preprocessWikilinks` finds them (Ч0.2);
// - `$…$` by Obsidian's rule and `$$…$$` in a line (Ч9), `$$` blocks;
// - footnote references `[^1]` and definitions `[^1]: …` (Ч10);
// - block ids `^id` at the end of a paragraph's line;
// - callouts are recognised by the first line of a blockquote (Ч8).
//
// Code, math and HTML are their own nodes, so a wikilink or a highlight
// inside them is never parsed, the same as in the reading pipeline.

import { Language } from "@codemirror/language";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import {
  Autolink,
  MarkdownParser,
  Table,
  TaskList,
  type BlockContext,
  type DelimiterType,
  type Element,
  type InlineContext,
  type LeafBlock,
  type Line,
  type MarkdownConfig,
} from "@lezer/markdown";

/** Names of the nodes this module adds. */
export const NODE = {
  Strikethrough: "Strikethrough",
  StrikethroughMark: "StrikethroughMark",
  Highlight: "Highlight",
  HighlightMark: "HighlightMark",
  Wikilink: "Wikilink",
  WikilinkEmbed: "WikilinkEmbed",
  WikilinkMark: "WikilinkMark",
  WikilinkTarget: "WikilinkTarget",
  WikilinkLabelMark: "WikilinkLabelMark",
  WikilinkLabel: "WikilinkLabel",
  InlineMath: "InlineMath",
  InlineMathMark: "InlineMathMark",
  MathBlock: "MathBlock",
  MathBlockMark: "MathBlockMark",
  FootnoteReference: "FootnoteReference",
  FootnoteDefinition: "FootnoteDefinition",
  FootnoteDefinitionMark: "FootnoteDefinitionMark",
  BlockId: "BlockId",
} as const;

const DOLLAR = 36;
const EQUALS = 61;
const TILDE = 126;
const OPEN_BRACKET = 91;
const BANG = 33;
const CARET = 94;
const BACKSLASH = 92;
const NEWLINE = 10;
/** Indentation from which a line is indented code, not a fence (CommonMark). */
const CODE_INDENT = 4;

/** Unicode punctuation and symbols, as @lezer/markdown classifies a flanking
 *  delimiter's neighbours. */
const PUNCTUATION = /[\p{S}\p{P}]/u;

function isSpace(text: string): boolean {
  return /\s|^$/.test(text);
}

/** Whether a run of delimiter signs from `from` to `to` may open and close,
 *  by the flanking rules strikethrough and emphasis share. */
function flanking(cx: InlineContext, from: number, to: number): { open: boolean; close: boolean } {
  const before = cx.slice(from - 1, from);
  const after = cx.slice(to, to + 1);
  const spaceBefore = isSpace(before);
  const spaceAfter = isSpace(after);
  const punctuationBefore = PUNCTUATION.test(before);
  const punctuationAfter = PUNCTUATION.test(after);
  return {
    open: !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore),
    close: !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter),
  };
}

/** The length of the run of `code` at `pos`. */
function runLength(cx: InlineContext, pos: number, code: number): number {
  let end = pos;
  while (end < cx.end && cx.char(end) === code) end += 1;
  return end - pos;
}

// One type per length: a closing run matches an opening run of its own
// length only, as in micromark-extension-gfm-strikethrough.
const SINGLE_TILDE: DelimiterType = { resolve: NODE.Strikethrough, mark: NODE.StrikethroughMark };
const DOUBLE_TILDE: DelimiterType = { resolve: NODE.Strikethrough, mark: NODE.StrikethroughMark };
const HIGHLIGHT_DELIMITER: DelimiterType = { resolve: NODE.Highlight, mark: NODE.HighlightMark };

/** `~text~` and `~~text~~`; three or more tildes stay text. */
const Strikethrough: MarkdownConfig = {
  defineNodes: [NODE.Strikethrough, NODE.StrikethroughMark],
  parseInline: [{
    name: NODE.Strikethrough,
    parse(cx, next, pos) {
      if (next !== TILDE || cx.char(pos - 1) === TILDE) return -1;
      const size = runLength(cx, pos, TILDE);
      if (size > 2) return -1;
      const { open, close } = flanking(cx, pos, pos + size);
      return cx.addDelimiter(size === 1 ? SINGLE_TILDE : DOUBLE_TILDE, pos, pos + size, open, close);
    },
    after: "Emphasis",
  }],
};

/** `==text==`: exactly two signs on each side (Ч3). */
const Highlight: MarkdownConfig = {
  defineNodes: [NODE.Highlight, NODE.HighlightMark],
  parseInline: [{
    name: NODE.Highlight,
    parse(cx, next, pos) {
      if (next !== EQUALS || cx.char(pos - 1) === EQUALS || runLength(cx, pos, EQUALS) !== 2) return -1;
      const { open, close } = flanking(cx, pos, pos + 2);
      return cx.addDelimiter(HIGHLIGHT_DELIMITER, pos, pos + 2, open, close);
    },
    after: NODE.Strikethrough,
  }],
};

/** The end of the line `pos` stands in, within the inline section. */
function lineEnd(cx: InlineContext, pos: number): number {
  let end = pos;
  while (end < cx.end && cx.char(end) !== NEWLINE) end += 1;
  return end;
}

/** A wikilink or an embed from `pos`, whose opener is `openerLength` long:
 *  up to the first `]]` on the line, with a name before an optional `|`. */
function parseWikilink(cx: InlineContext, pos: number, openerLength: number, type: string): number {
  const contentStart = pos + openerLength;
  const end = lineEnd(cx, contentStart);
  const close = cx.slice(contentStart, end).indexOf("]]");
  if (close < 0) return -1;
  const contentEnd = contentStart + close;
  const content = cx.slice(contentStart, contentEnd);
  const bar = content.indexOf("|");
  const name = bar < 0 ? content : content.slice(0, bar);
  if (!name.trim()) return -1;
  const children: Element[] = [cx.elt(NODE.WikilinkMark, pos, contentStart)];
  const nameEnd = contentStart + name.length;
  children.push(cx.elt(NODE.WikilinkTarget, contentStart, nameEnd));
  if (bar >= 0) {
    children.push(cx.elt(NODE.WikilinkLabelMark, nameEnd, nameEnd + 1));
    if (nameEnd + 1 < contentEnd) children.push(cx.elt(NODE.WikilinkLabel, nameEnd + 1, contentEnd));
  }
  children.push(cx.elt(NODE.WikilinkMark, contentEnd, contentEnd + 2));
  return cx.addElement(cx.elt(type, pos, contentEnd + 2, children));
}

const Wikilinks: MarkdownConfig = {
  defineNodes: [
    NODE.Wikilink,
    NODE.WikilinkEmbed,
    NODE.WikilinkMark,
    NODE.WikilinkTarget,
    NODE.WikilinkLabelMark,
    NODE.WikilinkLabel,
  ],
  parseInline: [
    {
      name: NODE.WikilinkEmbed,
      parse(cx, next, pos) {
        if (next !== BANG || cx.char(pos + 1) !== OPEN_BRACKET || cx.char(pos + 2) !== OPEN_BRACKET) return -1;
        return parseWikilink(cx, pos, 3, NODE.WikilinkEmbed);
      },
      before: "Image",
    },
    {
      name: NODE.Wikilink,
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
        return parseWikilink(cx, pos, 2, NODE.Wikilink);
      },
      before: "Link",
    },
  ],
};

/** `$…$` by Obsidian's rule (Ч9): the opening `$` stands before a character
 *  that is not a space or `$`; a `$` after a space or a line break ends the
 *  attempt; `\` takes the next character with it. Returns the end of the
 *  closing `$`, or -1. */
function obsidianMathEnd(cx: InlineContext, pos: number): number {
  const first = cx.char(pos + 1);
  if (pos + 1 >= cx.end || first === DOLLAR || isSpace(String.fromCharCode(first))) return -1;
  let afterSpace = false;
  for (let index = pos + 1; index < cx.end; index += 1) {
    const code = cx.char(index);
    if (code === DOLLAR) return afterSpace ? -1 : index + 1;
    if (code === BACKSLASH && index + 1 < cx.end && cx.char(index + 1) !== NEWLINE) {
      index += 1;
      afterSpace = false;
      continue;
    }
    afterSpace = isSpace(String.fromCharCode(code));
  }
  return -1;
}

/** `$$…$$` in a line: a closing run of exactly the opening's length. */
function textMathEnd(cx: InlineContext, pos: number, size: number): number {
  for (let index = pos + size; index < cx.end; index += 1) {
    if (cx.char(index) !== DOLLAR) continue;
    const run = runLength(cx, index, DOLLAR);
    if (run === size) return index + run;
    index += run - 1;
  }
  return -1;
}

const InlineMath: MarkdownConfig = {
  defineNodes: [NODE.InlineMath, NODE.InlineMathMark],
  parseInline: [{
    name: NODE.InlineMath,
    parse(cx, next, pos) {
      if (next !== DOLLAR || cx.char(pos - 1) === DOLLAR) return -1;
      const size = runLength(cx, pos, DOLLAR);
      const end = size === 1 ? obsidianMathEnd(cx, pos) : textMathEnd(cx, pos, size);
      if (end < 0) return -1;
      return cx.addElement(cx.elt(NODE.InlineMath, pos, end, [
        cx.elt(NODE.InlineMathMark, pos, pos + size),
        cx.elt(NODE.InlineMathMark, end - size, end),
      ]));
    },
    before: "InlineCode",
  }],
};

/** How many of the open containers `line` continues. @lezer/markdown keeps
 *  it as `Line.depth` without declaring it in its types; its own fenced code
 *  reads it the same way, and the version is pinned (1.7.2), so a `$$` block
 *  ends with its blockquote or list item exactly as a code fence does. */
function continuedDepth(line: Line): number {
  const depth: unknown = Reflect.get(line, "depth");
  return typeof depth === "number" ? depth : 0;
}

/** The length of the `$$` fence that opens `line`, or -1. A fence takes two
 *  or more dollars and nothing with a dollar after them (micromark-extension-
 *  math: its meta holds no `$`). */
function mathFenceLength(line: Line): number {
  if (line.indent - line.baseIndent >= CODE_INDENT) return -1;
  let end = line.pos;
  while (line.text.charCodeAt(end) === DOLLAR) end += 1;
  const size = end - line.pos;
  if (size < 2 || line.text.slice(end).includes("$")) return -1;
  return size;
}

const MathBlock: MarkdownConfig = {
  defineNodes: [{ name: NODE.MathBlock, block: true }, NODE.MathBlockMark],
  parseBlock: [{
    name: NODE.MathBlock,
    parse(cx: BlockContext, line: Line) {
      const size = mathFenceLength(line);
      if (size < 0) return false;
      const from = cx.lineStart + line.pos;
      const marks: Element[] = [cx.elt(NODE.MathBlockMark, from, from + size)];
      while (cx.nextLine() && continuedDepth(line) >= cx.depth) {
        let end = line.pos;
        if (line.indent - line.baseIndent < CODE_INDENT) {
          while (line.text.charCodeAt(end) === DOLLAR) end += 1;
        }
        for (const marker of line.markers) marks.push(marker);
        if (end - line.pos >= size && line.skipSpace(end) === line.text.length) {
          marks.push(cx.elt(NODE.MathBlockMark, cx.lineStart + line.pos, cx.lineStart + end));
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt(NODE.MathBlock, from, cx.prevLineEnd(), marks));
      return true;
    },
    endLeaf(_cx, line) {
      return mathFenceLength(line) >= 0;
    },
    before: "FencedCode",
  }],
};

/** `[^label]`: a footnote reference; the label holds no space or bracket. */
const FOOTNOTE_REFERENCE = /^\[\^[^\]\s[]+\]/;
/** `[^label]:` opening a footnote definition. */
const FOOTNOTE_DEFINITION = /^\[\^[^\]\s[]+\]:/;

const Footnotes: MarkdownConfig = {
  defineNodes: [
    NODE.FootnoteReference,
    { name: NODE.FootnoteDefinition, block: true },
    NODE.FootnoteDefinitionMark,
  ],
  parseInline: [{
    name: NODE.FootnoteReference,
    parse(cx, next, pos) {
      if (next !== OPEN_BRACKET || cx.char(pos + 1) !== CARET) return -1;
      const match = FOOTNOTE_REFERENCE.exec(cx.slice(pos, lineEnd(cx, pos)));
      if (!match) return -1;
      return cx.addElement(cx.elt(NODE.FootnoteReference, pos, pos + match[0].length));
    },
    before: NODE.Wikilink,
  }],
  parseBlock: [{
    name: NODE.FootnoteDefinition,
    leaf(_cx, leaf: LeafBlock) {
      const match = FOOTNOTE_DEFINITION.exec(leaf.content);
      if (!match) return null;
      const markLength = match[0].length;
      const finish = (cx: BlockContext, block: LeafBlock) => {
        const start = block.start;
        const content = block.content;
        cx.addLeafElement(block, cx.elt(NODE.FootnoteDefinition, start, start + content.length, [
          cx.elt(NODE.FootnoteDefinitionMark, start, start + markLength),
          ...cx.parser.parseInline(content.slice(markLength), start + markLength),
        ]));
        return true;
      };
      return {
        // The next definition on the next line ends this one; any other
        // line goes on with it, as GFM's lazy continuation does.
        nextLine: (cx, line, block) => FOOTNOTE_DEFINITION.test(line.text.slice(line.pos)) && finish(cx, block),
        finish,
      };
    },
    before: "LinkReference",
  }],
};

/** `^id` at the end of a line, after a space: a block id (Obsidian). */
const BLOCK_ID = /^\^[A-Za-z0-9-]+[ \t]*$/;

const BlockIds: MarkdownConfig = {
  defineNodes: [NODE.BlockId],
  parseInline: [{
    name: NODE.BlockId,
    parse(cx, next, pos) {
      if (next !== CARET || !isSpace(cx.slice(pos - 1, pos)) || pos === cx.offset) return -1;
      const end = lineEnd(cx, pos);
      const text = cx.slice(pos, end);
      if (!BLOCK_ID.test(text)) return -1;
      return cx.addElement(cx.elt(NODE.BlockId, pos, pos + text.trimEnd().length));
    },
  }],
};

/** Every extension of the editor's Markdown, in order. */
export const MINE_MARKDOWN_EXTENSIONS: MarkdownConfig[] = [
  Table,
  TaskList,
  Autolink,
  Strikethrough,
  Highlight,
  Wikilinks,
  InlineMath,
  MathBlock,
  Footnotes,
  BlockIds,
];

/** The CommonMark parser of @codemirror/lang-markdown, with that package's
 *  node props (folding, indentation, the language data its commands look
 *  for). Its type says `Parser`; it is a `MarkdownParser`, which the package
 *  checks of every base it is given. */
function commonmarkParser(): MarkdownParser {
  const base = commonmarkLanguage.parser;
  if (!(base instanceof MarkdownParser)) throw new Error("@codemirror/lang-markdown gave no Markdown parser");
  return base;
}

/** The editor's Markdown parser: CommonMark with the extensions above. */
export const mineMarkdownParser = commonmarkParser().configure(MINE_MARKDOWN_EXTENSIONS);

/**
 * The editor's Markdown language. It shares the language data of
 * @codemirror/lang-markdown, so that package's commands (continued markup,
 * deleting markup) know it as Markdown, but it is not built by `markdown()`:
 * that function adds the HTML language for nested tags, which the editor
 * does not highlight, and its package stays out of the bundle
 * (SPEC_EDITING.md, «Библиотеки и цена»).
 */
export const mineMarkdownLanguage = new Language(commonmarkLanguage.data, mineMarkdownParser, [], "markdown");

/** `[!type]` opening a callout, with its fold sign (`remarkObsidianCallouts`). */
const CALLOUT_OPENER = /^\[!([^\]\s]+)\]([+-]?)/;
/** The quote markers and spaces before a blockquote line's content. */
const QUOTE_LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*/;

/** The callout a blockquote's first line opens, as the reading pipeline
 *  recognises it (Ч8); `null` for a plain quote. */
export function calloutOpener(firstLine: string): { type: string; fold: "" | "+" | "-" } | null {
  const content = firstLine.replace(QUOTE_LINE_PREFIX, "");
  const match = CALLOUT_OPENER.exec(content);
  if (!match) return null;
  const fold = match[2] === "+" || match[2] === "-" ? match[2] : "";
  return { type: (match[1] ?? "").toLowerCase(), fold };
}
