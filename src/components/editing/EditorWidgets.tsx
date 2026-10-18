// The widgets of the editor drawn by the reading pipeline's own elements
// (SPEC_EDITING.md, Л8.1): CodeMirror makes a container for every block and
// widget in a line, and this tree of React draws into the containers through
// portals, so the article's context (its media, its note embeds, the theme)
// is the reading mode's. A block's source goes through `ArticleMarkdown` as a
// whole article would, so a table, code, Mermaid, a formula, a callout, HTML,
// a picture and a note embed look as they do when reading (решение 062, Ч13).

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ExtraProps } from "react-markdown";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ArticleMarkdown } from "@/components/reading/ArticleMarkdown";
import { MathView } from "@/components/reading/MathView";
import type { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { TaskCheckbox, type TaskBoxes } from "@/components/reading/TaskCheckbox";
import { positionOfByteOffset } from "@/lib/editing/lineEndings";
import { activateBlockWidget, toggleTaskWidget, type EditorWidgetHost, type HostedWidget } from "@/lib/editing/livePreview";
import { toggleTaskSpec } from "@/lib/editing/lists";
import { markdownSourceOffset } from "@/lib/markdownWikilinks";

type HostedBlock = Extract<HostedWidget, { type: "block" }>;

interface PortalEntry {
  key: number;
  widget: HostedWidget;
}

/**
 * The containers of one editor's widgets and what each draws: CodeMirror
 * mounts, updates and unmounts them, `EditorWidgets` draws them.
 */
export class WidgetPortals implements EditorWidgetHost {
  private readonly entries = new Map<HTMLElement, PortalEntry>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyArray<readonly [HTMLElement, PortalEntry]> = [];
  private nextKey = 0;

  mount(dom: HTMLElement, widget: HostedWidget): void {
    this.entries.set(dom, { key: this.nextKey, widget });
    this.nextKey += 1;
    this.publish();
  }

  update(dom: HTMLElement, widget: HostedWidget): void {
    const entry = this.entries.get(dom);
    if (!entry) return;
    this.entries.set(dom, { key: entry.key, widget });
    this.publish();
  }

  unmount(dom: HTMLElement): void {
    if (this.entries.delete(dom)) this.publish();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  current = (): ReadonlyArray<readonly [HTMLElement, PortalEntry]> => this.snapshot;

  private publish() {
    this.snapshot = [...this.entries];
    for (const listener of this.listeners) listener();
  }
}

/** What the widgets of an article lend from its host, as `ArticleMarkdown`
 *  takes it from `ArticleBody`. */
export interface EditorArticleHost {
  sourceSlug: string;
  vaultPath: string;
  thumbsRootPath: string;
  noteEmbeds: NoteEmbedLookups;
  /** The host's picture and video of the body (Р5, Р6, Л11.3). */
  image: ComponentType<ComponentProps<"img"> & ExtraProps>;
  onOpenNote: (slug: string) => void;
  /** Where document position `pos` stands in the body as the reading
   *  pipeline renders it (after `preprocessWikilinks`): the host's media
   *  elements find themselves among the body's pictures by it. */
  renderedOffsetOf(pos: number): number | null;
}

const ArticleHostContext = createContext<EditorArticleHost | null>(null);

/** The source a widget's elements are drawn from and the way back to the
 *  document. */
interface WidgetSource {
  text: string;
  /** The document position of offset `offset` of `text`, now. */
  toDocument(offset: number): number | null;
}

const WidgetSourceContext = createContext<WidgetSource | null>(null);

/** Controls inside a widget keep their own clicks: links, buttons, folds,
 *  boxes. A note embed's card is no control in the editor: a click chooses
 *  its block (Л5.3). */
const WIDGET_CONTROLS = "a, button:not([data-note-embed-open]), summary, input, label, [role='checkbox']";

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(WIDGET_CONTROLS) !== null;
}

/** The document position of offset `offset` of a block's source, from where
 *  its container stands now. */
function blockDocumentPosition(view: EditorView, dom: HTMLElement, widget: HostedBlock, offset: number): number | null {
  if (!dom.isConnected) return null;
  const from = view.posAtDOM(dom);
  let line = widget.lineStarts.length - 1;
  while (line > 0 && (widget.lineStarts[line] ?? 0) > offset) line -= 1;
  return from + (widget.lineOffsets[line] ?? 0) + offset - (widget.lineStarts[line] ?? 0);
}

/** The task boxes of a widget (Л7.4): the document is their truth, a press
 *  changes its sign there, as an edit in the history. */
class WidgetTaskBoxes implements TaskBoxes {
  readonly active = true;

  constructor(
    private readonly view: EditorView,
    private readonly source: WidgetSource,
  ) {}

  visible(_itemStart: number | null, inBody: boolean): boolean {
    return inBody;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  toggle(itemStart: number): void {
    const offset = positionOfByteOffset(this.source.text, itemStart);
    const pos = offset === null ? null : this.source.toDocument(offset);
    if (pos === null) return;
    const spec = toggleTaskSpec(this.view.state, pos);
    if (spec) this.view.dispatch(spec);
  }
}

/** The host's picture, told where it stands in the whole body: a widget
 *  draws its own source, whose positions start at the block. */
function EditorWidgetImage({ node, ...props }: ComponentProps<"img"> & ExtraProps) {
  const host = useContext(ArticleHostContext);
  const source = useContext(WidgetSourceContext);
  if (!host) return null;
  const Image = host.image;
  const start = node?.position?.start;
  const end = node?.position?.end;
  if (!node || !source || !start || !end || typeof start.offset !== "number" || typeof end.offset !== "number") {
    return <Image node={node} {...props} />;
  }
  const own = markdownSourceOffset(source.text, start.offset);
  const pos = own === null ? null : source.toDocument(own);
  const rendered = pos === null ? null : host.renderedOffsetOf(pos);
  if (rendered === null) return <Image node={node} {...props} />;
  const placed = {
    ...node,
    position: {
      start: { ...start, offset: rendered },
      end: { ...end, offset: rendered + (end.offset - start.offset) },
    },
  };
  return <Image node={placed} {...props} />;
}

/** A widget's article: the source as `ArticleMarkdown` draws a body. */
function WidgetArticle({ view, source }: { view: EditorView; source: WidgetSource }) {
  const host = useContext(ArticleHostContext);
  const tasks = useMemo(() => new WidgetTaskBoxes(view, source), [source, view]);
  if (!host) return null;
  return (
    <WidgetSourceContext.Provider value={source}>
      <ArticleMarkdown
        body={source.text}
        sourceSlug={host.sourceSlug}
        vaultPath={host.vaultPath}
        thumbsRootPath={host.thumbsRootPath}
        noteEmbeds={host.noteEmbeds}
        tasks={tasks}
        image={EditorWidgetImage}
        onOpenNote={host.onOpenNote}
      />
    </WidgetSourceContext.Provider>
  );
}

/** Clicks on a widget's own content are the editor's (Л5.3): the block's
 *  source, its choice, the caret; its controls keep theirs. The listener runs
 *  in the capture phase, before the elements' own handlers. */
function useWidgetClicks(dom: HTMLElement, activate: () => void) {
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || isControl(event.target)) return;
      // The caret and the focus stay in the editor until the click decides.
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || isControl(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      activate();
    };
    dom.addEventListener("mousedown", onMouseDown, true);
    dom.addEventListener("click", onClick, true);
    return () => {
      dom.removeEventListener("mousedown", onMouseDown, true);
      dom.removeEventListener("click", onClick, true);
    };
  }, [activate, dom]);
}

function BlockWidgetView({ view, dom, widget }: { view: EditorView; dom: HTMLElement; widget: HostedBlock }) {
  const source = useMemo<WidgetSource>(() => ({
    text: widget.source,
    toDocument: (offset) => blockDocumentPosition(view, dom, widget, offset),
  }), [dom, view, widget]);
  const activate = useMemo(() => () => {
    activateBlockWidget(view, dom);
  }, [dom, view]);
  useWidgetClicks(dom, activate);
  return <WidgetArticle view={view} source={source} />;
}

function InlineMediaView({ view, dom, source: text }: { view: EditorView; dom: HTMLElement; source: string }) {
  const source = useMemo<WidgetSource>(() => ({
    text,
    toDocument: (offset) => (dom.isConnected ? view.posAtDOM(dom) + offset : null),
  }), [dom, text, view]);
  // A click on a picture among words shows its source: the caret goes to it.
  const activate = useMemo(() => () => {
    if (!dom.isConnected) return;
    view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(dom)), userEvent: "select" });
    view.focus();
  }, [dom, view]);
  useWidgetClicks(dom, activate);
  return <WidgetArticle view={view} source={source} />;
}

function TaskBoxView({ view, dom, checked, labelledBy }: { view: EditorView; dom: HTMLElement; checked: boolean; labelledBy: string }) {
  useEffect(() => {
    // A press on the box keeps the caret and the focus in the text (Л7.4).
    const keepFocus = (event: MouseEvent) => event.preventDefault();
    dom.addEventListener("mousedown", keepFocus);
    return () => dom.removeEventListener("mousedown", keepFocus);
  }, [dom]);
  return (
    <TaskCheckbox
      checked={checked}
      pressable
      itemStart={null}
      labelledBy={labelledBy}
      onToggle={() => {
        toggleTaskWidget(view, dom);
      }}
    />
  );
}

function WidgetView({ view, dom, widget }: { view: EditorView; dom: HTMLElement; widget: HostedWidget }): ReactNode {
  switch (widget.type) {
    case "block":
      return <BlockWidgetView view={view} dom={dom} widget={widget} />;
    case "media":
      return <InlineMediaView view={view} dom={dom} source={widget.source} />;
    case "math":
      return <MathView source={widget.source} display={false} />;
    case "task":
      return <TaskBoxView view={view} dom={dom} checked={widget.checked} labelledBy={widget.labelledBy} />;
  }
}

/**
 * The widgets of one editor, drawn into CodeMirror's containers through
 * portals. Rendered inside the host's contexts, so a widget's media and
 * embeds act as the reading mode's do.
 */
export function EditorWidgets({
  portals,
  view,
  host,
}: {
  portals: WidgetPortals;
  view: EditorView | null;
  host: EditorArticleHost;
}) {
  const entries = useSyncExternalStore(portals.subscribe, portals.current, portals.current);
  if (!view) return null;
  return (
    <ArticleHostContext.Provider value={host}>
      {entries.map(([dom, entry]) => createPortal(
        <WidgetView view={view} dom={dom} widget={entry.widget} />,
        dom,
        String(entry.key),
      ))}
    </ArticleHostContext.Provider>
  );
}
