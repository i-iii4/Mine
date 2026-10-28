// The widgets of the editor drawn by the reading pipeline's own elements
// (SPEC_EDITING.md, Л8.1): CodeMirror makes a container for every block and
// widget in a line, and this tree of React draws into the containers through
// portals, so the article's context (its media, its note embeds, the theme)
// is the reading mode's. A block's source goes through `ArticleMarkdown` as a
// whole article would, so a table, code, Mermaid, a formula, a callout, HTML,
// a picture and a note embed look as they do when reading (решение 062, Ч13).

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Components, ExtraProps } from "react-markdown";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ArticleMarkdown } from "@/components/reading/ArticleMarkdown";
import { MathView } from "@/components/reading/MathView";
import type { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { TaskCheckbox, type TaskBoxes } from "@/components/reading/TaskCheckbox";
import { positionOfByteOffset } from "@/lib/editing/lineEndings";
import { activateBlockWidget, blockElement, toggleTaskWidget, type EditorWidgetHost, type HostedWidget } from "@/lib/editing/livePreview";
import { noteInteractionIntent, type NoteElement, type NoteInteractionIntent } from "@/lib/reading/intents";
import { toggleTaskSpec } from "@/lib/editing/lists";
import { markdownSourceOffset } from "@/lib/markdownWikilinks";
import { TableBlockView } from "./TableEditor";
import { EditorImagePlacementContext, imageOccurrenceBefore, type EditorImagePlacement } from "./editorImagePlacement";

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
/** The editor the widgets stand in. */
const WidgetViewContext = createContext<EditorView | null>(null);

/** Controls inside a widget keep their own clicks: links, buttons, folds,
 *  boxes. A note embed's card opens its note at a click, as the intent
 *  decides (Л11.5), while the focus stays in the editor. */
const WIDGET_CONTROLS = "a, button:not([data-note-embed-open]), summary, input, label, [role='checkbox']";

/** The room of a widget of pictures, or of a picture among words, beside
 *  and under them: the line of their source, where a click puts the caret
 *  (Л5.3). */
const PICTURE_LINE_ELEMENT: NoteElement = { kind: "text" };

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

/** The host's picture, told how to find where it stands in the note: a
 *  widget draws its own source, whose positions start at the block, and
 *  the place among the body's pictures is counted from the document only
 *  when an action asks (Л11.3, Л14). */
function EditorWidgetImage({ node, ...props }: ComponentProps<"img"> & ExtraProps) {
  const host = useContext(ArticleHostContext);
  const source = useContext(WidgetSourceContext);
  const view = useContext(WidgetViewContext);
  const start = node?.position?.start.offset;
  const placement = useMemo<EditorImagePlacement>(() => ({
    occurrenceIndex: () => {
      if (!source || !view || typeof start !== "number") return null;
      const own = markdownSourceOffset(source.text, start);
      const pos = own === null ? null : source.toDocument(own);
      // Joined by `\n`, the text's offsets are the document's positions.
      return pos === null ? null : imageOccurrenceBefore(view.state.doc.sliceString(0, pos + 2, "\n"), pos);
    },
  }), [source, start, view]);
  if (!host) return null;
  const Image = host.image;
  return (
    <EditorImagePlacementContext.Provider value={placement}>
      <Image node={node} {...props} />
    </EditorImagePlacementContext.Provider>
  );
}

/** A widget's article: the source as `ArticleMarkdown` draws a body; a
 *  table of the top level with the table editor's elements (Л9). */
function WidgetArticle({ view, source, components }: { view: EditorView; source: WidgetSource; components?: Components }) {
  const host = useContext(ArticleHostContext);
  const tasks = useMemo(() => new WidgetTaskBoxes(view, source), [source, view]);
  if (!host) return null;
  return (
    <WidgetSourceContext.Provider value={source}>
      <WidgetViewContext.Provider value={view}>
      <ArticleMarkdown
        body={source.text}
        sourceSlug={host.sourceSlug}
        vaultPath={host.vaultPath}
        thumbsRootPath={host.thumbsRootPath}
        noteEmbeds={host.noteEmbeds}
        tasks={tasks}
        image={EditorWidgetImage}
        onOpenNote={host.onOpenNote}
        components={components}
      />
      </WidgetViewContext.Provider>
    </WidgetSourceContext.Provider>
  );
}

/** The element of the note a click in a widget hit (Л11.1). */
function widgetElement(target: EventTarget | null, fallback: NoteElement): NoteElement {
  if (!(target instanceof Element)) return fallback;
  // A note embed is its card: the room round the card is the line's.
  if (target.closest("[data-note-embed-open]")) return { kind: "embed" };
  if (target.closest("[data-detail-media-action-frame], img, video")) return { kind: "image" };
  return fallback;
}

/** Who carries out an intent decided on a widget: the editor (the block's
 *  choice, its source, the caret, a task's sign), the reading element under
 *  the pointer, which opens itself as it does when reading, or nobody. */
function widgetIntentOwner(intent: NoteInteractionIntent): "editor" | "element" | "none" {
  switch (intent.kind) {
    case "SelectBlock":
    case "RevealBlock":
    case "EnterTableCell":
    case "PlaceCaret":
    case "ToggleTask":
      return "editor";
    case "OpenImagePreview":
    case "OpenEmbed":
    case "OpenNote":
    case "OpenExternal":
    case "JumpToAnchor":
      return "element";
    case "Nothing":
      return "none";
    default: {
      const unhandled: never = intent;
      return unhandled;
    }
  }
}

/** Clicks on a widget's own content are the editor's (Л5.3): the block's
 *  source, its choice, the caret; its controls keep theirs, and a click on a
 *  picture or an embed opens it as when reading (Л10.1, Л11.1, Л11.5). The
 *  listener runs in the capture phase, before the elements' own handlers;
 *  the press keeps the caret and the focus in the editor in every case, so
 *  a picture opened does not first take the caret to its line. */
function useWidgetClicks(dom: HTMLElement, element: NoteElement, activate: (intent: NoteInteractionIntent) => void) {
  useEffect(() => {
    const intentOf = (event: MouseEvent) => noteInteractionIntent({
      surface: "editing",
      element: widgetElement(event.target, element),
      event: event.metaKey || event.ctrlKey ? "command-click" : "click",
    });
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || isControl(event.target)) return;
      // The caret and the focus stay in the editor until the click decides.
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || isControl(event.target)) return;
      const intent = intentOf(event);
      const owner = widgetIntentOwner(intent);
      if (owner === "element") return;
      event.preventDefault();
      event.stopPropagation();
      if (owner === "editor") activate(intent);
    };
    dom.addEventListener("mousedown", onMouseDown, true);
    dom.addEventListener("click", onClick, true);
    return () => {
      dom.removeEventListener("mousedown", onMouseDown, true);
      dom.removeEventListener("click", onClick, true);
    };
  }, [activate, dom, element]);
}

function BlockWidgetView({ view, dom, widget }: { view: EditorView; dom: HTMLElement; widget: HostedBlock }) {
  const source = useMemo<WidgetSource>(() => ({
    text: widget.source,
    toDocument: (offset) => blockDocumentPosition(view, dom, widget, offset),
  }), [dom, view, widget]);
  const activate = useMemo(() => (intent: NoteInteractionIntent) => {
    activateBlockWidget(view, dom, intent);
  }, [dom, view]);
  // Beside its pictures a widget of pictures is the line of their source.
  const element = useMemo(() => (widget.kind === "media" ? PICTURE_LINE_ELEMENT : blockElement(widget.kind)), [widget.kind]);
  useWidgetClicks(dom, element, activate);
  return <WidgetArticle view={view} source={source} />;
}

function InlineMediaView({ view, dom, source: text }: { view: EditorView; dom: HTMLElement; source: string }) {
  const source = useMemo<WidgetSource>(() => ({
    text,
    toDocument: (offset) => (dom.isConnected ? view.posAtDOM(dom) + offset : null),
  }), [dom, text, view]);
  // The picture among words opens at a click (Л11.1); beside it, a click
  // puts the caret at it, which shows its source.
  const activate = useMemo(() => () => {
    if (!dom.isConnected) return;
    view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(dom)), userEvent: "select" });
    view.focus();
  }, [dom, view]);
  useWidgetClicks(dom, PICTURE_LINE_ELEMENT, activate);
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
        // A click or Space on the box, decided with the reading mode's
        // (Л7.4, Л11.1).
        const intent = noteInteractionIntent({ surface: "editing", element: { kind: "task" }, event: "click" });
        if (widgetIntentOwner(intent) === "editor") toggleTaskWidget(view, dom);
      }}
    />
  );
}

/** A table of the top level: the table editor draws and edits it (Л9). */
function TableWidgetView({ view, dom, widget }: { view: EditorView; dom: HTMLElement; widget: HostedBlock }) {
  const host = useContext(ArticleHostContext);
  const renderArticle = useCallback((text: string, toDocument: (offset: number) => number | null, components: Components) => (
    <WidgetArticle view={view} source={{ text, toDocument }} components={components} />
  ), [view]);
  return <TableBlockView view={view} dom={dom} widget={widget} sourceSlug={host?.sourceSlug ?? null} renderArticle={renderArticle} />;
}

/** One widget; a widget whose entry did not change is not drawn again when
 *  another one is, as a table is on every key typed in its cell. */
const WidgetView = memo(function WidgetView({ view, dom, widget }: { view: EditorView; dom: HTMLElement; widget: HostedWidget }): ReactNode {
  switch (widget.type) {
    case "block":
      if (widget.kind === "table" && !widget.nested) return <TableWidgetView view={view} dom={dom} widget={widget} />;
      return <BlockWidgetView view={view} dom={dom} widget={widget} />;
    case "media":
      return <InlineMediaView view={view} dom={dom} source={widget.source} />;
    case "math":
      return <MathView source={widget.source} display={false} />;
    case "task":
      return <TaskBoxView view={view} dom={dom} checked={widget.checked} labelledBy={widget.labelledBy} />;
  }
});

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
