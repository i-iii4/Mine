// Where a link into a note points (SPEC_READING_MODE.md, Ч11.8): the part
// after `#` of `![[Note#Heading]]`, `![[Note#A#B]]` and `![[Note#^block]]`,
// and of a related note's target, found in the open article the way
// Obsidian 1.13.7 finds it (`resolveSubpath`, `stripHeading` and the
// metadata cache of its `obsidian.asar`): a heading is one of the note's own
// headings, not one inside a quote, a callout or a list, matched by its text
// with special characters taken out and letter case ignored, each `#` part
// under the one before; a block is the one whose `^id` ends it, its id
// matched in any letter case. Nothing is found: the card opens at its top.

import type { Heading, Nodes } from "mdast";
import { markdownSourceOffset } from "@/lib/markdownWikilinks";
import { parseReadingSyntax } from "./syntax";

/** A place in a note: a block by its id, or a heading by the path of
 *  headings that leads to it. */
export type ArticleAnchor =
  | { kind: "block"; id: string }
  | { kind: "heading"; path: readonly string[] };

/** One of a note's own headings: its level, its text as written (Markdown and
 *  wikilinks included, as Obsidian's cache keeps it) and where it starts in
 *  the body. */
export interface SourceHeading {
  level: number;
  text: string;
  start: number;
}

/** The characters Obsidian replaces by a space before it compares headings
 *  (`stripHeading`). */
const HEADING_SPECIAL_CHARACTERS = /[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\\r\n]/g;
/** The blocks a `^id` may end; a lone `^id` paragraph names the block before
 *  it, as Obsidian writes the id of a list, a quote or a table. */
const BLOCK_ELEMENTS = "p, li, blockquote, h1, h2, h3, h4, h5, h6";
/** What is no text of the note: code, formulas and the cards of embeds,
 *  whose preview may hold a `^` of another note. */
const OUTSIDE_TEXT = "pre, code, .katex, [data-note-embed]";

/** The place `subpath` names, the part of a link after its first `#`, or
 *  `null` when it names none (empty, or a footnote `[^1]`, which the article
 *  does not jump to). */
export function parseArticleAnchor(subpath: string): ArticleAnchor | null {
  const parts = subpath.split("#").filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const [first] = parts;
  if (parts.length === 1 && first !== undefined) {
    if (first.startsWith("^")) {
      const id = first.slice(1).trim();
      return id ? { kind: "block", id } : null;
    }
    if (first.startsWith("[^")) return null;
  }
  return { kind: "heading", path: parts };
}

/** A heading as Obsidian compares it: every special character a space, runs
 *  of spaces one, no space at the ends. */
export function stripHeading(text: string): string {
  return text.replace(HEADING_SPECIAL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}

function sameHeading(written: string, target: string): boolean {
  return stripHeading(written).toLowerCase() === stripHeading(target).toLowerCase();
}

/** Which of `headings` the `path` of `Note#A#B` names, by Obsidian's walk:
 *  headings in order, each part matching a heading deeper than the one the
 *  part before matched; `null` when a part matches none. */
export function matchHeading(headings: readonly Pick<SourceHeading, "level" | "text">[], path: readonly string[]): number | null {
  if (path.length === 0) return null;
  let part = 0;
  let level = 0;
  for (const [index, heading] of headings.entries()) {
    const target = path[part];
    if (target === undefined || heading.level <= level || !sameHeading(heading.text, target)) continue;
    part += 1;
    level = heading.level;
    if (part === path.length) return index;
  }
  return null;
}

/** The note's own headings in `body`, as Obsidian's cache keeps them: those
 *  of the document's top level, their text from the first to the last of
 *  their content as written. */
export function sourceHeadings(body: string): SourceHeading[] {
  const headings: SourceHeading[] = [];
  for (const node of parseReadingSyntax(body).children) {
    if (node.type !== "heading") continue;
    const start = node.position?.start.offset;
    if (start === undefined) continue;
    headings.push({ level: node.depth, text: headingText(body, node), start });
  }
  return headings;
}

function headingText(body: string, heading: Heading): string {
  const first: Nodes | undefined = heading.children[0];
  const last: Nodes | undefined = heading.children[heading.children.length - 1];
  const from = first?.position?.start.offset;
  const to = last?.position?.end.offset;
  return from === undefined || to === undefined ? "" : body.slice(from, to).trim();
}

/** Whether the text of `node` is the note's own, not code, a formula or an
 *  embed's card. */
function isNoteText(node: Node): boolean {
  return node.parentElement !== null && node.parentElement.closest(OUTSIDE_TEXT) === null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBlock(root: HTMLElement, id: string): HTMLElement | null {
  // The id ends its block: at the end of its text, after a space or alone.
  const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(id)}\\s*$`, "i");
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!marker.test(node.textContent ?? "") || !isNoteText(node)) continue;
    const block = node.parentElement?.closest<HTMLElement>(BLOCK_ELEMENTS) ?? null;
    if (!block || !root.contains(block)) return null;
    const alone = block.tagName === "P" && (block.textContent ?? "").trim().toLowerCase() === `^${id.toLowerCase()}`;
    const before = block.previousElementSibling;
    return alone && before instanceof HTMLElement ? before : block;
  }
  return null;
}

function findHeading(root: HTMLElement, body: string, path: readonly string[]): HTMLElement | null {
  const headings = sourceHeadings(body);
  const index = matchHeading(headings, path);
  const target = index === null ? undefined : headings[index];
  if (!target) return null;
  // The drawn heading starts where the source's does once the wikilinks
  // before it are mapped back (`data-mine-md-start` is of the rendered body).
  for (const element of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    const rendered = Number(element.getAttribute("data-mine-md-start"));
    if (Number.isInteger(rendered) && markdownSourceOffset(body, rendered) === target.start) return element;
  }
  return null;
}

/**
 * The element of the article under `root` that `anchor` names in `body`, the
 * body the article draws; `null` when the note has no such place, and the
 * card then stays at its top.
 */
export function findArticleAnchor(root: HTMLElement, body: string, anchor: ArticleAnchor): HTMLElement | null {
  return anchor.kind === "block" ? findBlock(root, anchor.id) : findHeading(root, body, anchor.path);
}
