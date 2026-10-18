// The reading pipeline of an article body, one definition for the open card
// and a future editor (SPEC_READING_MODE.md, Ч0.1, Ч13):
//
// 1. `preprocessWikilinks` (markdownWikilinks.ts), outside code, math and HTML;
// 2. remark: the syntax (`syntax.ts`), then the callouts and the note embeds;
// 3. remark-rehype with raw HTML kept and no clobber prefix of its own;
// 4. rehype: `rehype-raw`, then `rehype-sanitize` with the schema below;
// 5. the elements of `ArticleMarkdown`;
// 6. `safeMarkdownUrl` as the URL transform.
//
// The heavy parts (highlighting, Mermaid, KaTeX) load on demand from their
// elements, not as plugins: react-markdown's pipeline is synchronous, and an
// article without code, diagrams or formulas must not load them.

import type { Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";
import {
  CALLOUT_BODY_PROPERTY,
  CALLOUT_FOLD_PROPERTY,
  CALLOUT_PROPERTY,
  CALLOUT_TITLE_PROPERTY,
  CALLOUT_WRITTEN_PROPERTY,
  remarkObsidianCallouts,
} from "./remarkObsidianCallouts";
import {
  NOTE_EMBED_FRAGMENT_PROPERTY,
  NOTE_EMBED_LABEL_PROPERTY,
  NOTE_EMBED_PROPERTY,
  remarkNoteEmbeds,
} from "./remarkNoteEmbeds";
import { READING_SYNTAX_PLUGINS } from "./syntax";

/** The remark plugins: the syntax, then the transforms of the tree. */
export const READING_REMARK_PLUGINS: PluggableList = [
  ...READING_SYNTAX_PLUGINS,
  remarkObsidianCallouts,
  remarkNoteEmbeds,
];

/** remark-rehype: raw HTML reaches `rehype-raw` (Ч4); no clobber prefix,
 *  because the sanitizer adds the one `user-content-` (Ч10): with both, ids
 *  got it twice and footnote links lost their targets. */
export const READING_REMARK_REHYPE_OPTIONS: NonNullable<Options["remarkRehypeOptions"]> = {
  allowDangerousHtml: true,
  clobberPrefix: "",
};

/** Elements removed with their content: what runs code, styles the page,
 *  embeds another document or plays media of its own (Ч4). */
const STRIPPED_ELEMENTS = ["script", "style", "iframe", "object", "embed", "form", "video", "audio", "template"];

const defaultAttributes = defaultSchema.attributes ?? {};

/** The sanitizer's schema (Ч4): GitHub's, as `hast-util-sanitize` 5.0.2
 *  has it, plus `mark`, `u` and `abbr`, which Obsidian notes often use, the
 *  `data-mine-*` properties of the pipeline's own elements, and the classes
 *  of math. Addresses are checked by `safeMarkdownUrl`, as for Markdown, not
 *  by the schema's protocol lists: those would drop a local file whose name
 *  holds a colon. */
export const READING_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "abbr"],
  attributes: {
    ...defaultAttributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    div: [
      ...(defaultAttributes.div ?? []),
      CALLOUT_PROPERTY,
      CALLOUT_WRITTEN_PROPERTY,
      CALLOUT_FOLD_PROPERTY,
      CALLOUT_TITLE_PROPERTY,
      CALLOUT_BODY_PROPERTY,
    ],
    span: [
      ...(defaultAttributes.span ?? []),
      NOTE_EMBED_PROPERTY,
      NOTE_EMBED_FRAGMENT_PROPERTY,
      NOTE_EMBED_LABEL_PROPERTY,
    ],
  },
  protocols: {},
  strip: STRIPPED_ELEMENTS,
};

/** The rehype plugins: HTML into elements, then the sanitizer. */
export const READING_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, READING_SANITIZE_SCHEMA],
];
