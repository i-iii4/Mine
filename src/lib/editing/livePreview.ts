// Live Preview on CodeMirror 6 (SPEC_EDITING.md, Л5, Л6, Л8): the presentation
// of `presentation.ts` as decorations of the window being drawn, blocks drawn
// as widgets from a state field (CodeMirror takes block decorations only from
// there), the containers of quotes and lists as block wrappers, and the
// rules of the stable frame: what an update does not change it does not
// touch; what changes the layout waits while the mouse button is pressed over
// a selection, during a composition and while an external change is applied,
// and decorations are then only carried through the changes (Л5.5).
//
// Widgets draw nothing themselves: the host (the editor's React side) mounts
// the reading pipeline's own elements into their containers.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  Facet,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from "@codemirror/state";
import {
  BlockWrapper,
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { noteInteractionIntent, type NoteElement, type NoteInteractionIntent } from "@/lib/reading/intents";
import { blockSource, blocksOf, collectBlocks, type BlockKind, type EditorBlock } from "./blocks";
import {
  footnoteNumbers,
  MUTED_SYNTAX_CLASS,
  presentationItems,
  type InlineWidgetSpec,
  type PresentationItem,
} from "./presentation";
import { externalChange } from "./reloadDiff";
import {
  concealBlockEffect,
  isBlockRevealed,
  revealBlockEffect,
  revealField,
  revealWaitEffect,
  type RevealWait,
} from "./reveal";
import { toggleTaskSpec } from "./lists";

/** Lines drawn around the visible part: the window moves only when the
 *  visible part leaves it, not on every scroll (Л5.6). */
export const PRESENTATION_WINDOW_MARGIN_LINES = 150;
/** How long the first frame may parse, so it is drawn without raw markup
 *  (Л5.4). */
export const INITIAL_PARSE_BUDGET_MS = 100;
/** The height of a line of the article, `leading-5`: the height of a block
 *  not yet measured is its source's (Л8.2). */
export const SOURCE_LINE_HEIGHT_PX = 20;
/** Measured heights kept for blocks not drawn now (Л8.2). */
export const BLOCK_HEIGHT_CACHE_LIMIT = 512;

/** What a widget's host draws. */
export type HostedWidget =
  | {
    type: "block";
    kind: BlockKind;
    /** The block's own source, as the reading pipeline draws it. */
    source: string;
    /** Where each line of `source` starts, and where its text starts in the
     *  document, counted from the block's start (`blockSource`). */
    lineStarts: readonly number[];
    lineOffsets: readonly number[];
  }
  | { type: "task"; checked: boolean; labelledBy: string }
  | { type: "math"; source: string }
  | { type: "media"; source: string };

/** The editor's side that draws widgets: the React portals of
 *  `EditorWidgets`. */
export interface EditorWidgetHost {
  mount(dom: HTMLElement, widget: HostedWidget): void;
  update(dom: HTMLElement, widget: HostedWidget): void;
  unmount(dom: HTMLElement): void;
}

/** What the editor knows of the notes its wikilinks name (Л6). */
export interface EditorLinkStatus {
  missing(note: string): boolean;
  request(note: string): void;
  subscribe(listener: () => void): () => void;
}

/** What one editor shares with its widgets: the host, the width of its
 *  column for measured heights, the prefix of its element ids. */
export interface EditorEnvironment {
  host: EditorWidgetHost | null;
  links: EditorLinkStatus | null;
  idPrefix: string;
  columnWidth: number;
}

/** The counters of the stable frame (Л5.4), for tests. */
export interface PresentationCounters {
  added: number;
  removed: number;
  kept: number;
  widgetsAdded: number;
  widgetsRemoved: number;
  widgetsKept: number;
  fullClears: number;
  deferred: Record<RevealWait, number>;
}

/** Fresh counters. */
export function presentationCounters(): PresentationCounters {
  return {
    added: 0,
    removed: 0,
    kept: 0,
    widgetsAdded: 0,
    widgetsRemoved: 0,
    widgetsKept: 0,
    fullClears: 0,
    deferred: { pointer: 0, composition: 0, external: 0 },
  };
}

export const editorEnvironment = Facet.define<EditorEnvironment, EditorEnvironment>({
  combine: (values) => values[0] ?? { host: null, links: null, idPrefix: "mine-editor", columnWidth: 0 },
});

export const counterSink = Facet.define<PresentationCounters, PresentationCounters | null>({
  combine: (values) => values[0] ?? null,
});

/** The links of the window got their answers: draw again. */
const linksAnswered = StateEffect.define<null>();

/** Where the embed shown above the body starts (Л2.7), carried through
 *  edits; `null` when there is none. */
export const omittedEmbedField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (value === null || !tr.docChanged) return value;
    return tr.changes.mapPos(value, 1);
  },
});

// Measured heights by column width and source (Л8.2).
const blockHeights = new Map<string, number>();

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function heightKey(width: number, source: string): string {
  return `${Math.round(width)}|${source.length}|${hashText(source)}`;
}

/** The height a block with `source` measured at `width`, if known. */
export function knownBlockHeight(width: number, source: string): number | null {
  return blockHeights.get(heightKey(width, source)) ?? null;
}

/** Keep the measured height of a block for when it is drawn again. */
export function rememberBlockHeight(width: number, source: string, height: number): void {
  const key = heightKey(width, source);
  blockHeights.delete(key);
  blockHeights.set(key, height);
  while (blockHeights.size > BLOCK_HEIGHT_CACHE_LIMIT) {
    const oldest = blockHeights.keys().next().value;
    if (oldest === undefined) break;
    blockHeights.delete(oldest);
  }
}

const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
const mountedHosts = new WeakMap<HTMLElement, EditorWidgetHost>();

function mountHosted(view: EditorView, dom: HTMLElement, widget: HostedWidget) {
  const host = view.state.facet(editorEnvironment).host;
  if (!host) return;
  mountedHosts.set(dom, host);
  host.mount(dom, widget);
}

function unmountHosted(dom: HTMLElement) {
  mountedHosts.get(dom)?.unmount(dom);
  mountedHosts.delete(dom);
  resizeObservers.get(dom)?.disconnect();
  resizeObservers.delete(dom);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A block drawn by the reading pipeline in place of its lines (Л8.1). */
export class BlockWidget extends WidgetType {
  constructor(
    readonly widget: Extract<HostedWidget, { type: "block" }>,
    readonly environment: EditorEnvironment,
    readonly lines: number,
    readonly inList: boolean,
  ) {
    super();
  }

  eq(other: BlockWidget): boolean {
    return other.widget.kind === this.widget.kind
      && other.widget.source === this.widget.source
      && other.inList === this.inList
      && sameNumbers(other.widget.lineOffsets, this.widget.lineOffsets);
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-md-block";
    dom.setAttribute("data-editor-block", this.widget.kind);
    if (this.inList) dom.setAttribute("data-in-list", "");
    mountHosted(view, dom, this.widget);
    if (typeof ResizeObserver !== "undefined") {
      const source = this.widget.source;
      const environment = this.environment;
      const observer = new ResizeObserver(() => {
        const height = dom.getBoundingClientRect().height;
        if (height > 0) rememberBlockHeight(environment.columnWidth, source, height);
        view.requestMeasure();
      });
      observer.observe(dom);
      resizeObservers.set(dom, observer);
    }
    return dom;
  }

  get estimatedHeight(): number {
    return knownBlockHeight(this.environment.columnWidth, this.widget.source) ?? this.lines * SOURCE_LINE_HEIGHT_PX;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    unmountHosted(dom);
  }
}

/** A widget in a line drawn by the host: a task's box, a formula, a
 *  picture or a note embed among words. */
class HostedInlineWidget extends WidgetType {
  constructor(readonly widget: Exclude<HostedWidget, { type: "block" }>) {
    super();
  }

  eq(other: HostedInlineWidget): boolean {
    return JSON.stringify(other.widget) === JSON.stringify(this.widget);
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("span");
    dom.className = `cm-md-inline-${this.widget.type}`;
    mountHosted(view, dom, this.widget);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView, from: HostedInlineWidget): boolean {
    if (from.widget.type !== this.widget.type) return false;
    const host = mountedHosts.get(dom) ?? view.state.facet(editorEnvironment).host;
    host?.update(dom, this.widget);
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    unmountHosted(dom);
  }
}

/** A footnote's number, as the reading mode draws the reference (Ч10). */
class FootnoteWidget extends WidgetType {
  constructor(readonly number: number) {
    super();
  }

  eq(other: FootnoteWidget): boolean {
    return other.number === this.number;
  }

  toDOM(): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "cm-md-footnote";
    const link = document.createElement("a");
    link.textContent = String(this.number);
    sup.appendChild(link);
    return sup;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** A rule, `---` (Л6). */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-rule";
    wrapper.appendChild(document.createElement("hr"));
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const CONCEAL = Decoration.replace({});
const MUTE = Decoration.mark({ class: MUTED_SYNTAX_CLASS });

/** The id of the label of the task whose line starts at `lineFrom`. */
export function taskLabelId(environment: EditorEnvironment, lineFrom: number): string {
  return `${environment.idPrefix}-task-${lineFrom}`;
}

function inlineWidget(spec: InlineWidgetSpec, environment: EditorEnvironment, state: EditorState): WidgetType {
  switch (spec.kind) {
    case "task":
      return new HostedInlineWidget({
        type: "task",
        checked: spec.checked,
        labelledBy: taskLabelId(environment, state.doc.lineAt(spec.item).from),
      });
    case "math":
      return new HostedInlineWidget({ type: "math", source: spec.source });
    case "media":
      return new HostedInlineWidget({ type: "media", source: spec.source });
    case "footnote":
      return new FootnoteWidget(spec.number);
    case "rule":
      return new RuleWidget();
  }
}

/** The decorations, wrappers and atomic ranges of a list of items. Items
 *  that would hide or replace a line break become muted source: inline
 *  decorations of a plugin may not cross lines. */
export function itemsToDecorations(items: readonly PresentationItem[], state: EditorState) {
  const environment = state.facet(editorEnvironment);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const wrappers: Range<BlockWrapper>[] = [];
  const crossesLine = (from: number, to: number) => state.doc.lineAt(from).to < to;
  for (const item of items) {
    switch (item.type) {
      case "conceal":
        if (crossesLine(item.from, item.to)) decorations.push(MUTE.range(item.from, item.to));
        else {
          decorations.push(CONCEAL.range(item.from, item.to));
          if (state.sliceDoc(item.from, item.to) === "\r") atomic.push(CONCEAL.range(item.from, item.to));
        }
        break;
      case "mute":
        decorations.push(MUTE.range(item.from, item.to));
        break;
      case "mark":
        decorations.push(Decoration.mark({
          tagName: item.tagName,
          class: item.className,
          attributes: item.attributes,
        }).range(item.from, item.to));
        break;
      case "line": {
        const attributes: Record<string, string> = { ...item.attributes, class: item.className };
        if (item.attributes && "data-task-item" in item.attributes) attributes.id = taskLabelId(environment, item.from);
        decorations.push(Decoration.line({ attributes }).range(item.from));
        break;
      }
      case "widget":
        if (crossesLine(item.from, item.to)) decorations.push(MUTE.range(item.from, item.to));
        else decorations.push(Decoration.replace({ widget: inlineWidget(item.widget, environment, state) }).range(item.from, item.to));
        break;
      case "wrapper":
        wrappers.push(BlockWrapper.create({ tagName: item.tagName, attributes: item.attributes, rank: item.rank }).range(item.from, item.to));
        break;
    }
  }
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    wrappers: BlockWrapper.set(wrappers, true),
  };
}

/** The decorations of the blocks drawn as widgets (Л8): a block in place of
 *  its lines; a revealed picture or embed under its source line (Л6). */
function blockDecorations(state: EditorState, blocks: readonly EditorBlock[]): Range<Decoration>[] {
  const reveal = state.field(revealField);
  const environment = state.facet(editorEnvironment);
  const ranges: Range<Decoration>[] = [];
  for (const block of blocks) {
    const revealed = isBlockRevealed(reveal, block);
    if (revealed && block.kind !== "media") continue;
    const source = blockSource(state.doc, block);
    const lineStarts: number[] = [];
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of source.text.split("\n")) {
      lineStarts.push(offset);
      lineOffsets.push(source.toDocument(offset) - block.from);
      offset += line.length + 1;
    }
    const widget = new BlockWidget(
      { type: "block", kind: block.kind, source: source.text, lineStarts, lineOffsets },
      environment,
      state.doc.lineAt(block.to).number - state.doc.lineAt(block.from).number + 1,
      block.containers.some((container) => container.kind === "item"),
    );
    if (revealed) ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(block.to));
    else ranges.push(Decoration.replace({ widget, block: true }).range(block.from, block.to));
  }
  return ranges;
}

/** The changed range of a transaction in the new document, grown to whole
 *  top-level blocks. */
function changedRegion(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  if (from > to) return null;
  const tree = syntaxTree(tr.state);
  const top = tree.topNode;
  const start = top.childBefore(from + 1) ?? top.childAfter(from);
  const end = top.childAfter(to - 1) ?? top.childBefore(to);
  return {
    from: Math.min(from, start ? tr.state.doc.lineAt(start.from).from : from),
    to: Math.max(to, end ? tr.state.doc.lineAt(Math.min(end.to, tr.state.doc.length)).to : to),
  };
}

function countWidgets(before: DecorationSet, after: DecorationSet, counters: PresentationCounters | null) {
  if (!counters) return;
  const keys = (set: DecorationSet) => {
    const found = new Map<string, WidgetType | undefined>();
    const cursor = set.iter();
    for (; cursor.value; cursor.next()) found.set(`${cursor.from}:${cursor.to}`, cursor.value.spec.widget);
    return found;
  };
  const old = keys(before);
  const next = keys(after);
  for (const [key, widget] of next) {
    const previous = old.get(key);
    if (previous && widget && (previous === widget || widget.eq(previous))) counters.widgetsKept += 1;
    else counters.widgetsAdded += 1;
  }
  for (const [key, widget] of old) {
    const now = next.get(key);
    if (!now || !widget || !(now === widget || now.eq(widget))) counters.widgetsRemoved += 1;
  }
}

/** The block widgets and whether they wait for a rebuild: changes made
 *  while the presentation waited were only carried through (Л5.5). */
interface BlockWidgets {
  set: DecorationSet;
  stale: boolean;
}

/** The region where the revealed blocks changed between `before` and
 *  `after`. */
function revealRegion(state: EditorState, before: readonly number[], after: readonly number[]): { from: number; to: number } | null {
  const changed = [...before.filter((start) => !after.includes(start)), ...after.filter((start) => !before.includes(start))]
    .map((start) => Math.min(start, state.doc.length));
  if (changed.length === 0) return null;
  const from = Math.min(...changed);
  const last = Math.max(...changed);
  const block = blocksOf(state, last, last).find((candidate) => candidate.from <= last && last <= candidate.to);
  return { from: state.doc.lineAt(from).from, to: Math.max(state.doc.lineAt(last).to, block?.to ?? 0) };
}

function rebuildRegion(state: EditorState, set: DecorationSet, region: { from: number; to: number }): DecorationSet {
  const blocks = collectBlocks(syntaxTree(state), state.doc, region.from, region.to);
  return set.update({
    filterFrom: region.from,
    filterTo: region.to,
    filter: (from, to) => to < region.from || from > region.to,
    add: blockDecorations(state, blocks),
    sort: true,
  });
}

/** The blocks drawn as widgets (Л5.6, Л8): built from the tree, kept through
 *  edits and rebuilt only where the document changed and where what is
 *  revealed changed; whole again when the parse reaches further or after a
 *  wait. */
export const blockField = StateField.define<BlockWidgets>({
  create(state) {
    return { set: Decoration.set(blockDecorations(state, blocksOf(state)), true), stale: false };
  },
  update(value, tr) {
    const before = tr.startState.field(revealField);
    const after = tr.state.field(revealField);
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const waits = tr.isUserEvent("input.type.compose") || after.waits.size > 0 || tr.annotation(externalChange) === true;
    const counters = tr.state.facet(counterSink);
    const mapped = tr.docChanged ? value.set.map(tr.changes) : value.set;
    if (waits) {
      if (!tr.docChanged && before.blocks === after.blocks) return value;
      return { set: mapped, stale: true };
    }
    const revealChanged = before.blocks !== after.blocks;
    if (!value.stale && !tr.docChanged && !revealChanged && !treeChanged) return value;
    let next: DecorationSet;
    if (value.stale || (treeChanged && !tr.docChanged)) {
      next = Decoration.set(blockDecorations(tr.state, blocksOf(tr.state)), true);
      if (counters) counters.fullClears += 1;
    } else {
      next = mapped;
      const changed = tr.docChanged ? changedRegion(tr) : null;
      if (changed) next = rebuildRegion(tr.state, next, changed);
      const revealed = revealChanged ? revealRegion(tr.state, before.blocks, after.blocks) : null;
      if (revealed) next = rebuildRegion(tr.state, next, revealed);
    }
    countWidgets(mapped, next, counters);
    return { set: next, stale: false };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.set),
});

/** The window drawn around the visible part (Л5.6). */
function windowAround(view: EditorView): { from: number; to: number } {
  const doc = view.state.doc;
  const { from, to } = view.viewport;
  const first = Math.max(1, doc.lineAt(from).number - PRESENTATION_WINDOW_MARGIN_LINES);
  const last = Math.min(doc.lines, doc.lineAt(to).number + PRESENTATION_WINDOW_MARGIN_LINES);
  return { from: doc.line(first).from, to: doc.line(last).to };
}

function countDecorations(before: DecorationSet, after: DecorationSet, counters: PresentationCounters | null) {
  if (!counters) return;
  const keys = (set: DecorationSet) => {
    const found: Array<{ key: string; value: Decoration }> = [];
    for (const cursor = set.iter(); cursor.value; cursor.next()) found.push({ key: `${cursor.from}:${cursor.to}`, value: cursor.value });
    return found;
  };
  const old = keys(before);
  const next = keys(after);
  const matches = (left: Decoration, right: Decoration) => left === right || left.eq(right);
  const unused = [...old];
  for (const entry of next) {
    const index = unused.findIndex((candidate) => candidate.key === entry.key && matches(candidate.value, entry.value));
    if (index >= 0) {
      counters.kept += 1;
      unused.splice(index, 1);
    } else {
      counters.added += 1;
    }
  }
  counters.removed += unused.length;
}

/** The presentation of the window: inline and line decorations, the
 *  wrappers of quotes and lists, the atomic `\r` of line endings. */
class PresentationView {
  decorations: DecorationSet = Decoration.none;
  atomic: DecorationSet = Decoration.none;
  wrappers: RangeSet<BlockWrapper> = RangeSet.empty;
  private window: { from: number; to: number };
  private pending = false;
  private linksQueued = false;
  private destroyed = false;
  private readonly unsubscribe: (() => void) | null;

  constructor(private readonly view: EditorView) {
    this.window = windowAround(view);
    ensureSyntaxTree(view.state, this.window.to, INITIAL_PARSE_BUDGET_MS);
    this.build(view.state);
    const links = view.state.facet(editorEnvironment).links;
    this.unsubscribe = links?.subscribe(() => {
      if (this.linksQueued) return;
      this.linksQueued = true;
      queueMicrotask(() => {
        this.linksQueued = false;
        if (!this.destroyed) this.view.dispatch({ effects: linksAnswered.of(null) });
      });
    }) ?? null;
  }

  update(update: ViewUpdate) {
    const state = update.state;
    const reveal = state.field(revealField);
    const before = update.startState.field(revealField);
    const composing = update.view.composing || update.transactions.some((tr) => tr.isUserEvent("input.type.compose"));
    const external = update.transactions.some((tr) => tr.annotation(externalChange) === true);
    const counters = state.facet(counterSink);
    if (composing || external || reveal.waits.size > 0) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
        this.atomic = this.atomic.map(update.changes);
        this.wrappers = this.wrappers.map(update.changes);
        this.window = {
          from: update.changes.mapPos(this.window.from, -1),
          to: update.changes.mapPos(this.window.to, 1),
        };
      }
      if (update.docChanged || reveal !== before || update.viewportChanged) {
        this.pending = true;
        if (counters) {
          const reason: RevealWait = composing ? "composition" : external ? "external" : [...reveal.waits][0] ?? "pointer";
          counters.deferred[reason] += 1;
        }
      }
      return;
    }
    const { from, to } = update.view.viewport;
    const outside = from < this.window.from || to > this.window.to;
    if (outside) this.window = windowAround(update.view);
    else if (update.docChanged) {
      this.window = {
        from: update.changes.mapPos(this.window.from, -1),
        to: Math.min(state.doc.length, update.changes.mapPos(this.window.to, 1)),
      };
    }
    const treeChanged = syntaxTree(state) !== syntaxTree(update.startState);
    const linksChanged = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(linksAnswered)));
    const blocksChanged = state.field(blockField).set !== update.startState.field(blockField).set;
    if (this.pending || outside || update.docChanged || treeChanged || reveal !== before || linksChanged || blocksChanged) {
      this.pending = false;
      this.build(state);
    }
  }

  private build(state: EditorState) {
    const environment = state.facet(editorEnvironment);
    const tree = syntaxTree(state);
    let numbers: Map<string, number> | null = null;
    const items = presentationItems({
      state,
      tree,
      reveal: state.field(revealField),
      from: Math.min(this.window.from, state.doc.length),
      to: Math.min(this.window.to, state.doc.length),
      linkMissing: (note) => {
        const links = environment.links;
        if (!links) return false;
        links.request(note);
        return links.missing(note);
      },
      footnoteNumber: (label) => {
        numbers ??= footnoteNumbers(tree, state.doc);
        return numbers.get(label.toLowerCase()) ?? null;
      },
      omittedEmbed: state.field(omittedEmbedField),
    });
    const built = itemsToDecorations(items, state);
    countDecorations(this.decorations, built.decorations, state.facet(counterSink));
    this.decorations = built.decorations;
    this.atomic = built.atomic;
    this.wrappers = built.wrappers;
  }

  destroy() {
    this.destroyed = true;
    this.unsubscribe?.();
  }
}

export const presentationPlugin = ViewPlugin.fromClass(PresentationView, {
  decorations: (plugin) => plugin.decorations,
});

/** The block whose widget stands in `[from, to]` of the block field. */
function widgetBlockAt(state: EditorState, pos: number, side: "starts" | "ends"): EditorBlock | null {
  const blocks = blocksOf(state, Math.max(0, pos - 1), Math.min(state.doc.length, pos + 1));
  const reveal = state.field(revealField);
  return blocks.find((block) => !isBlockRevealed(reveal, block) && (side === "starts" ? block.from === pos : block.to === pos)) ?? null;
}

/** The block the main selection holds exactly, if it does (Л5.3). */
export function selectedBlock(state: EditorState): EditorBlock | null {
  const main = state.selection.main;
  if (main.empty) return null;
  return blocksOf(state, main.from, main.to).find((block) => block.from === main.from && block.to === main.to) ?? null;
}

function selectBlock(view: EditorView, block: EditorBlock): boolean {
  view.dispatch({ selection: EditorSelection.range(block.from, block.to), scrollIntoView: true, userEvent: "select" });
  return true;
}

function placeCaret(view: EditorView, pos: number): boolean {
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "select" });
  return true;
}

/** What a block widget is as an element of the note (Л11.1). */
export function blockElement(kind: BlockKind): NoteElement {
  switch (kind) {
    case "code":
      return { kind: "code" };
    case "mermaid":
      return { kind: "mermaid" };
    case "math":
      return { kind: "math" };
    case "callout":
      return { kind: "callout" };
    case "table":
      return { kind: "table" };
    case "html":
      return { kind: "html" };
    case "media":
      return { kind: "image" };
  }
}

/**
 * The editor carries out what an event on a block means (Л11.1): the block's
 * source, its choice or the caret. Every intent is handled; the ones the
 * editor has no part in say why.
 */
export function carryOutBlockIntent(view: EditorView, block: EditorBlock, intent: NoteInteractionIntent): boolean {
  switch (intent.kind) {
    case "RevealBlock":
      view.dispatch({
        selection: EditorSelection.cursor(block.from),
        effects: revealBlockEffect.of(block.from),
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    // The table editor is row 50.18 of the plan: until it comes, a table
    // opens in its source state (Л9.2), as Enter on any chosen block does.
    case "EnterTableCell":
      return carryOutBlockIntent(view, block, { kind: "RevealBlock" });
    case "SelectBlock":
      return selectBlock(view, block);
    case "PlaceCaret":
      return placeCaret(view, block.from);
    // A block's own links, boxes and buttons act inside it: their events
    // never reach the editor as a block's.
    case "OpenNote":
    case "OpenExternal":
    case "JumpToAnchor":
    case "ToggleTask":
    case "OpenEmbed":
    case "OpenImagePreview":
    case "Nothing":
      return false;
    default: {
      const unhandled: never = intent;
      return unhandled;
    }
  }
}

/** A click on a block widget's own content (Л5.3): its source, its choice,
 *  or, for a table, its cell. */
export function activateBlockWidget(view: EditorView, dom: HTMLElement): boolean {
  const pos = view.posAtDOM(dom);
  const block = blocksOf(view.state, pos, pos).find((candidate) => candidate.from === pos)
    ?? blocksOf(view.state, pos, pos).find((candidate) => candidate.from <= pos && pos <= candidate.to);
  if (!block) return false;
  const intent = noteInteractionIntent({ surface: "editing", element: blockElement(block.kind), event: "click" });
  const handled = carryOutBlockIntent(view, block, intent);
  view.focus();
  return handled;
}

/** A click on a task's box in the editor (Л7.4): its sign changes, the caret
 *  stays. */
export function toggleTaskWidget(view: EditorView, dom: HTMLElement): boolean {
  const spec = toggleTaskSpec(view.state, view.posAtDOM(dom));
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

/** ↑ and ↓ onto a block widget choose it; from a chosen block they go on to
 *  the line beyond it (Л5.3). */
function verticalMove(forward: boolean) {
  return (view: EditorView): boolean => {
    const state = view.state;
    const chosen = selectedBlock(state);
    if (chosen) {
      if (forward) {
        if (chosen.to >= state.doc.length) return placeCaret(view, chosen.to);
        const next = widgetBlockAt(state, chosen.to + 1, "starts");
        return next ? selectBlock(view, next) : placeCaret(view, chosen.to + 1);
      }
      if (chosen.from === 0) return placeCaret(view, 0);
      const previous = widgetBlockAt(state, chosen.from - 1, "ends");
      return previous ? selectBlock(view, previous) : placeCaret(view, chosen.from - 1);
    }
    const main = state.selection.main;
    if (!main.empty) return false;
    const line = state.doc.lineAt(main.head);
    const target = view.moveVertically(main, forward);
    if (forward) {
      if (line.to >= state.doc.length || target.head <= line.to) return false;
      const next = widgetBlockAt(state, line.to + 1, "starts");
      return next ? selectBlock(view, next) : false;
    }
    if (line.from === 0 || target.head >= line.from) return false;
    const previous = widgetBlockAt(state, line.from - 1, "ends");
    return previous ? selectBlock(view, previous) : false;
  };
}

/** ← and → at the edge of a line next to a block widget choose it. */
function horizontalMove(forward: boolean) {
  return (view: EditorView): boolean => {
    const state = view.state;
    const chosen = selectedBlock(state);
    if (chosen) {
      if (forward) return placeCaret(view, Math.min(state.doc.length, chosen.to + (chosen.to < state.doc.length ? 1 : 0)));
      return placeCaret(view, Math.max(0, chosen.from - (chosen.from > 0 ? 1 : 0)));
    }
    const main = state.selection.main;
    if (!main.empty) return false;
    const line = state.doc.lineAt(main.head);
    if (forward && main.head === line.to && line.to < state.doc.length) {
      const next = widgetBlockAt(state, line.to + 1, "starts");
      return next ? selectBlock(view, next) : false;
    }
    if (!forward && main.head === line.from && line.from > 0) {
      const previous = widgetBlockAt(state, line.from - 1, "ends");
      return previous ? selectBlock(view, previous) : false;
    }
    return false;
  };
}

/** Enter on a chosen block shows its source with the caret at its start. */
function enterBlock(view: EditorView): boolean {
  const chosen = selectedBlock(view.state);
  if (!chosen) return false;
  const intent = noteInteractionIntent({ surface: "editing", element: blockElement(chosen.kind), event: "enter", selected: true });
  return carryOutBlockIntent(view, chosen, intent);
}

/** Escape from a block's source chooses the block; from a chosen block it
 *  puts the caret after it (Л5.3). Otherwise it is not the editor's. */
function escapeBlock(view: EditorView): boolean {
  const state = view.state;
  const reveal = state.field(revealField);
  const head = state.selection.main.head;
  for (const start of reveal.blocks) {
    const block = blocksOf(state, start, start).find((candidate) => candidate.from === start);
    if (block && block.from <= head && head <= block.to) {
      view.dispatch({
        selection: EditorSelection.range(block.from, block.to),
        effects: concealBlockEffect.of(block.from),
        userEvent: "select",
      });
      return true;
    }
  }
  const chosen = selectedBlock(state);
  if (!chosen) return false;
  return placeCaret(view, Math.min(state.doc.length, chosen.to + (chosen.to < state.doc.length ? 1 : 0)));
}

/** The keys of blocks (Л5.3). */
export const blockKeymap = [
  { key: "ArrowDown", run: verticalMove(true) },
  { key: "ArrowUp", run: verticalMove(false) },
  { key: "ArrowRight", run: horizontalMove(true) },
  { key: "ArrowLeft", run: horizontalMove(false) },
  { key: "Enter", run: enterBlock },
  { key: "Escape", run: escapeBlock },
];

/** The chosen block wears `data-block-selected` (Л8.4); its frame waits for
 *  the user's decision ЛВ7 (д). */
const selectedBlockMarker = ViewPlugin.fromClass(class {
  constructor(view: EditorView) {
    this.mark(view);
  }

  update(update: ViewUpdate) {
    if (update.selectionSet || update.docChanged || update.viewportChanged) this.mark(update.view);
  }

  private mark(view: EditorView) {
    view.requestMeasure({
      read: () => {
        const chosen = selectedBlock(view.state);
        return [...view.contentDOM.querySelectorAll<HTMLElement>("[data-editor-block]")].map((dom) => {
          const pos = view.posAtDOM(dom);
          return { dom, selected: chosen !== null && chosen.from === pos };
        });
      },
      write: (marks) => {
        for (const { dom, selected } of marks) dom.toggleAttribute("data-block-selected", selected);
      },
    });
  }
});

/** The column width widgets measure their heights at (Л8.2). */
const columnWidthTracker = ViewPlugin.fromClass(class {
  constructor(view: EditorView) {
    this.track(view);
  }

  update(update: ViewUpdate) {
    if (update.geometryChanged) this.track(update.view);
  }

  private track(view: EditorView) {
    view.requestMeasure({
      read: () => view.contentDOM.clientWidth,
      write: (width) => {
        view.state.facet(editorEnvironment).columnWidth = width;
      },
    });
  }
});

function setWait(view: EditorView, reason: RevealWait, waiting: boolean) {
  view.dispatch({ effects: revealWaitEffect.of({ reason, waiting }) });
}

/** How long the end of a composition waits for CodeMirror to finish it
 *  before the presentation is rebuilt, at most. */
const COMPOSITION_END_RETRIES = 20;

/** The safe moments (Л5.5): the pointer pressed over the text and let go, a
 *  composition starting and ending. */
const safeMoments = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-editor-block], .cm-md-inline-task, .cm-md-inline-media")) return false;
    setWait(view, "pointer", true);
    const release = () => {
      window.removeEventListener("mouseup", release, true);
      window.removeEventListener("blur", release);
      setWait(view, "pointer", false);
    };
    window.addEventListener("mouseup", release, true);
    window.addEventListener("blur", release);
    return false;
  },
  compositionstart(_event, view) {
    setWait(view, "composition", true);
    return false;
  },
  compositionend(_event, view) {
    let tries = 0;
    const finish = () => {
      tries += 1;
      if (view.composing && tries < COMPOSITION_END_RETRIES) {
        setTimeout(finish, 0);
        return;
      }
      setWait(view, "composition", false);
    };
    setTimeout(finish, 0);
    return false;
  },
});

/** Live Preview: reveal, blocks, presentation, wrappers and their keys. */
export function livePreview(): Extension {
  return [
    revealField,
    omittedEmbedField,
    blockField,
    presentationPlugin,
    EditorView.blockWrappers.of((view) => view.plugin(presentationPlugin)?.wrappers ?? RangeSet.empty),
    EditorView.atomicRanges.of((view) => view.plugin(presentationPlugin)?.atomic ?? Decoration.none),
    selectedBlockMarker,
    columnWidthTracker,
    safeMoments,
    Prec.high(keymap.of(blockKeymap)),
  ];
}
