// One parse of a body on its way to the page (SPEC_READING_MODE.md, Ч0.5).
// The wikilink pre-processing parses the body as written to learn where
// code, math and HTML stand, and the pipeline draws the tree of the rendered
// text, the body with its wikilinks rewritten. These are two texts, and
// parsing both parsed every body with a wikilink twice. The rewrites touch
// few lines, so the rendered text's tree is made of the first parse: the
// blocks that hold a rewrite are read again from the rendered text, the rest
// keep their nodes and move to their places in it.
//
// The tree made here equals `parseReadingSyntax(text)` node for node, places
// included, or the function gives `null` and the caller parses the text. It
// rests on what Markdown's block structure is: lines read in order, and a
// top-level block that a blank line has ended owes nothing to the lines
// after it. The conditions below keep to the cases where that holds, each
// with its reason; `renderedTree.test.ts` compares the made tree with the
// parsed one over the fixtures and over generated bodies.

import type { Nodes, Root, RootContent } from "mdast";
import { parseReadingSyntax } from "./syntax";

/** One rewrite of the pre-processing: where it stands in the body as
 *  written and where its replacement stands in the rendered text. */
export interface BodyRewrite {
  sourceStart: number;
  sourceEnd: number;
  renderedStart: number;
  renderedEnd: number;
}

/** Nodes a document reads as a whole: a reference anywhere resolves by
 *  them, so a block read alone would not see them. */
const DEFINITION_TYPES: ReadonlySet<string> = new Set(["definition", "footnoteDefinition"]);

/** Top-level blocks a blank line ends whatever stands after it. A list goes
 *  on past a blank line when the next line continues it, and code, math and
 *  HTML may run to their own closing line. */
const ENDED_BY_BLANK_LINE: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "table",
  "thematicBreak",
]);

/** What a line starts with when it may continue or begin a list: a bullet
 *  or a digit of an ordered item. */
const LIST_MARKER_START = /^[-+*0-9]/;

const ONLY_SPACE = /^[ \t\r\n]*$/;
/** Spaces, with a blank line among them: two line endings or more. */
const BLANK_LINES = /^[ \t]*(?:(?:\r\n|\n|\r)[ \t]*){2,}$/;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/** Top-level blocks with only blank lines round them: `from` to `to` are
 *  whole lines of the body as written. */
interface BlockGroup {
  nodes: RootContent[];
  from: number;
  to: number;
  /** The line the group starts on, from 1. */
  line: number;
  dirty: boolean;
}

function holdsDefinition(node: Nodes): boolean {
  if (DEFINITION_TYPES.has(node.type)) return true;
  return "children" in node && node.children.some(holdsDefinition);
}

/** Moves `node` and all under it by `offset` characters and `lines` lines.
 *  Columns stay: a moved block keeps its lines as they are. */
function move(node: Nodes, offset: number, lines: number): void {
  const position = node.position;
  if (position) {
    if (position.start.offset !== undefined) position.start.offset += offset;
    if (position.end.offset !== undefined) position.end.offset += offset;
    position.start.line += lines;
    position.end.line += lines;
  }
  if ("children" in node) for (const child of node.children) move(child, offset, lines);
}

function isLineEnding(code: number): boolean {
  return code === LINE_FEED || code === CARRIAGE_RETURN;
}

/** The start of the line `offset` stands on. */
function lineStart(text: string, offset: number): number {
  let start = offset;
  while (start > 0 && !isLineEnding(text.charCodeAt(start - 1))) start -= 1;
  return start;
}

/** The end of the line `offset` stands on, before its line ending. */
function lineEnd(text: string, offset: number): number {
  let end = offset;
  while (end < text.length && !isLineEnding(text.charCodeAt(end))) end += 1;
  return end;
}

/** The top-level blocks of `source` in groups parted by blank lines; `null`
 *  when something other than space stands between two blocks or round them,
 *  which the tree does not account for. */
function blockGroups(source: Root, body: string): BlockGroup[] | null {
  const groups: BlockGroup[] = [];
  let previousEnd = 0;
  let current: BlockGroup | null = null;
  for (const node of source.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const line = node.position?.start.line;
    if (start === undefined || end === undefined || line === undefined) return null;
    const gap = body.slice(previousEnd, start);
    if (current && !BLANK_LINES.test(gap)) {
      // The next line of the same group: nothing but its line ending and
      // indentation parts the two blocks.
      if (!ONLY_SPACE.test(gap)) return null;
      current.nodes.push(node);
      current.to = lineEnd(body, end);
    } else {
      if (!ONLY_SPACE.test(gap)) return null;
      current = { nodes: [node], from: lineStart(body, start), to: lineEnd(body, end), line, dirty: false };
      groups.push(current);
    }
    previousEnd = end;
  }
  return ONLY_SPACE.test(body.slice(previousEnd)) ? groups : null;
}

/** Whether the block that follows a list read alone surely ends it: the
 *  line starts at its first column with what neither continues an item (it
 *  would be indented) nor begins one. */
function endsList(body: string, next: BlockGroup): boolean {
  const start = next.nodes[0]?.position?.start.offset;
  return start === next.from && !LIST_MARKER_START.test(body.slice(start, start + 1));
}

/**
 * The syntax tree of `text`, the rendered text of `body`, made of `source`,
 * the tree of `body` as written, and the `rewrites` between the two; `null`
 * when it cannot be told to equal `parseReadingSyntax(text)`. `source` is
 * used up: its nodes go into the tree made, moved to their new places.
 *
 * Why the tree made is the parsed one:
 *
 * - A rewrite stays on its line and its replacement starts with the same
 *   sign as the wikilink (`[` or `!`), so every line keeps its indentation
 *   and its first sign: what continues or ends the block above it does not
 *   change. An empty replacement would break this, and gives `null`.
 * - A group of blocks with blank lines round it and no rewrite in it reads
 *   the same in both texts and keeps its nodes, moved by the length the
 *   rewrites before it added.
 * - Groups with a rewrite, and the blank lines between neighbours of them,
 *   are read again from the rendered text alone. That is what the whole
 *   text gives there, provided the block above had ended (the blank line
 *   and the unchanged first sign) and the last block read ends before what
 *   follows: it is one a blank line ends, or a list before a line that
 *   surely ends it, or the text's last.
 * - No block of either text defines a link or a footnote: references
 *   resolve across the whole document, and a part read alone would miss
 *   them.
 */
export function assembleRenderedTree(
  source: Root,
  body: string,
  text: string,
  rewrites: readonly BodyRewrite[],
): Root | null {
  if (rewrites.length === 0) return source;
  if (rewrites.some((rewrite) => rewrite.renderedEnd === rewrite.renderedStart)) return null;
  if (holdsDefinition(source)) return null;
  const groups = blockGroups(source, body);
  const sourceEnd = source.position?.end;
  if (!groups || !sourceEnd) return null;

  // Each rewrite lies in one group, whole.
  let group = 0;
  for (const rewrite of rewrites) {
    while (group < groups.length && (groups[group]?.to ?? 0) < rewrite.sourceEnd) group += 1;
    const holder = groups[group];
    if (!holder || rewrite.sourceStart < holder.from) return null;
    holder.dirty = true;
  }

  const children: RootContent[] = [];
  // How much longer the rendered text is than the body, up to the place read.
  let added = 0;
  let rewrite = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const first = groups[index];
    if (!first) return null;
    if (!first.dirty) {
      if (added !== 0) for (const node of first.nodes) move(node, added, 0);
      children.push(...first.nodes);
      continue;
    }
    // The run of neighbouring groups with rewrites, read as one part.
    let last = first;
    while (groups[index + 1]?.dirty) {
      index += 1;
      last = groups[index] ?? last;
    }
    const from = first.from + added;
    for (; rewrite < rewrites.length; rewrite += 1) {
      const next = rewrites[rewrite];
      if (!next || next.sourceStart >= last.to) break;
      added += (next.renderedEnd - next.renderedStart) - (next.sourceEnd - next.sourceStart);
    }
    const part = parseReadingSyntax(text.slice(from, last.to + added));
    const tail = part.children[part.children.length - 1];
    const following = groups[index + 1];
    if (!tail || holdsDefinition(part)) return null;
    if (following && !ENDED_BY_BLANK_LINE.has(tail.type) && !(tail.type === "list" && endsList(body, following))) {
      return null;
    }
    for (const node of part.children) move(node, from, first.line - 1);
    children.push(...part.children);
  }

  const lastLine = lineStart(text, text.length);
  return {
    type: "root",
    children,
    position: {
      start: source.position?.start ?? { line: 1, column: 1, offset: 0 },
      end: { line: sourceEnd.line, column: text.length - lastLine + 1, offset: text.length },
    },
  };
}
