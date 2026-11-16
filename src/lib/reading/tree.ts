// The tree the reading pipeline draws, kept (SPEC_READING_MODE.md, Ч0.5):
// one tree of a body for everything that reads it on the card's way to the
// page. The pipeline draws it, and the open card reads its lead video, its
// body's videos and whether the body holds more than an embed from the same
// tree, so what the card decides is what the article shows.
//
// The tree is the rendered text's syntax tree (`parseRenderedBody`, one
// parse of the body) after the pipeline's transforms: callouts and note
// embeds. It is kept by the rendered text and never changed once made: the
// pipeline's later steps build their own tree from it on every drawing.

import type { Nodes, Root } from "mdast";
import { unified, type PluggableList, type Processor } from "unified";
import { parseRenderedBody, TextCache } from "@/lib/markdownWikilinks";
import { READING_TREE_TRANSFORMS } from "./pipeline";

// Made at the first tree, not on import, as the syntax parser is.
let transforms: ReturnType<typeof createTransforms> | null = null;

function createTransforms() {
  return unified().use(READING_TREE_TRANSFORMS).freeze();
}

const trees = new TextCache<Root>();

/** The tree the pipeline draws of `processedBody`, a body after
 *  `preprocessWikilinks`: its syntax, then callouts and note embeds. Made
 *  once while the text is kept; read only. */
export function readingTree(processedBody: string): Root {
  return trees.get(processedBody, (text) => {
    transforms ??= createTransforms();
    // The transforms change the tree in place: it stays a Markdown root,
    // which unified's types do not follow through a plugin list.
    return transforms.runSync(parseRenderedBody(text), text) as Root;
  });
}

/** The remark plugin that gives the pipeline its kept tree in place of a
 *  parse of its own; it registers after react-markdown's own parser and
 *  takes its place. */
export function remarkKeptReadingTree(this: Processor) {
  this.parser = (document: string) => readingTree(document);
}

/** The remark plugins `ArticleMarkdown` hands to react-markdown: the kept
 *  tree alone, which already went through `READING_REMARK_PLUGINS`. */
export const READING_KEPT_TREE_PLUGINS: PluggableList = [remarkKeptReadingTree];

/**
 * Where the first image whose destination `matches` starts in
 * `processedBody`, the body the pipeline draws; `null` when there is none.
 * Images are visited in document order, as the reader sees them.
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
  visit(readingTree(processedBody));
  return found;
}
