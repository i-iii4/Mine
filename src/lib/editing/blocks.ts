// The blocks the editor draws as widgets (SPEC_EDITING.md, Л6, Л8): code,
// Mermaid, `$$` formulas, callouts, tables, HTML, pictures and note embeds on
// lines of their own, found in the Lezer tree. A block is drawn by the reading
// pipeline from its own source, so its lines are cut out whole and the
// markers of the quotes and list items it stands in are taken off each line
// first; a map turns a place in that source back into a document position.

import type { EditorState, Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { calloutOpener, NODE } from "./syntax";

/** What a block widget draws. */
export type BlockKind = "code" | "mermaid" | "math" | "callout" | "table" | "html" | "media";

/** A container a block stands in: a blockquote or a list item, with the
 *  column its content starts at. */
export interface BlockContainer {
  kind: "quote" | "item";
  /** For an item: the column of its content, relative to the line's start
   *  after the containers outside it. */
  contentColumn: number;
}

/** A block the editor draws as a widget. */
export interface EditorBlock {
  kind: BlockKind;
  /** The start of the block's first line. */
  from: number;
  /** The end of the block's last line. */
  to: number;
  /** The quotes and list items it stands in, outermost first. */
  containers: readonly BlockContainer[];
}

/** A block's own source, as the reading pipeline draws it, with the way back
 *  to the document. */
export interface BlockSource {
  text: string;
  /** The document position of offset `offset` of `text`. */
  toDocument(offset: number): number;
}

/** Fenced code in these languages is a diagram (Ч7). */
const MERMAID_LANGUAGE = "mermaid";
/** Tags whose blocks of HTML may stand apart from their closing tag, with
 *  Markdown between (CommonMark ends a block of HTML at a blank line). */
const BLOCK_HTML_TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^>]*?(\/?)>/g;
/** How many following blocks an open tag of HTML looks through for its end. */
const HTML_GROUP_LOOKAHEAD = 200;
/** Elements of HTML that never take a closing tag. */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The language of a fenced code block, lower-cased, from its info string. */
function fenceLanguage(node: SyntaxNode, doc: Text): string {
  const info = node.getChild("CodeInfo");
  if (!info) return "";
  return doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Whether a paragraph holds only pictures and embeds, with only spaces and
 *  line breaks between: the reading mode draws it as media on lines of
 *  their own (Р5, Ч11.3). */
export function isMediaParagraph(node: SyntaxNode, doc: Text): boolean {
  let media = 0;
  let position = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Image" || child.name === NODE.WikilinkEmbed) {
      if (/\S/.test(doc.sliceString(position, child.from))) return false;
      media += 1;
      position = child.to;
    } else if (child.name === "HardBreak" || child.name === "QuoteMark") {
      continue;
    } else {
      return false;
    }
  }
  return media > 0 && !/\S/.test(doc.sliceString(position, node.to));
}

/** The kind of widget a block node is drawn as, or `null` for lines. */
function blockKind(node: SyntaxNode, doc: Text): BlockKind | null {
  switch (node.name) {
    case "FencedCode":
      return fenceLanguage(node, doc) === MERMAID_LANGUAGE ? "mermaid" : "code";
    case "CodeBlock":
      return "code";
    case NODE.MathBlock:
      return "math";
    case "Table":
      return "table";
    case "HTMLBlock":
      return "html";
    case "Blockquote":
      return calloutOpener(doc.lineAt(node.from).text) ? "callout" : null;
    case "Paragraph":
      return isMediaParagraph(node, doc) ? "media" : null;
    default:
      return null;
  }
}

/** The balance of block-level tags a block of HTML leaves open. */
function openTags(text: string, open: Map<string, number>) {
  for (const match of text.matchAll(BLOCK_HTML_TAG)) {
    const name = (match[1] ?? "").toLowerCase();
    if (VOID_ELEMENTS.has(name) || match[2] === "/") continue;
    const closing = match[0].startsWith("</");
    open.set(name, (open.get(name) ?? 0) + (closing ? -1 : 1));
  }
}

function balanced(open: Map<string, number>): boolean {
  for (const count of open.values()) if (count > 0) return false;
  return true;
}

/** The last sibling a block of HTML that opens a tag reaches to: the one
 *  whose HTML closes it, so `<details>`, its Markdown and `</details>` are
 *  drawn as one element, as the reading pipeline draws them. */
function htmlGroupEnd(node: SyntaxNode, doc: Text): SyntaxNode {
  const open = new Map<string, number>();
  openTags(doc.sliceString(node.from, node.to), open);
  if (balanced(open)) return node;
  let sibling = node.nextSibling;
  for (let step = 0; sibling && step < HTML_GROUP_LOOKAHEAD; step += 1, sibling = sibling.nextSibling) {
    if (sibling.name === "HTMLBlock") {
      openTags(doc.sliceString(sibling.from, sibling.to), open);
      if (balanced(open)) return sibling;
    }
  }
  // No closing tag: the block stands alone, as its own HTML.
  return node;
}

/** The column of a list item's content: after its marker and up to four
 *  spaces, counted from the end of the markers of the containers outside
 *  it. */
function itemContentColumn(item: SyntaxNode, doc: Text, outside: readonly BlockContainer[]): number {
  const mark = item.getChild("ListMark");
  const line = doc.lineAt(item.from);
  const start = containerPrefixLength(line.text, outside);
  if (!mark) return item.from - line.from - start;
  const rest = line.text.slice(mark.to - line.from);
  const spaces = /^[ \t]{0,5}/.exec(rest)?.[0].length ?? 0;
  // A marker followed by five spaces or more starts indented code: one space
  // belongs to the marker (CommonMark).
  return mark.to - line.from - start + (spaces > 4 || spaces === 0 ? 1 : spaces);
}

/** The blocks drawn as widgets among the children of `parent`, recursing
 *  into quotes and list items that are not widgets themselves. */
function collectIn(
  parent: SyntaxNode,
  doc: Text,
  from: number,
  to: number,
  containers: readonly BlockContainer[],
  blocks: EditorBlock[],
) {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.to < from) continue;
    if (node.from > to) break;
    const kind = blockKind(node, doc);
    if (kind) {
      const end = kind === "html" ? htmlGroupEnd(node, doc) : node;
      blocks.push({ kind, from: doc.lineAt(node.from).from, to: doc.lineAt(end.to).to, containers });
      if (end !== node) node = end;
      continue;
    }
    if (node.name === "Blockquote") {
      collectIn(node, doc, from, to, [...containers, { kind: "quote", contentColumn: 0 }], blocks);
    } else if (node.name === "BulletList" || node.name === "OrderedList") {
      for (let item = node.firstChild; item; item = item.nextSibling) {
        if (item.name !== "ListItem" || item.to < from || item.from > to) continue;
        collectIn(item, doc, from, to, [...containers, { kind: "item", contentColumn: itemContentColumn(item, doc, containers) }], blocks);
      }
    }
  }
}

/** The blocks drawn as widgets that touch `[from, to]` of `doc`, by `tree`,
 *  in document order. */
export function collectBlocks(tree: Tree, doc: Text, from = 0, to = doc.length): EditorBlock[] {
  const blocks: EditorBlock[] = [];
  collectIn(tree.topNode, doc, from, to, [], blocks);
  return blocks;
}

/** The blocks of `state` that touch `[from, to]`. */
export function blocksOf(state: EditorState, from = 0, to = state.doc.length): EditorBlock[] {
  return collectBlocks(syntaxTree(state), state.doc, from, to);
}

/** The block of `state` whose lines hold `pos`, if any. */
export function blockAt(state: EditorState, pos: number): EditorBlock | null {
  return blocksOf(state, pos, pos).find((block) => block.from <= pos && pos <= block.to) ?? null;
}

/** How much of `text`, a line inside `containers`, their markers take: the
 *  quote markers and the indentation of list items. */
export function containerPrefixLength(text: string, containers: readonly BlockContainer[]): number {
  let position = 0;
  for (const container of containers) {
    if (container.kind === "quote") {
      const match = /^[ \t]{0,3}>[ \t]?/.exec(text.slice(position));
      if (!match) return position;
      position += match[0].length;
    } else {
      let column = 0;
      while (position < text.length && column < container.contentColumn) {
        const code = text.charCodeAt(position);
        if (code !== 32 && code !== 9) break;
        column += code === 9 ? 4 - (column % 4) : 1;
        position += 1;
      }
    }
  }
  return position;
}

/** The source of `block` as the reading pipeline draws it: its lines with
 *  the markers of its containers taken off, joined by `\n`. */
export function blockSource(doc: Text, block: EditorBlock): BlockSource {
  const first = doc.lineAt(block.from).number;
  const last = doc.lineAt(block.to).number;
  const starts: number[] = [];
  const documentStarts: number[] = [];
  const lines: string[] = [];
  let offset = 0;
  for (let number = first; number <= last; number += 1) {
    const line = doc.line(number);
    // The first line of a block in a list item starts after its marker,
    // which the item's own column already counts.
    const prefix = number === first && block.containers.length > 0
      ? firstLinePrefix(line.text, block)
      : containerPrefixLength(line.text, block.containers);
    const text = line.text.slice(prefix);
    starts.push(offset);
    documentStarts.push(line.from + prefix);
    lines.push(text);
    offset += text.length + 1;
  }
  return {
    text: lines.join("\n"),
    toDocument(position: number) {
      // The last line starting at or before `position`, found by halves: a
      // long table asks this for each of its lines (Л9.12).
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((starts[middle] ?? 0) <= position) low = middle;
        else high = middle - 1;
      }
      return (documentStarts[low] ?? block.from) + position - (starts[low] ?? 0);
    },
  };
}

/** On the line a block starts on inside a list item, the item's marker may
 *  stand before it (`- ```js`): everything up to the block's content goes. */
function firstLinePrefix(text: string, block: EditorBlock): number {
  const prefix = containerPrefixLength(text, block.containers);
  if (block.containers[block.containers.length - 1]?.kind !== "item") return prefix;
  const marker = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(text.slice(prefix));
  return marker ? prefix + marker[0].length : prefix;
}
