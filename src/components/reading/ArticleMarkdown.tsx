import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useId,
  useMemo,
  type ComponentProps,
  type ComponentType,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import type { Element, ElementContent } from "hast";
import { resolveNoteLink } from "@/lib/commands";
import { logFailure } from "@/lib/appLog";
import { decodeWikilinkHref, markdownSourceByteOffset, preprocessWikilinks } from "@/lib/markdownWikilinks";
import { safeMarkdownUrl } from "@/lib/markdownUrl";
import { scrollBehavior } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { isCalloutType, type CalloutFold } from "@/lib/reading/callouts";
import { hastClasses, hastCodeLanguage, hastCodeOfPre, hastElements, hastText } from "@/lib/reading/hast";
import {
  READING_REHYPE_PLUGINS,
  READING_REMARK_PLUGINS,
  READING_REMARK_REHYPE_OPTIONS,
} from "@/lib/reading/pipeline";
import {
  CALLOUT_BODY_PROPERTY,
  CALLOUT_FOLD_PROPERTY,
  CALLOUT_PROPERTY,
  CALLOUT_TITLE_PROPERTY,
} from "@/lib/reading/remarkObsidianCallouts";
import {
  NOTE_EMBED_FRAGMENT_PROPERTY,
  NOTE_EMBED_LABEL_PROPERTY,
  NOTE_EMBED_PROPERTY,
} from "@/lib/reading/remarkNoteEmbeds";
import { ArticleTable } from "./ArticleTable";
import { Callout, CalloutBody, CalloutTitle } from "./Callout";
import { CodeBlock } from "./CodeBlock";
import { DisclosureRoot, DisclosureSummary } from "./Disclosure";
import { MathView } from "./MathView";
import { MermaidDiagram } from "./MermaidDiagram";
import { NoteEmbed, type NoteEmbedLookups } from "./NoteEmbed";
import { InertCheckbox, TaskCheckbox, useTaskState, type TaskBoxes } from "./TaskCheckbox";
import { actOnReadingElement, clickEvent } from "./readingIntents";
import type { NoteLinkTarget } from "@/lib/reading/intents";

/** The log line of a wikilink whose note could not be looked up. */
export const NOTE_LINK_LOOKUP_FAILED_TITLE = "Could not resolve the note link";
/** The prefix the sanitizer puts on every `id` of the article (Ч4, Ч10). */
const USER_CONTENT_ID_PREFIX = "user-content-";

/** The article's own classes: the reading styles (`article.css`) over
 *  Tailwind Typography, the design system's line heights. */
export const ARTICLE_ROOT_CLASSES =
  "mine-article prose prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_li]:leading-5 [&_p]:leading-5";
/** Article headings on the design system's scale instead of Typography's. */
export const ARTICLE_H1_CLASSES = "mt-0 mb-4 text-lg leading-6 font-semibold";
export const ARTICLE_SECTION_HEADING_CLASSES = "mt-6 mb-2 text-base leading-5 font-semibold";

/** What the article's elements read: the body, the card it belongs to and
 *  what the host lends them. */
interface ArticleState {
  body: string;
  sourceSlug: string | undefined;
  vaultPath: string;
  thumbsRootPath: string | undefined;
  noteEmbeds: NoteEmbedLookups;
  tasks: TaskBoxes | null;
  Image: ComponentType<ComponentProps<"img"> & ExtraProps>;
  onOpenNote: (slug: string) => void;
}

const ArticleContext = createContext<ArticleState | null>(null);

function useArticle(): ArticleState {
  const state = useContext(ArticleContext);
  if (!state) throw new Error("An article element is drawn outside ArticleMarkdown");
  return state;
}

type ElementProps<Tag extends "a" | "blockquote" | "code" | "details" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "img" | "input" | "li" | "p" | "pre" | "span" | "summary" | "table"> =
  ComponentProps<Tag> & ExtraProps;

/** `data-mine-md-start` and `data-mine-md-end`: where a block stands in the
 *  rendered Markdown (Ч0.3). Selection extraction, the jump to `^block` and
 *  task boxes stand on them. */
export function markdownBlockPositionProps(
  node: Element | undefined,
): { "data-mine-md-start"?: string; "data-mine-md-end"?: string } {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (
    typeof start !== "number"
    || typeof end !== "number"
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || end <= start
  ) {
    return {};
  }
  return { "data-mine-md-start": String(start), "data-mine-md-end": String(end) };
}

function isNoteEmbed(node: ElementContent): boolean {
  return node.type === "element" && node.tagName === "span" && node.properties?.[NOTE_EMBED_PROPERTY] !== undefined;
}

/** Whether a paragraph holds media (pictures, videos, note embeds) and
 *  whether anything else. */
export function paragraphMediaLayout(node: Element | undefined): "none" | "media-only" | "mixed-media" {
  let hasMedia = false;
  let hasOther = false;
  for (const child of node?.children ?? []) {
    if (child.type === "element" && (child.tagName === "img" || child.tagName === "video" || isNoteEmbed(child))) {
      hasMedia = true;
      continue;
    }
    if (child.type === "text" && !/\S/.test(child.value)) continue;
    hasOther = true;
  }
  if (!hasMedia) return "none";
  return hasOther ? "mixed-media" : "media-only";
}

function Paragraph({ node, className, ...props }: ElementProps<"p">) {
  const layout = paragraphMediaLayout(node);
  if (layout === "media-only") {
    return (
      <div
        {...markdownBlockPositionProps(node)}
        {...props}
        className={cn("not-prose my-5 leading-none", className)}
        data-article-media-stack=""
      />
    );
  }
  if (layout === "mixed-media") {
    return <div {...markdownBlockPositionProps(node)} {...props} className={cn("my-5 leading-5", className)} />;
  }
  return <p {...markdownBlockPositionProps(node)} {...props} className={className} />;
}

/** The GFM box of a task item: an `input` the Markdown made (it has no
 *  place in the source), first in the item or in its first paragraph. A
 *  checkbox from the note's HTML has one and is no task (Ч4, Ч12.5). */
function gfmTaskInput(item: Element | undefined): Element | null {
  if (!item || !hastClasses(item).includes("task-list-item")) return null;
  const [first] = hastElements(item);
  const candidate = first?.tagName === "p" ? hastElements(first)[0] : first;
  return candidate?.tagName === "input" && candidate.position === undefined ? candidate : null;
}

/** A nested list among an item's children: it stands under the task's
 *  text, outside its label. */
function isListElement(child: ReactNode): boolean {
  return isValidElement(child) && (child.type === "ul" || child.type === "ol");
}

function ListItem({ node, children, className, ...props }: ElementProps<"li">) {
  const article = useArticle();
  const labelId = useId();
  const input = gfmTaskInput(node);
  if (!input) {
    return (
      <li {...markdownBlockPositionProps(node)} {...props} className={className}>
        {children}
      </li>
    );
  }
  const inBody = input.properties?.checked === true;
  const rendered = node?.position?.start.offset;
  const itemStart = typeof rendered === "number" ? markdownSourceByteOffset(article.body, rendered) : null;
  return (
    <TaskItem
      {...props}
      node={node}
      className={className}
      tasks={article.tasks}
      itemStart={itemStart}
      inBody={inBody}
      labelId={labelId}
    >
      {children}
    </TaskItem>
  );
}

function TaskItem({
  node,
  className,
  tasks,
  itemStart,
  inBody,
  labelId,
  children,
  ...props
}: ElementProps<"li"> & { tasks: TaskBoxes | null; itemStart: number | null; inBody: boolean; labelId: string }) {
  const { checked, pressable } = useTaskState(tasks, itemStart, inBody);
  const parts = Children.toArray(children);
  return (
    <li
      {...markdownBlockPositionProps(node)}
      {...props}
      className={className}
      data-task-item=""
      data-task-checked={checked ? "true" : "false"}
    >
      <TaskCheckbox
        checked={checked}
        pressable={pressable}
        itemStart={itemStart}
        labelledBy={labelId}
        onToggle={() => {
          // A click or Space on the box (Л7.4, Ч12.7), decided with the
          // editor's (Л11.1).
          actOnReadingElement({ kind: "task" }, "click", {
            toggleTask: () => {
              if (pressable && tasks && itemStart !== null) tasks.toggle(itemStart, checked);
            },
          });
        }}
      />
      <span id={labelId} data-task-text="">
        {parts.filter((child) => !isListElement(child))}
      </span>
      {parts.filter(isListElement)}
    </li>
  );
}

function Input({ node, type, checked }: ElementProps<"input">) {
  // The GFM box is drawn by its list item.
  if (node?.position === undefined && type === "checkbox") return null;
  if (type === "checkbox") return <InertCheckbox checked={Boolean(checked)} />;
  return null;
}

function Blockquote({ node, ...props }: ElementProps<"blockquote">) {
  return <blockquote {...markdownBlockPositionProps(node)} {...props} />;
}

function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", classes: string) {
  return function Heading({ node, className, ...props }: ElementProps<typeof Tag>) {
    return <Tag {...markdownBlockPositionProps(node)} {...props} className={cn(classes, className)} />;
  };
}

/** The element an in-article link points to: the sanitizer gave every `id`
 *  the `user-content-` prefix, which a link's `#…` does not carry. */
function inArticleTarget(root: HTMLElement, fragment: string): HTMLElement | null {
  let id: string;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    id = fragment;
  }
  const prefixed = id.startsWith(USER_CONTENT_ID_PREFIX) ? id : `${USER_CONTENT_ID_PREFIX}${id}`;
  const target = root.ownerDocument.getElementById(prefixed);
  return target && root.contains(target) ? target : null;
}

/** Where a link of the article leads, read from its `href` as the reading
 *  pipeline wrote it (SPEC_EDITING.md, Л11.1). */
export function articleLinkTarget(href: string | undefined): NoteLinkTarget {
  const wikilinkTarget = decodeWikilinkHref(href);
  if (wikilinkTarget !== null) return { kind: "note", target: wikilinkTarget };
  if (href?.startsWith("#")) return { kind: "anchor", fragment: href.slice(1) };
  return { kind: "external", href: href ?? "" };
}

function Link({ node: _node, href, children, ...props }: ElementProps<"a">) {
  const article = useArticle();
  const to = articleLinkTarget(href);
  // What a click means is decided with the editor's (Л11.1). A wikilink
  // opens its note; a place in the article (a footnote, its way back, any
  // `#…`) is a jump inside it, as to a block, with the address and the route
  // kept (Ч10); an address outside the note is followed by the link itself.
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    const root = event.currentTarget.closest<HTMLElement>(".mine-article");
    const handled = actOnReadingElement({ kind: "link", to }, clickEvent(event), {
      openNote: (target) => {
        const sourceSlug = article.sourceSlug;
        if (!sourceSlug) return;
        void resolveNoteLink(sourceSlug, target)
          .then((slug) => { if (slug) article.onOpenNote(slug); })
          .catch((error: unknown) => logFailure(NOTE_LINK_LOOKUP_FAILED_TITLE, error));
      },
      jumpToAnchor: (fragment) => {
        const target = root ? inArticleTarget(root, fragment) : null;
        target?.scrollIntoView?.({ block: "center", behavior: scrollBehavior() });
      },
    });
    if (handled) event.preventDefault();
  };
  if (to.kind === "external") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props} onClick={click}>
        {children}
      </a>
    );
  }
  return <a href={href} {...props} onClick={click}>{children}</a>;
}

function ArticleImage(props: ElementProps<"img">) {
  const { Image } = useArticle();
  return <Image {...props} />;
}

function Code({ node, className, children, ...props }: ElementProps<"code">) {
  const classes = hastClasses(node);
  if (classes.includes("math-inline")) return <MathView source={hastText(node)} display={false} />;
  return <code {...props} className={className}>{children}</code>;
}

function Pre({ node, children }: ElementProps<"pre">) {
  const code = hastCodeOfPre(node);
  if (!code) return <CodeBlock code={hastText(node).replace(/\n$/, "")}>{children}</CodeBlock>;
  const source = hastText(code).replace(/\n$/, "");
  const classes = hastClasses(code);
  if (classes.includes("math-display")) return <MathView source={source} display />;
  const language = hastCodeLanguage(code);
  if (language === "mermaid") return <MermaidDiagram source={source} />;
  return <CodeBlock code={source} language={language} />;
}

function Division({ node, children, ...props }: ElementProps<"div">) {
  const properties = node?.properties ?? {};
  const type = properties[CALLOUT_PROPERTY];
  if (typeof type === "string") {
    const written = properties[CALLOUT_FOLD_PROPERTY];
    const fold: CalloutFold = written === "folded" || written === "unfolded" ? written : null;
    return <Callout type={isCalloutType(type) ? type : "note"} fold={fold}>{children}</Callout>;
  }
  if (properties[CALLOUT_TITLE_PROPERTY] !== undefined) return <CalloutTitle>{children}</CalloutTitle>;
  if (properties[CALLOUT_BODY_PROPERTY] !== undefined) {
    return <CalloutBody empty={hastElements(node).length === 0}>{children}</CalloutBody>;
  }
  return <div {...props}>{children}</div>;
}

function Span({ node, children, ...props }: ElementProps<"span">) {
  const article = useArticle();
  const properties = node?.properties ?? {};
  const target = properties[NOTE_EMBED_PROPERTY];
  if (typeof target === "string") {
    const fragment = properties[NOTE_EMBED_FRAGMENT_PROPERTY];
    const label = properties[NOTE_EMBED_LABEL_PROPERTY];
    return (
      <NoteEmbed
        lookups={article.noteEmbeds}
        target={target}
        fragment={typeof fragment === "string" ? fragment : null}
        label={typeof label === "string" ? label : null}
        sourceSlug={article.sourceSlug}
        vaultPath={article.vaultPath}
        thumbsRootPath={article.thumbsRootPath}
        onOpenNote={article.onOpenNote}
      />
    );
  }
  return <span {...props}>{children}</span>;
}

function Details({ node, children, open: _open, ...props }: ElementProps<"details">) {
  return (
    <DisclosureRoot {...props} defaultOpen={node?.properties?.open === true} className="my-5" data-html-details="">
      {children}
    </DisclosureRoot>
  );
}

function Summary({ node: _node, children, ...props }: ElementProps<"summary">) {
  return <DisclosureSummary {...props}>{children}</DisclosureSummary>;
}

function Table(props: ElementProps<"table">) {
  return <ArticleTable {...props} />;
}

/** One map for every article: the elements read what changes from the
 *  context, so a new body does not remount the article. */
const ARTICLE_COMPONENTS: Components = {
  p: Paragraph,
  li: ListItem,
  input: Input,
  blockquote: Blockquote,
  h1: heading("h1", ARTICLE_H1_CLASSES),
  h2: heading("h2", ARTICLE_SECTION_HEADING_CLASSES),
  h3: heading("h3", ARTICLE_SECTION_HEADING_CLASSES),
  h4: heading("h4", ARTICLE_SECTION_HEADING_CLASSES),
  h5: heading("h5", ARTICLE_SECTION_HEADING_CLASSES),
  h6: heading("h6", ARTICLE_SECTION_HEADING_CLASSES),
  a: Link,
  img: ArticleImage,
  code: Code,
  pre: Pre,
  div: Division,
  span: Span,
  details: Details,
  summary: Summary,
  table: Table,
};

export interface ArticleMarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The body as written, wikilinks and all. */
  body: string;
  /** The card the body is of: wikilinks and embeds resolve from it. */
  sourceSlug?: string;
  vaultPath: string;
  thumbsRootPath?: string;
  noteEmbeds: NoteEmbedLookups;
  /** The task writes of the card; `null` where boxes cannot be pressed. */
  tasks: TaskBoxes | null;
  /** The host's picture and video of the body (media actions, Р5, Р6). */
  image: ComponentType<ComponentProps<"img"> & ExtraProps>;
  /** Opens a note a wikilink resolved to, or an embed's note with the place
   *  after its `#` (`slug#Heading`, `slug#^block`). */
  onOpenNote: (slug: string) => void;
  rootRef?: Ref<HTMLDivElement>;
  /** Elements a host draws in place of the article's own: the note's
   *  editor draws its tables (SPEC_EDITING.md, Л9). One object for the
   *  host's life, or the article's elements would mount anew. */
  components?: Components;
  /** Drawn after the article, inside its root. */
  children?: ReactNode;
}

/**
 * An article body drawn by the reading pipeline (SPEC_READING_MODE.md, Ч0,
 * Ч13): wikilinks outside code, math and HTML, GFM, highlights, math,
 * callouts, note embeds and the note's sanitized HTML, each by its own
 * element. The host (`ArticleBody` in Detail) keeps text selection and media
 * actions and lends its picture element.
 */
export function ArticleMarkdown({
  body,
  sourceSlug,
  vaultPath,
  thumbsRootPath,
  noteEmbeds,
  tasks,
  image,
  onOpenNote,
  rootRef,
  components,
  className,
  children,
  ...props
}: ArticleMarkdownProps) {
  const markdown = useMemo(() => preprocessWikilinks(body), [body]);
  const elements = useMemo(() => (components ? { ...ARTICLE_COMPONENTS, ...components } : ARTICLE_COMPONENTS), [components]);
  const state = useMemo<ArticleState>(
    () => ({ body, sourceSlug, vaultPath, thumbsRootPath, noteEmbeds, tasks, Image: image, onOpenNote }),
    [body, image, noteEmbeds, onOpenNote, sourceSlug, tasks, thumbsRootPath, vaultPath],
  );
  return (
    <div {...props} ref={rootRef} className={cn(ARTICLE_ROOT_CLASSES, className)}>
      <ArticleContext.Provider value={state}>
        <ReactMarkdown
          remarkPlugins={READING_REMARK_PLUGINS}
          remarkRehypeOptions={READING_REMARK_REHYPE_OPTIONS}
          rehypePlugins={READING_REHYPE_PLUGINS}
          urlTransform={safeMarkdownUrl}
          components={elements}
        >
          {markdown}
        </ReactMarkdown>
      </ArticleContext.Provider>
      {children}
    </div>
  );
}
