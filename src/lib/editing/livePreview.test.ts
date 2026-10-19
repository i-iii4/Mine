import { LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers, type DecorationSet } from "@codemirror/view";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { lineEndingExtensions } from "./lineEndings";
import {
  blockField,
  counterSink,
  editorEnvironment,
  expectedBlockHeight,
  knownBlockHeight,
  livePreview,
  presentationCounters,
  presentationPlugin,
  rememberBlockHeight,
  selectedBlock,
  SOURCE_LINE_HEIGHT_PX,
  type EditorWidgetHost,
  type HostedWidget,
  type PresentationCounters,
} from "./livePreview";
import { externalChangeSpec } from "./reloadDiff";
import { revealField, revealWaitEffect } from "./reveal";
import { mineMarkdownLanguage } from "./syntax";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

/** A host that records what CodeMirror asks it to draw. */
class RecordingHost implements EditorWidgetHost {
  readonly mounted = new Map<HTMLElement, HostedWidget>();
  mounts = 0;
  unmounts = 0;
  mount(dom: HTMLElement, widget: HostedWidget) {
    this.mounts += 1;
    this.mounted.set(dom, widget);
  }
  update(dom: HTMLElement, widget: HostedWidget) {
    this.mounted.set(dom, widget);
  }
  unmount(dom: HTMLElement) {
    this.unmounts += 1;
    this.mounted.delete(dom);
  }
}

function makeView(doc: string, extra: Extension = []) {
  const host = new RecordingHost();
  const counters = presentationCounters();
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        editorEnvironment.of({ host, links: null, idPrefix: "test", columnWidth: 680 }),
        counterSink.of(counters),
        lineEndingExtensions("lf"),
        new LanguageSupport(mineMarkdownLanguage),
        livePreview(),
        extra,
      ],
    }),
  });
  return { view, host, counters };
}

function decorations(view: EditorView): DecorationSet {
  const plugin = view.plugin(presentationPlugin);
  if (!plugin) throw new Error("no presentation");
  return plugin.decorations;
}

function ranges(set: DecorationSet): string[] {
  const found: string[] = [];
  for (const cursor = set.iter(); cursor.value; cursor.next()) found.push(`${cursor.from}-${cursor.to}`);
  return found;
}

function reset(counters: PresentationCounters) {
  Object.assign(counters, presentationCounters());
}

function press(view: EditorView, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return runScopeHandlers(view, event, "editor");
}

const paragraphs = Array.from({ length: 50 }, (_, index) => `Line ${index} with **bold** and \`code\`.`);

describe("the stable frame (SPEC_EDITING.md, Л5.4)", () => {
  it("adds and removes nothing on an update that changes nothing", () => {
    const { view, counters } = makeView(paragraphs.join("\n"));
    reset(counters);
    view.dispatch({ effects: [] });
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(counters.added).toBe(0);
    expect(counters.removed).toBe(0);
    view.destroy();
  });

  it("changes only the elements the caret enters and leaves as it moves over 50 lines", () => {
    const { view, counters } = makeView(paragraphs.join("\n"));
    view.dispatch({ selection: EditorSelection.cursor(0), userEvent: "select" });
    reset(counters);
    for (let line = 1; line <= 50; line += 1) {
      const target = view.state.doc.line(line);
      view.dispatch({ selection: EditorSelection.cursor(target.from + 1), userEvent: "select" });
    }
    // The caret stands in no element at the start of a line: nothing
    // reveals, nothing changes.
    expect(counters.added).toBe(0);
    expect(counters.removed).toBe(0);
    const bold = view.state.doc.line(10).from + view.state.doc.line(10).text.indexOf("**") + 3;
    view.dispatch({ selection: EditorSelection.cursor(bold), userEvent: "select" });
    // The two marks of one bold go from hidden to muted, nothing else.
    expect(counters.added).toBe(2);
    expect(counters.removed).toBe(2);
    view.destroy();
  });

  it("keeps a table's widget when a line ten paragraphs away changes (Л5.6, Л8)", () => {
    const body = ["| a | b |", "|---|---|", "| 1 | 2 |", "", ...paragraphs.slice(0, 12)].join("\n");
    const { view, host, counters } = makeView(body);
    const mounts = host.mounts;
    reset(counters);
    const far = view.state.doc.line(16);
    view.dispatch({ changes: { from: far.to, insert: " more" }, userEvent: "input.type" });
    expect(host.mounts).toBe(mounts);
    expect(counters.widgetsAdded).toBe(0);
    expect(counters.widgetsRemoved).toBe(0);
    view.destroy();
  });
});

describe("the safe moments (Л5.5, Л13.1)", () => {
  it("only carries decorations through the changes of a composition, and rebuilds at its end", () => {
    const { view, counters } = makeView("x *y and more");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), userEvent: "select" });
    const before = ranges(decorations(view));
    reset(counters);
    view.dispatch({
      changes: { from: 4, insert: "*" },
      selection: EditorSelection.cursor(view.state.doc.length),
      userEvent: "input.type.compose",
    });
    // The new emphasis `*y*` is not drawn during the composition: the old
    // decorations only moved.
    expect(ranges(decorations(view))).toEqual(before);
    expect(counters.deferred.composition).toBe(1);
    view.dispatch({ effects: revealWaitEffect.of({ reason: "composition", waiting: false }) });
    expect(ranges(decorations(view))).toContain("2-3");
    view.destroy();
  });

  it("waits while the pointer is down and while an external change is applied", () => {
    const { view, counters } = makeView("**bold** text");
    view.dispatch({ selection: EditorSelection.cursor(12), userEvent: "select" });
    reset(counters);
    view.dispatch({ effects: revealWaitEffect.of({ reason: "pointer", waiting: true }) });
    view.dispatch({ selection: EditorSelection.cursor(3), userEvent: "select.pointer" });
    expect(counters.deferred.pointer).toBeGreaterThan(0);
    expect(view.state.field(revealField).selection.main.head).toBe(12);
    view.dispatch({ effects: revealWaitEffect.of({ reason: "pointer", waiting: false }) });
    expect(view.state.field(revealField).selection.main.head).toBe(3);
    view.dispatch(externalChangeSpec(view.state, "**bold** text, changed"));
    expect(counters.deferred.external).toBe(1);
    view.destroy();
  });
});

describe("blocks (Л5.3, Л8)", () => {
  const BODY = "Before\n```js\nlet x;\n```\nAfter";

  it("draws a block as one widget the host mounts with the block's source", () => {
    const { view, host } = makeView(BODY);
    const widgets = [...host.mounted.values()];
    expect(widgets).toEqual([expect.objectContaining({ type: "block", kind: "code", source: "```js\nlet x;\n```" })]);
    view.destroy();
  });

  it("keeps a block's container at its expected height until the host draws into it (Л5.6, Л8.2)", async () => {
    const { view, host } = makeView(BODY);
    const [dom] = [...host.mounted.keys()];
    if (!dom) throw new Error("one widget");
    // Three lines of source at the article's line, nothing measured.
    expect(dom.style.minHeight).toBe(`${3 * SOURCE_LINE_HEIGHT_PX}px`);
    dom.appendChild(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.style.minHeight).toBe("");
    view.destroy();
  });

  it("chooses a block with ↓ from the line above, shows its source with Enter, chooses it again with Escape and leaves it with Escape", () => {
    const { view, host } = makeView(BODY);
    view.dispatch({ selection: EditorSelection.cursor(2), userEvent: "select" });
    expect(press(view, "ArrowDown")).toBe(true);
    const chosen = selectedBlock(view.state);
    expect(chosen).toMatchObject({ kind: "code", from: 7 });
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.field(revealField).blocks).toEqual([7]);
    expect(view.state.selection.main.head).toBe(7);
    expect(host.mounted.size).toBe(0);
    expect(press(view, "Escape")).toBe(true);
    expect(view.state.field(revealField).blocks).toEqual([]);
    expect(selectedBlock(view.state)).toMatchObject({ kind: "code" });
    expect(press(view, "Escape")).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(5).from);
    view.destroy();
  });

  it("chooses a block with ↑ from the line below and goes on past it", () => {
    const { view } = makeView(BODY);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(5).from + 2), userEvent: "select" });
    expect(press(view, "ArrowUp")).toBe(true);
    expect(selectedBlock(view.state)).toMatchObject({ kind: "code" });
    expect(press(view, "ArrowUp")).toBe(true);
    expect(view.state.selection.main.head).toBe(6);
    view.destroy();
  });

  it("keeps a picture under its source line when it shows its source (Л6)", () => {
    const { view } = makeView("Text\n\n![[photo.png]]\n\nMore");
    const media = view.state.field(blockField).set.iter();
    expect(media.value?.spec.block).toBe(true);
    const from = media.from;
    view.dispatch({ selection: EditorSelection.range(from, media.to), userEvent: "select" });
    expect(press(view, "Enter")).toBe(true);
    const after = view.state.field(blockField).set.iter();
    expect(after.from).toBe(after.to);
    expect(after.from).toBe(view.state.doc.line(3).to);
    view.destroy();
  });
});

describe("the expected height of a block not yet drawn (Л8.2)", () => {
  // A width no other test measures at: the sums are the module's own.
  const WIDTH = 613;

  it("takes a block's own measured height, else its lines at the height a line of its kind was measured at", () => {
    expect(expectedBlockHeight(WIDTH, "table", 22)).toBe(22 * SOURCE_LINE_HEIGHT_PX);
    rememberBlockHeight(WIDTH, "| a |\n|---|\n| 1 |", 90, "table", 3);
    rememberBlockHeight(WIDTH, "| b |\n|---|\n| 2 |\n| 3 |", 120, "table", 4);
    expect(knownBlockHeight(WIDTH, "| a |\n|---|\n| 1 |")).toBe(90);
    // (90 + 120) / (3 + 4) = 30 a line of a table.
    expect(expectedBlockHeight(WIDTH, "table", 22)).toBe(660);
    // Another kind and another width know nothing of tables at this width.
    expect(expectedBlockHeight(WIDTH, "code", 10)).toBe(10 * SOURCE_LINE_HEIGHT_PX);
    expect(expectedBlockHeight(WIDTH + 1, "table", 22)).toBe(22 * SOURCE_LINE_HEIGHT_PX);
    // A block measured again counts once, at its new height.
    rememberBlockHeight(WIDTH, "| a |\n|---|\n| 1 |", 120, "table", 3);
    expect(expectedBlockHeight(WIDTH, "table", 7)).toBe(240);
  });
});
