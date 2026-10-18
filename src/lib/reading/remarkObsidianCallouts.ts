// Obsidian callouts (SPEC_READING_MODE.md, Ч8): a quote whose first line is
// `[!type]` becomes a callout. The first paragraph splits at its first line
// break into the title and the body; the body keeps its place in the source
// from the next line, so selection extraction and the jump to a block find
// it as they find any paragraph (Ч0.3). `rehype-callouts` was not taken: it
// leaves an unknown type a quote and loses that position.
//
// The tree it leaves: `callout` (drawn as `div[data-mine-callout]`) holding a
// `calloutTitle` (`div[data-mine-callout-title]`) and a `calloutBody`
// (`div[data-mine-callout-body]`). `Callout` draws them.

import type { Blockquote, Nodes, Paragraph, PhrasingContent, Root, RootContent, Text } from "mdast";
import type { Point, Position } from "unist";
import type { VFile } from "vfile";
import { calloutFold, defaultCalloutTitle, resolveCalloutType, type CalloutFold } from "./callouts";

declare module "mdast" {
  /** A callout: its title, then its body. */
  interface Callout extends Parent {
    type: "callout";
    children: [CalloutTitle, CalloutBody];
  }

  /** The title line of a callout. */
  interface CalloutTitle extends Parent {
    type: "calloutTitle";
    children: PhrasingContent[];
  }

  /** The content of a callout under its title. */
  interface CalloutBody extends Parent {
    type: "calloutBody";
    children: Array<BlockContent | DefinitionContent>;
  }

  interface BlockContentMap {
    callout: Callout;
  }

  interface RootContentMap {
    callout: Callout;
    calloutTitle: CalloutTitle;
    calloutBody: CalloutBody;
  }
}

/** `[!type]` and the fold sign at the start of a quote's first line. */
const CALLOUT_OPENER = /^\[!([^\]\s]+)\]([+-]?)/;
/** What stands before a paragraph's text on a line of a quote: the markers
 *  of every quote it is in, or none on a lazy line. */
const QUOTE_LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*/;

/** The `data-mine-*` properties a callout's parts are drawn with. */
export const CALLOUT_PROPERTY = "dataMineCallout";
export const CALLOUT_WRITTEN_PROPERTY = "dataMineCalloutWritten";
export const CALLOUT_FOLD_PROPERTY = "dataMineCalloutFold";
export const CALLOUT_TITLE_PROPERTY = "dataMineCalloutTitle";
export const CALLOUT_BODY_PROPERTY = "dataMineCalloutBody";

interface SplitParagraph {
  title: PhrasingContent[];
  body: Paragraph | null;
}

function point(source: string, offset: number, line: number): Point {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return { line, column: offset - lineStart + 1, offset };
}

/** Where the paragraph's second line starts in the source, past the quote's
 *  markers; `null` when the text node holds no source line break there (a
 *  `&#10;` makes a line break of its own). */
function secondLineStart(source: string, text: Text): Point | null {
  const start = text.position?.start;
  const end = text.position?.end.offset;
  if (start?.offset === undefined || end === undefined) return null;
  const lineEnd = source.indexOf("\n", start.offset);
  if (lineEnd === -1 || lineEnd >= end) return null;
  const prefix = QUOTE_LINE_PREFIX.exec(source.slice(lineEnd + 1, end))?.[0] ?? "";
  return point(source, lineEnd + 1 + prefix.length, start.line + 1);
}

/** The first paragraph cut at its first line break: the title line, and the
 *  rest as a paragraph of its own from the next source line. */
function splitFirstLine(source: string, paragraph: Paragraph): SplitParagraph {
  const children = paragraph.children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type === "break") {
      const rest = children.slice(index + 1);
      const start = rest[0]?.position?.start;
      return {
        title: children.slice(0, index),
        body: rest.length > 0 && start ? bodyParagraph(rest, start, paragraph.position) : null,
      };
    }
    if (child.type !== "text") continue;
    const lineBreak = child.value.indexOf("\n");
    if (lineBreak === -1) continue;
    const start = secondLineStart(source, child);
    if (!start) continue;
    const head: Text = { type: "text", value: child.value.slice(0, lineBreak) };
    const tail: Text = {
      type: "text",
      value: child.value.slice(lineBreak + 1).replace(/^[ \t]+/, ""),
      position: child.position ? { start, end: child.position.end } : undefined,
    };
    const rest = [...(tail.value ? [tail] : []), ...children.slice(index + 1)];
    return {
      title: [...children.slice(0, index), head],
      body: rest.length > 0 ? bodyParagraph(rest, start, paragraph.position) : null,
    };
  }
  return { title: children, body: null };
}

function bodyParagraph(
  children: PhrasingContent[],
  start: Point,
  paragraph: Position | undefined,
): Paragraph {
  return {
    type: "paragraph",
    children,
    position: paragraph ? { start, end: paragraph.end } : undefined,
  };
}

/** The title's inline content without the opener, its edges trimmed; the
 *  type as written when the line holds nothing else. */
function titleChildren(title: PhrasingContent[], openerLength: number, written: string): PhrasingContent[] {
  const [first, ...rest] = title;
  const children: PhrasingContent[] = [];
  if (first?.type === "text") {
    const value = first.value.slice(openerLength).replace(/^[ \t]+/, "");
    if (value) children.push({ type: "text", value });
  }
  children.push(...rest);
  const last = children[children.length - 1];
  if (last?.type === "text") {
    last.value = last.value.replace(/[ \t]+$/, "");
    if (!last.value) children.pop();
  }
  return children.length > 0 ? children : [{ type: "text", value: defaultCalloutTitle(written) }];
}

/** The callout a quote is, or `null` when its first line is no `[!type]`. */
function calloutOf(source: string, quote: Blockquote): RootContent | null {
  const [first, ...others] = quote.children;
  if (first?.type !== "paragraph") return null;
  const lead = first.children[0];
  if (lead?.type !== "text") return null;
  const opener = CALLOUT_OPENER.exec(lead.value);
  if (!opener) return null;
  const written = opener[1] ?? "";
  const fold: CalloutFold = calloutFold(opener[2] ?? "");
  const { title, body } = splitFirstLine(source, first);
  return {
    type: "callout",
    children: [
      {
        type: "calloutTitle",
        children: titleChildren(title, opener[0].length, written),
        data: { hName: "div", hProperties: { [CALLOUT_TITLE_PROPERTY]: "" } },
      },
      {
        type: "calloutBody",
        children: [...(body ? [body] : []), ...others],
        data: { hName: "div", hProperties: { [CALLOUT_BODY_PROPERTY]: "" } },
      },
    ],
    position: quote.position,
    data: {
      hName: "div",
      hProperties: {
        [CALLOUT_PROPERTY]: resolveCalloutType(written),
        [CALLOUT_WRITTEN_PROPERTY]: written,
        ...(fold ? { [CALLOUT_FOLD_PROPERTY]: fold } : {}),
      },
    },
  };
}

function transform(source: string, node: Nodes) {
  if (!("children" in node)) return;
  // Any child may be replaced by any node: the array is read and written as
  // the union of nodes, which every parent's children belong to.
  const children = node.children as Nodes[];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child?.type === "blockquote") {
      const callout = calloutOf(source, child);
      if (callout) children[index] = callout;
    }
    const current = children[index];
    if (current) transform(source, current);
  }
}

/** The remark plugin of Obsidian callouts: every quote that is one, at any
 *  depth (in lists, footnotes, other callouts). */
export function remarkObsidianCallouts() {
  return (tree: Root, file: VFile) => {
    transform(String(file), tree);
  };
}
