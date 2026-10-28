import { LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers, type DecorationSet } from "@codemirror/view";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { lineEndingExtensions } from "./lineEndings";
import {
  activateBlockWidget,
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

  /** The widget of pictures and where it stands: in place of its lines, or
   *  under them while they show as source. */
  function pictureWidget(view: EditorView) {
    const cursor = view.state.field(blockField).set.iter();
    return { from: cursor.from, to: cursor.to };
  }

  it.each([
    ["a paragraph", "Над\n\n![[photo.png]]\n\nПод", "![[photo.png]]"],
    ["a paragraph of two pictures", "Над\n\n![[a.png]]\n![[b.png]]\n\nПод", "![[a.png]]\n![[b.png]]"],
    ["a video", "Над\n\n![[clip.mp4]]\n\nПод", "![[clip.mp4]]"],
    ["a list item", "- Над\n- ![[photo.png]]\n- Под", "- ![[photo.png]]"],
    ["a quote", "Над\n\n> ![[photo.png]]\n\nПод", "> ![[photo.png]]"],
  ])("puts the caret on the line of pictures in %s with ↓ and ↑, which shows their source over them until the caret leaves (Л5.3, the user's decision of 27.10.2026)", (_name, doc, lines) => {
    const { view } = makeView(doc);
    const from = doc.indexOf(lines);
    const to = from + lines.length;
    const firstLine = view.state.doc.lineAt(from);
    const lastLine = view.state.doc.lineAt(to);
    expect(pictureWidget(view)).toEqual({ from, to });
    // ↓ from the line above: the caret at its column of the first line.
    const above = view.state.doc.line(firstLine.number - 1);
    view.dispatch({ selection: EditorSelection.cursor(above.to), userEvent: "select" });
    expect(press(view, "ArrowDown")).toBe(true);
    expect(view.state.selection.main.head).toBe(firstLine.from + Math.min(above.length, firstLine.length));
    expect(selectedBlock(view.state)).toBeNull();
    expect(view.state.field(revealField).pictures).toEqual([from]);
    // The source stands over the pictures, which stay drawn.
    expect(pictureWidget(view)).toEqual({ from: to, to });
    view.dispatch({ selection: EditorSelection.cursor(from + 3), userEvent: "select" });
    expect(view.state.field(revealField).pictures).toEqual([from]);
    // The caret leaves: the pictures are drawn in place of their lines again.
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(lastLine.number + 1).from), userEvent: "select" });
    expect(view.state.field(revealField).pictures).toEqual([]);
    expect(pictureWidget(view)).toEqual({ from, to });
    // ↑ from the line below: the caret on the last line.
    expect(press(view, "ArrowUp")).toBe(true);
    expect(view.state.selection.main.head).toBe(lastLine.from);
    expect(view.state.field(revealField).pictures).toEqual([from]);
    // Enter there is the text's, not a block's.
    view.dispatch({ selection: EditorSelection.range(from, to), userEvent: "select" });
    expect(press(view, "Enter")).toBe(false);
    view.destroy();
  });

  it("puts the caret at the near end of the line of pictures with → and ←", () => {
    const { view } = makeView("Над\n\n![[a.png]]\n\nПод");
    const from = "Над\n\n".length;
    view.dispatch({ selection: EditorSelection.cursor(from - 1), userEvent: "select" });
    expect(press(view, "ArrowRight")).toBe(true);
    expect(view.state.selection.main.head).toBe(from);
    view.dispatch({ selection: EditorSelection.cursor(from + "![[a.png]]".length + 1), userEvent: "select" });
    expect(press(view, "ArrowLeft")).toBe(true);
    expect(view.state.selection.main.head).toBe(from + "![[a.png]]".length);
    expect(view.state.field(revealField).pictures).toEqual([from]);
    view.destroy();
  });

  it("still chooses a code block with ↓ from a line of pictures", () => {
    const { view } = makeView("![[a.png]]\n```js\nlet x;\n```");
    view.dispatch({ selection: EditorSelection.cursor(2), userEvent: "select" });
    expect(press(view, "ArrowDown")).toBe(true);
    expect(selectedBlock(view.state)).toMatchObject({ kind: "code" });
    view.destroy();
  });

  it("puts the caret on the line of pictures in a list item at a click beside them, and leaves it where it was when the picture opens (Л5.3, Л11.1)", () => {
    const doc = "- Над\n- ![[photo.png]]\n- Под";
    const { view, host } = makeView(doc);
    const [dom] = [...host.mounted.keys()];
    if (!dom) throw new Error("one widget");
    view.dispatch({ selection: EditorSelection.cursor(1), userEvent: "select" });
    expect(activateBlockWidget(view, dom, { kind: "OpenImagePreview" })).toBe(false);
    expect(view.state.selection.main.head).toBe(1);
    expect(activateBlockWidget(view, dom, { kind: "PlaceCaret" })).toBe(true);
    const from = doc.indexOf("- ![[");
    expect(view.state.selection.main.head).toBe(from);
    expect(view.state.field(revealField).pictures).toEqual([from]);
    view.destroy();
  });

  it("shows nothing as source for the caret the editor opens with, on pictures too (Л5.2)", () => {
    const { view } = makeView("![[photo.png]]\n\nText");
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.field(revealField).pictures).toEqual([]);
    expect(pictureWidget(view)).toEqual({ from: 0, to: "![[photo.png]]".length });
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

describe("pictures among lines (SPEC_EDITING.md, Л8.6; SPEC_READING_MODE.md, Ч15)", () => {
  /** Each widget of pictures as `[space before, space after, list item]`. */
  const placements = (view: EditorView) => [...view.contentDOM.querySelectorAll("[data-editor-block='media']")]
    .map((dom) => [dom.hasAttribute("data-space-before"), dom.hasAttribute("data-space-after"), dom.hasAttribute("data-list-item")]);

  it("keeps a paragraph of pictures' distance from lines that are not blank, once between two, and shows each item's marker", () => {
    const { view } = makeView("Intro\n\n- ![[a.png]]\n- ![[b.png]]\n- text\n- ![[c.png]]\n\nAfter");
    expect(placements(view)).toEqual([
      [false, false, true],
      [true, true, true],
      [true, false, true],
    ]);
    view.destroy();
  });

  it("keeps a list of pictures in a list wrapper, and a quote of pictures in its quote", () => {
    const { view } = makeView("Intro\n\n- ![[a.png]]\n\n> ![[b.png]]\n> ![[c.png]]\n\n1. ![[d.png]]");
    const parents = [...view.contentDOM.querySelectorAll("[data-editor-block='media']")].map((dom) => dom.parentElement?.tagName);
    expect(parents).toEqual(["UL", "BLOCKQUOTE", "OL"]);
    expect(placements(view)).toEqual([
      [false, false, true],
      [false, false, false],
      [false, false, true],
    ]);
    view.destroy();
  });

  it("stands apart from a heading right above it, and follows the line below as it changes", () => {
    const { view } = makeView("# Heading\n![[a.png]]\n# Next");
    expect(placements(view)).toEqual([[true, true, false]]);
    const next = view.state.doc.line(3).from;
    view.dispatch({ changes: { from: next, insert: "\n" }, userEvent: "input" });
    expect(placements(view)).toEqual([[true, false, false]]);
    view.destroy();
  });

  it("leaves the marker and the space above to the source line of a picture that shows its source", () => {
    const { view } = makeView("- text\n- ![[a.png]]\n- ![[b.png]]");
    const first = view.state.field(blockField).set.iter();
    view.dispatch({ selection: EditorSelection.cursor(first.from + 4), userEvent: "select" });
    // The revealed picture stands right under its source line, no marker of
    // its own; the next picture keeps the one space between them.
    expect(placements(view)).toEqual([
      [false, false, false],
      [true, false, true],
    ]);
    view.destroy();
  });
});
