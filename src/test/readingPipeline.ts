// The reading pipeline as plain trees, for tests of its plugins and schema:
// the Markdown tree after the remark plugins and the drawn tree (hast) after
// rehype, both from the pipeline's own lists.

import type { Root as MdastRoot } from "mdast";
import type { Element, Nodes, Root as HastRoot } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import {
  READING_REHYPE_PLUGINS,
  READING_REMARK_PLUGINS,
  READING_REMARK_REHYPE_OPTIONS,
} from "@/lib/reading/pipeline";

/** The Markdown tree of `markdown` after the pipeline's remark plugins. */
export function readingMdast(markdown: string): MdastRoot {
  const processor = unified().use(remarkParse).use(READING_REMARK_PLUGINS);
  // The remark plugins change the tree in place: it stays a Markdown root,
  // which unified's types do not follow through a plugin list.
  return processor.runSync(processor.parse(markdown), markdown) as MdastRoot;
}

/** The drawn tree of `markdown`: remark, remark-rehype and rehype as the
 *  article runs them. */
export function readingHast(markdown: string): HastRoot {
  const processor = unified()
    .use(remarkParse)
    .use(READING_REMARK_PLUGINS)
    .use(remarkRehype, READING_REMARK_REHYPE_OPTIONS)
    .use(READING_REHYPE_PLUGINS);
  // remark-rehype turns the tree into hast; unified's types keep the
  // Markdown root's type through the chain.
  return processor.runSync(processor.parse(markdown), markdown) as HastRoot;
}

/** Every element of `tree` named `tagName`, in document order. */
export function hastElementsNamed(tree: Nodes, tagName: string): Element[] {
  const found: Element[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element" && node.tagName === tagName) found.push(node);
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return found;
}

/** Every node of a Markdown tree of `type`, in document order. The caller
 *  names the node type it asks for, which `type` decides. */
export function mdastNodesOfType<T extends { type: string }>(tree: { type: string }, type: string): T[] {
  const found: T[] = [];
  const visit = (node: { type: string; children?: unknown[] }) => {
    if (node.type === type) found.push(node as T);
    for (const child of node.children ?? []) visit(child as { type: string; children?: unknown[] });
  };
  visit(tree as { type: string; children?: unknown[] });
  return found;
}
