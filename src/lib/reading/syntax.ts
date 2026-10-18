// The syntax the reading pipeline understands, one list for every reader of
// an article body (SPEC_READING_MODE.md, Ч0.1, Ч0.2): the pipeline that draws
// it and the wikilink pre-processing that must know where code, math and
// HTML stand. Plugins that only add syntax, in the order they register their
// constructs; the transforms of the drawn tree (callouts, note embeds) are the
// pipeline's (`pipeline.ts`).

import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";
import { remarkMark } from "./remarkMark";
import { remarkObsidianInlineMath } from "./remarkObsidianInlineMath";

/** The plugins that add syntax. `remark-math` reads only `$$` (Ч9);
 *  `remarkObsidianInlineMath` after it reads `$…$`. */
export const READING_SYNTAX_PLUGINS: PluggableList = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
  remarkObsidianInlineMath,
  remarkMark,
];

// Made at the first parse, not on import: the feed imports helpers of
// `markdownWikilinks.ts`, and a processor built at module level would keep
// the whole parser in the first screen's bundle.
let syntaxParser: ReturnType<typeof createSyntaxParser> | null = null;

function createSyntaxParser() {
  return unified().use(remarkParse).use(READING_SYNTAX_PLUGINS).freeze();
}

/** The Markdown tree of `markdown` as the reading pipeline parses it, before
 *  its transforms. */
export function parseReadingSyntax(markdown: string): Root {
  syntaxParser ??= createSyntaxParser();
  return syntaxParser.parse(markdown);
}
