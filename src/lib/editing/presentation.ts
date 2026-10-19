// How each element of the note is shown in Live Preview (SPEC_EDITING.md,
// Л5.1, Л6, Л7): a pure function of the document, its tree, the window being
// drawn and what is revealed, so the same input always gives the same items
// (Л5.4). Only syntax is hidden; the visible text stays text of the document
// (Local MD, 22.05.2026). Blocks drawn as widgets are the business of their
// own field (`livePreview.ts`); here they are only skipped, or, when shown as
// source, styled as source.

import type { EditorState, Text } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { collectBlocks, type EditorBlock } from "./blocks";
import { isBlockRevealed, isRevealed, type RevealState } from "./reveal";
import { calloutOpener, NODE } from "./syntax";

/** The class of muted syntax: `--muted-foreground` (Л15). */
export const MUTED_SYNTAX_CLASS = "cm-md-syntax";
/** A line of a list item, which shows its marker as the reading mode does. */
export const LIST_ITEM_LINE_CLASS = "cm-md-li";
/** A further line of a list item, under its text. */
export const LIST_CONTINUATION_CLASS = "cm-md-li-more";
/** A list item whose marker shows as source. */
export const LIST_SOURCE_CLASS = "cm-md-li-source";
/** The text of a done task: struck and secondary, as in the reading mode. */
export const TASK_DONE_CLASS = "cm-md-task-done";
/** A line of a block shown as source on the code's zone (Л6, Л15). */
export const SOURCE_BLOCK_CLASS = "cm-md-source";
export const SOURCE_BLOCK_FIRST_CLASS = "cm-md-source-first";
export const SOURCE_BLOCK_LAST_CLASS = "cm-md-source-last";
/** A wikilink to a note that is not there: dim (Л6). */
export const MISSING_LINK_CLASS = "cm-md-link-missing";
/** The heading of the first level, as the article's H1 (Л6). */
export const HEADING_1_CLASSES = "cm-md-heading text-lg leading-6 font-semibold";
/** Headings of the second to the sixth level, as the article's. */
export const HEADING_CLASSES = "cm-md-heading text-base leading-5 font-semibold";

/** A widget in a line. */
export type InlineWidgetSpec =
  /** A task's box in the place of its marker (Л7.4); `item` is where the
   *  item's marker starts. */
  | { kind: "task"; checked: boolean; item: number }
  /** A formula in a line (Ч9). */
  | { kind: "math"; source: string }
  /** A picture or a note embed among words (Р5, Ч11.3). */
  | { kind: "media"; source: string }
  /** A footnote's number (Ч10). */
  | { kind: "footnote"; number: number }
  /** A rule, `---` (Л6). */
  | { kind: "rule" };

/** One thing the presentation does to a range. */
export type PresentationItem =
  | { type: "conceal"; from: number; to: number }
  | { type: "mute"; from: number; to: number }
  | { type: "mark"; from: number; to: number; tagName: string; className?: string; attributes?: Record<string, string> }
  | { type: "line"; from: number; className: string; attributes?: Record<string, string> }
  | { type: "widget"; from: number; to: number; widget: InlineWidgetSpec }
  | { type: "wrapper"; from: number; to: number; tagName: "blockquote" | "ul" | "ol"; attributes?: Record<string, string>; rank: number };

/** What the presentation reads. */
export interface PresentationContext {
  state: EditorState;
  tree: Tree;
  reveal: RevealState;
  /** The window drawn: the visible part with a margin (Л5.6). */
  from: number;
  to: number;
  /** Whether the note a wikilink names is not there (Л6). */
  linkMissing(target: string): boolean;
  /** The number a footnote with this label is drawn with, `null` when it
   *  has no definition (GFM). */
  footnoteNumber(label: string): number | null;
  /** Where the embed shown above the body starts (Л2.7): its source stays. */
  omittedEmbed: number | null;
}

/** Inline HTML elements drawn by their pair of tags (Ч4). */
const PAIRED_HTML_TAGS = new Set(["kbd", "mark", "sub", "sup", "u", "abbr", "ins", "del", "s"]);
/** A wrapper's rank: outer ones wrap inner ones (`BlockWrapper`). */
const OUTERMOST_WRAPPER_RANK = 90;
/** The tags that draw the inline emphasis of Markdown. */
const EMPHASIS_TAGS: Record<string, string> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  [NODE.Strikethrough]: "del",
  [NODE.Highlight]: "mark",
};
const EMPHASIS_MARKS: Record<string, string> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  [NODE.Strikethrough]: NODE.StrikethroughMark,
  [NODE.Highlight]: NODE.HighlightMark,
};
const SOURCE_STYLED_BLOCKS = new Set(["code", "mermaid", "math"]);
/** Containers whose depth sets the rank of a wrapper. */
const CONTAINERS = new Set(["Blockquote", "BulletList", "OrderedList"]);

class Collector {
  readonly items: PresentationItem[] = [];
  constructor(private readonly doc: Text) {}

  /** Hide a range of syntax, or show it muted where it is revealed. */
  syntax(from: number, to: number, revealed: boolean) {
    if (to <= from) return;
    this.items.push({ type: revealed ? "mute" : "conceal", from, to });
  }

  mute(from: number, to: number) {
    if (to > from) this.items.push({ type: "mute", from, to });
  }

  mark(from: number, to: number, tagName: string, className?: string, attributes?: Record<string, string>) {
    if (to <= from) return;
    this.items.push({ type: "mark", from, to, tagName, className, attributes });
  }

  line(pos: number, className: string, attributes?: Record<string, string>) {
    this.items.push({ type: "line", from: this.doc.lineAt(pos).from, className, attributes });
  }

  widget(from: number, to: number, widget: InlineWidgetSpec) {
    this.items.push({ type: "widget", from, to, widget });
  }
}

/** The depth of containers around `node`. */
function containerDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let parent = node.parent; parent; parent = parent.parent) if (CONTAINERS.has(parent.name)) depth += 1;
  return depth;
}

/** The line `node` ends on: a node that takes its line break ends at the
 *  start of the next line, which is not its own. */
function lastLineOf(doc: Text, node: SyntaxNode) {
  const end = doc.lineAt(node.to);
  return end.from === node.to && node.to > node.from ? doc.lineAt(node.to - 1) : end;
}

/** The end of a wrapper over `node`: the end of its last line (a wrapper
 *  takes the lines that start inside it). */
function wrapperEnd(doc: Text, node: SyntaxNode): number {
  return lastLineOf(doc, node).to;
}

/** The width of whitespace after `pos` up to `limit` signs. */
function spacesAfter(doc: Text, pos: number, limit: number): number {
  const text = doc.sliceString(pos, Math.min(pos + limit, doc.lineAt(pos).to));
  return /^[ \t]*/.exec(text)?.[0].length ?? 0;
}

/** Whether `[from, to)` lies inside one of `ranges`. */
function insideAny(ranges: readonly EditorBlock[], from: number, to: number): EditorBlock | null {
  for (const range of ranges) if (range.from <= from && to <= range.to) return range;
  return null;
}

function presentHeading(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  const level = Number(node.name.slice(-1));
  const line = cx.state.doc.lineAt(node.from);
  out.line(node.from, level === 1 ? HEADING_1_CLASSES : HEADING_CLASSES);
  const revealed = isRevealed(cx.reveal, line.from, line.to);
  for (let mark = node.firstChild; mark; mark = mark.nextSibling) {
    if (mark.name !== "HeaderMark") continue;
    // The opening marks take the space after them; closing ones the space
    // before.
    const opening = mark.from === node.from || cx.state.doc.sliceString(line.from, mark.from).trim() === "";
    const from = opening ? mark.from : mark.from - spacesBefore(cx.state.doc, mark.from, line.from);
    const to = opening ? mark.to + spacesAfter(cx.state.doc, mark.to, 1) : mark.to;
    out.syntax(from, to, revealed);
  }
}

function spacesBefore(doc: Text, pos: number, lineFrom: number): number {
  const text = doc.sliceString(lineFrom, pos);
  return /[ \t]*$/.exec(text)?.[0].length ?? 0;
}

function presentSetextHeading(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  const level = node.name === "SetextHeading1" ? 1 : 2;
  const doc = cx.state.doc;
  const underline = node.getChild("HeaderMark");
  const lastText = underline ? doc.lineAt(underline.from).number - 1 : doc.lineAt(node.to).number;
  for (let number = doc.lineAt(node.from).number; number <= lastText; number += 1) {
    out.line(doc.line(number).from, level === 1 ? HEADING_1_CLASSES : HEADING_CLASSES);
  }
  if (underline) out.mute(underline.from, underline.to);
}

function presentEmphasis(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  const tagName = EMPHASIS_TAGS[node.name] ?? "span";
  const markName = EMPHASIS_MARKS[node.name] ?? "EmphasisMark";
  out.mark(node.from, node.to, tagName);
  const revealed = isRevealed(cx.reveal, node.from, node.to);
  for (let mark = node.firstChild; mark; mark = mark.nextSibling) {
    if (mark.name === markName) out.syntax(mark.from, mark.to, revealed);
  }
}

function presentInlineCode(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  // Code is no prose: no spelling underline in it (Л13.2).
  out.mark(node.from, node.to, "code", undefined, { spellcheck: "false" });
  const revealed = isRevealed(cx.reveal, node.from, node.to);
  for (let mark = node.firstChild; mark; mark = mark.nextSibling) {
    if (mark.name === "CodeMark") out.syntax(mark.from, mark.to, revealed);
  }
}

function presentLink(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return;
  const revealed = isRevealed(cx.reveal, node.from, node.to);
  out.mark(open.to, close.from, "a");
  out.syntax(node.from, open.to, revealed);
  out.syntax(close.from, node.to, revealed);
}

function presentAutolink(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  const revealed = isRevealed(cx.reveal, node.from, node.to);
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LinkMark") out.syntax(child.from, child.to, revealed);
    else if (child.name === "URL") out.mark(child.from, child.to, "a", undefined, { spellcheck: "false" });
  }
}

/** The note a wikilink's target names: the part before `#`. */
export function wikilinkNote(target: string): string {
  const hash = target.indexOf("#");
  return (hash < 0 ? target : target.slice(0, hash)).trim();
}

function presentWikilink(out: Collector, node: SyntaxNode, cx: PresentationContext) {
  const doc = cx.state.doc;
  const target = node.getChild(NODE.WikilinkTarget);
  const label = node.getChild(NODE.WikilinkLabel);
  const bar = node.getChild(NODE.WikilinkLabelMark);
  const [open, close] = node.getChildren(NODE.WikilinkMark);
  if (!target || !open || !close) return;
  const revealed = isRevealed(cx.reveal, node.from, node.to);
  const missing = cx.linkMissing(wikilinkNote(doc.sliceString(target.from, target.to)));
  const className = missing ? MISSING_LINK_CLASS : undefined;
  out.syntax(open.from, open.to, revealed);
  out.syntax(close.from, close.to, revealed);
  if (label) {
    out.mark(label.from, label.to, "a", className);
    if (revealed) {
      out.mute(target.from, target.to);
      if (bar) out.mute(bar.from, bar.to);
    } else {
      out.syntax(target.from, label.from, false);
    }
  } else {
    out.mark(target.from, target.to, "a", className);
    if (bar) out.syntax(bar.from, bar.to, revealed);
  }
}

/** The inline HTML of a block: pairs of tags draw their element, a lone tag
 *  stays muted source (Ч4). */
function presentHtmlTags(out: Collector, parent: SyntaxNode, cx: PresentationContext) {
  const doc = cx.state.doc;
  const tags = parent.getChildren("HTMLTag");
  if (tags.length === 0) return;
  const used = new Set<SyntaxNode>();
  for (const [index, tag] of tags.entries()) {
    if (used.has(tag)) continue;
    const text = doc.sliceString(tag.from, tag.to);
    const name = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(text)?.[1]?.toLowerCase();
    if (!name || !PAIRED_HTML_TAGS.has(name)) continue;
    const close = tags.slice(index + 1).find((candidate) => !used.has(candidate)
      && doc.sliceString(candidate.from, candidate.to).toLowerCase().replace(/\s+/g, "") === `</${name}>`);
    if (!close) continue;
    used.add(tag);
    used.add(close);
    const revealed = isRevealed(cx.reveal, tag.from, close.to);
    const title = name === "abbr" ? /\btitle\s*=\s*"([^"]*)"/.exec(text)?.[1] : undefined;
    out.mark(tag.to, close.from, name, undefined, title === undefined ? undefined : { title });
    out.syntax(tag.from, tag.to, revealed);
    out.syntax(close.from, close.to, revealed);
  }
  for (const tag of tags) if (!used.has(tag)) out.mute(tag.from, tag.to);
}

/** A list item: its marker hidden where the reading mode draws one, a task's
 *  box in its place, its further lines under its text (Л7). */
function presentListItem(out: Collector, item: SyntaxNode, cx: PresentationContext, skip: readonly EditorBlock[]) {
  const doc = cx.state.doc;
  const mark = item.getChild("ListMark");
  if (!mark) return;
  const first = doc.lineAt(mark.from);
  // An item whose first line is a block drawn as a widget: the widget takes
  // the line, marker and all.
  if (insideAny(skip, first.from, first.to)) return;
  const task = item.getChild("Task");
  const taskMarker = task?.getChild("TaskMarker") ?? null;
  // The indentation before the marker, after the markers of quotes: the
  // wrapper of the list gives the indentation.
  const indentStart = mark.from - spacesBefore(doc, mark.from, first.from);
  if (taskMarker) {
    const checked = /\[[xX]\]/.test(doc.sliceString(taskMarker.from, taskMarker.to));
    const end = taskMarker.to + spacesAfter(doc, taskMarker.to, 1);
    const revealed = isRevealed(cx.reveal, taskMarker.from, taskMarker.to, "inside");
    const attributes = { "data-task-item": "", "data-task-checked": checked ? "true" : "false" };
    out.line(first.from, revealed ? `${LIST_ITEM_LINE_CLASS} ${LIST_SOURCE_CLASS}` : LIST_ITEM_LINE_CLASS, attributes);
    if (revealed) {
      out.mute(indentStart, end);
    } else {
      out.syntax(indentStart, mark.from, false);
      out.widget(mark.from, end, { kind: "task", checked, item: mark.from });
    }
    // The task's text is its `Task` block, which may go on over lines.
    if (checked) out.mark(end, Math.max(end, task ? task.to : first.to), "span", TASK_DONE_CLASS);
  } else {
    const end = mark.to + spacesAfter(doc, mark.to, 4);
    const revealed = isRevealed(cx.reveal, mark.from, mark.to);
    out.line(first.from, revealed ? `${LIST_ITEM_LINE_CLASS} ${LIST_SOURCE_CLASS}` : LIST_ITEM_LINE_CLASS);
    if (revealed) out.mute(indentStart, end);
    else out.syntax(indentStart, end, false);
  }
  // Further lines of the item, outside its nested lists and its blocks:
  // their indentation is the item's, which the wrapper draws.
  const nested = [...item.getChildren("BulletList"), ...item.getChildren("OrderedList")];
  const lastLine = lastLineOf(doc, item).number;
  for (let number = first.number + 1; number <= lastLine; number += 1) {
    const line = doc.line(number);
    if (nested.some((list) => doc.lineAt(list.from).from <= line.from && line.from <= list.to)) continue;
    if (insideAny(skip, line.from, line.to)) continue;
    if (line.text.trim() === "") continue;
    out.line(line.from, LIST_CONTINUATION_CLASS);
    const quoted = /^(?:[ \t]{0,3}>[ \t]?)*/.exec(line.text)?.[0].length ?? 0;
    const indent = spacesAfter(doc, line.from + quoted, line.length);
    out.syntax(line.from + quoted, line.from + quoted + indent, false);
  }
}

/** The lines of a block shown as source (Л5.3): code, Mermaid and formulas
 *  on the code's zone with their fences muted; the markers of a callout
 *  muted; a table, HTML and media as written. */
function presentRevealedBlock(out: Collector, block: EditorBlock, cx: PresentationContext) {
  const doc = cx.state.doc;
  const styled = SOURCE_STYLED_BLOCKS.has(block.kind);
  if (styled) {
    const first = doc.lineAt(block.from).number;
    const last = doc.lineAt(block.to).number;
    for (let number = first; number <= last; number += 1) {
      const classes = [SOURCE_BLOCK_CLASS];
      if (number === first) classes.push(SOURCE_BLOCK_FIRST_CLASS);
      if (number === last) classes.push(SOURCE_BLOCK_LAST_CLASS);
      out.line(doc.line(number).from, classes.join(" "), { spellcheck: "false" });
    }
  }
  cx.tree.iterate({
    from: block.from,
    to: block.to,
    enter(node) {
      if (node.from < block.from || node.to > block.to) return undefined;
      switch (node.name) {
        case "CodeMark":
        case "CodeInfo":
        case NODE.MathBlockMark:
        case "QuoteMark":
        case "TableDelimiter":
          out.mute(node.from, node.to);
          return false;
        default:
          return undefined;
      }
    },
  });
}

function presentNode(
  out: Collector,
  ref: SyntaxNodeRef,
  cx: PresentationContext,
  skip: readonly EditorBlock[],
): boolean | undefined {
  const doc = cx.state.doc;
  const node = ref.node;
  switch (ref.name) {
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
      presentHeading(out, node, cx);
      presentHtmlTags(out, node, cx);
      return undefined;
    case "SetextHeading1":
    case "SetextHeading2":
      presentSetextHeading(out, node, cx);
      presentHtmlTags(out, node, cx);
      return undefined;
    case "Paragraph":
    case "Task":
    case "TableCell":
      presentHtmlTags(out, node, cx);
      return undefined;
    case "Blockquote":
      if (calloutOpener(doc.lineAt(node.from).text)) return undefined;
      out.items.push({
        type: "wrapper",
        from: doc.lineAt(node.from).from,
        to: wrapperEnd(doc, node),
        tagName: "blockquote",
        rank: OUTERMOST_WRAPPER_RANK - containerDepth(node),
      });
      return undefined;
    case "QuoteMark": {
      const line = doc.lineAt(ref.from);
      out.syntax(ref.from, ref.to + spacesAfter(doc, ref.to, 1), isRevealed(cx.reveal, line.from, line.to));
      return false;
    }
    case "BulletList":
    case "OrderedList": {
      const attributes: Record<string, string> = {};
      const items = node.getChildren("ListItem");
      if (items.some((item) => item.getChild("Task"))) attributes.class = "contains-task-list";
      if (ref.name === "OrderedList") {
        const firstMark = items[0]?.getChild("ListMark");
        const start = firstMark ? parseInt(doc.sliceString(firstMark.from, firstMark.to), 10) : 1;
        if (Number.isFinite(start) && start !== 1) attributes.start = String(start);
      }
      out.items.push({
        type: "wrapper",
        from: doc.lineAt(node.from).from,
        to: wrapperEnd(doc, node),
        tagName: ref.name === "OrderedList" ? "ol" : "ul",
        attributes,
        rank: OUTERMOST_WRAPPER_RANK - containerDepth(node),
      });
      return undefined;
    }
    case "ListItem":
      presentListItem(out, node, cx, skip);
      return undefined;
    case "ListMark":
    case "TaskMarker":
      return false;
    case "HorizontalRule": {
      const line = doc.lineAt(ref.from);
      if (isRevealed(cx.reveal, line.from, line.to)) out.mute(ref.from, ref.to);
      else out.widget(ref.from, ref.to, { kind: "rule" });
      return false;
    }
    case "Emphasis":
    case "StrongEmphasis":
    case NODE.Strikethrough:
    case NODE.Highlight:
      presentEmphasis(out, node, cx);
      return undefined;
    case "InlineCode":
      presentInlineCode(out, node, cx);
      return false;
    case "Link":
      presentLink(out, node, cx);
      return undefined;
    case "Image":
    case NODE.WikilinkEmbed: {
      if (cx.omittedEmbed === ref.from || isRevealed(cx.reveal, ref.from, ref.to)) {
        out.mute(ref.from, ref.to);
      } else {
        out.widget(ref.from, ref.to, { kind: "media", source: doc.sliceString(ref.from, ref.to) });
      }
      return false;
    }
    case "Autolink":
      presentAutolink(out, node, cx);
      return false;
    case "URL":
      // A destination of a link or a picture is its syntax; only a literal
      // address among words is drawn as a link.
      if (ref.node.parent?.name === "Paragraph" || ref.node.parent?.name === "Task" || ref.node.parent?.name === "TableCell") {
        out.mark(ref.from, ref.to, "a", undefined, { spellcheck: "false" });
      }
      return false;
    case NODE.Wikilink:
      presentWikilink(out, node, cx);
      return false;
    case "Escape":
      out.syntax(ref.from, ref.from + 1, isRevealed(cx.reveal, ref.from, ref.to));
      return false;
    case "HardBreak":
      if (doc.sliceString(ref.from, ref.from + 1) === "\\") {
        out.syntax(ref.from, ref.from + 1, isRevealed(cx.reveal, ref.from, ref.to));
      }
      return false;
    case NODE.InlineMath: {
      if (isRevealed(cx.reveal, ref.from, ref.to)) {
        for (const mark of node.getChildren(NODE.InlineMathMark)) out.mute(mark.from, mark.to);
        out.mark(ref.from, ref.to, "span", undefined, { spellcheck: "false" });
      } else {
        const marks = node.getChildren(NODE.InlineMathMark);
        const size = marks[0] ? marks[0].to - marks[0].from : 1;
        out.widget(ref.from, ref.to, { kind: "math", source: doc.sliceString(ref.from + size, ref.to - size) });
      }
      return false;
    }
    case NODE.FootnoteReference: {
      const label = doc.sliceString(ref.from + 2, ref.to - 1);
      const number = cx.footnoteNumber(label);
      if (number !== null && !isRevealed(cx.reveal, ref.from, ref.to)) {
        out.widget(ref.from, ref.to, { kind: "footnote", number });
      }
      return false;
    }
    case NODE.FootnoteDefinitionMark:
    case NODE.BlockId:
    case "Comment":
    case "CommentBlock":
    case "ProcessingInstruction":
    case "LinkReference":
      out.mute(ref.from, ref.to);
      return false;
    case "HTMLTag":
      return false;
    default:
      return undefined;
  }
}

/**
 * What the presentation does in the window of `cx` (Л5.1, Л6, Л7): the
 * items, in no particular order. Blocks drawn as widgets are skipped, blocks
 * shown as source get their source styling, the `\r` that ends a line of a
 * mixed body is hidden (Л0.3).
 */
export function presentationItems(cx: PresentationContext): PresentationItem[] {
  const doc = cx.state.doc;
  const out = new Collector(doc);
  const blocks = collectBlocks(cx.tree, doc, cx.from, cx.to);
  const widgets = blocks.filter((block) => !isBlockRevealed(cx.reveal, block));
  const revealed = blocks.filter((block) => isBlockRevealed(cx.reveal, block));
  for (const block of revealed) presentRevealedBlock(out, block, cx);
  const skip = [...widgets, ...revealed];
  cx.tree.iterate({
    from: cx.from,
    to: cx.to,
    enter(ref) {
      if (ref.name === "Document") return undefined;
      const block = insideAny(skip, ref.from, ref.to);
      if (!block) return presentNode(out, ref, cx, skip);
      // A quote or a list whose whole content is one drawn block (a quote
      // of pictures, a list of one picture) still stands round it, as the
      // reading mode's does (Л8.6).
      if (doc.lineAt(ref.from).from !== block.from || wrapperEnd(doc, ref.node) !== block.to) return false;
      if (ref.name === "ListItem") return undefined;
      if (!CONTAINERS.has(ref.name)) return false;
      presentNode(out, ref, cx, skip);
      return undefined;
    },
  });
  const first = doc.lineAt(cx.from).number;
  const last = doc.lineAt(cx.to).number;
  for (let number = first; number <= last; number += 1) {
    const line = doc.line(number);
    if (line.text.endsWith("\r")) out.items.push({ type: "conceal", from: line.to - 1, to: line.to });
  }
  return out.items;
}

/** The numbers of the footnotes of `tree`: by the order of the first
 *  reference to each label that has a definition, as GFM numbers them (Ч10). */
export function footnoteNumbers(tree: Tree, doc: Text): Map<string, number> {
  const references: string[] = [];
  const defined = new Set<string>();
  tree.iterate({
    enter(node) {
      if (node.name === NODE.FootnoteReference) {
        references.push(doc.sliceString(node.from + 2, node.to - 1).toLowerCase());
        return false;
      }
      if (node.name === NODE.FootnoteDefinition) {
        const mark = node.node.getChild(NODE.FootnoteDefinitionMark);
        if (mark) defined.add(doc.sliceString(mark.from + 2, mark.to - 2).toLowerCase());
      }
      return undefined;
    },
  });
  const numbers = new Map<string, number>();
  for (const label of references) {
    if (defined.has(label) && !numbers.has(label)) numbers.set(label, numbers.size + 1);
  }
  return numbers;
}
