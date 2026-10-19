import { LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { lineEndingExtensions } from "./lineEndings";
import { anchorPosition, editorLinkHost, footnoteFragment, linkAt, linkClicks, type EditorLinkHost } from "./links";
import { editorEnvironment, livePreview } from "./livePreview";
import { mineMarkdownLanguage } from "./syntax";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

function stateOf(doc: string) {
  return EditorState.create({ doc, extensions: [new LanguageSupport(mineMarkdownLanguage)] });
}

function makeView(doc: string) {
  const host: EditorLinkHost = { openNote: vi.fn(), openExternal: vi.fn() };
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        editorEnvironment.of({ host: null, links: null, idPrefix: "test", columnWidth: 680 }),
        lineEndingExtensions("lf"),
        new LanguageSupport(mineMarkdownLanguage),
        livePreview(),
        linkClicks,
        editorLinkHost.of(host),
      ],
    }),
  });
  return { view, host };
}

/** A press and a click on `element`, as the pointer makes them. */
function click(element: Element, init: MouseEventInit = {}) {
  const options = { bubbles: true, cancelable: true, button: 0, ...init };
  const pressed = element.dispatchEvent(new MouseEvent("mousedown", options));
  element.dispatchEvent(new MouseEvent("mouseup", options));
  const clicked = element.dispatchEvent(new MouseEvent("click", options));
  return { pressDefault: pressed, clickDefault: clicked };
}

function drawnLink(view: EditorView, text: string): HTMLElement {
  const found = [...view.contentDOM.querySelectorAll<HTMLElement>("a")].find((element) => element.textContent === text);
  if (!found) throw new Error(`no drawn link “${text}”`);
  return found;
}

describe("links of the editor (SPEC_EDITING.md, Л10.1)", () => {
  it("reads where a link leads as the reading mode reads its source", () => {
    const doc = "[[Пример заметки#Раздел|подпись]] [site](https://example.com) <https://a.example> https://b.example [x](#fn-1) [^1] plain\n\n[^1]: note";
    const state = stateOf(doc);
    const at = (text: string) => doc.indexOf(text) + 1;
    expect(linkAt(state, at("Пример"))?.target).toEqual({ kind: "note", target: "Пример заметки#Раздел" });
    expect(linkAt(state, at("site"))?.target).toEqual({ kind: "external", href: "https://example.com" });
    expect(linkAt(state, at("https://a.example"))?.target).toEqual({ kind: "external", href: "https://a.example" });
    expect(linkAt(state, at("https://b.example"))?.target).toEqual({ kind: "external", href: "https://b.example" });
    expect(linkAt(state, at("[x]"))?.target).toEqual({ kind: "anchor", fragment: "fn-1" });
    expect(linkAt(state, at("[^1] plain"))?.target).toEqual({ kind: "anchor", fragment: footnoteFragment("fn", "1") });
    expect(linkAt(state, at("plain"))).toBeNull();
  });

  it("finds the place of a footnote's definition and of its first reference", () => {
    const state = stateOf("Text[^Note] and more.\n\n[^note]: The definition.");
    expect(anchorPosition(state, footnoteFragment("fn", "Note"))).toBe(23);
    expect(anchorPosition(state, "fnref-note")).toBe(4);
    expect(anchorPosition(state, "some-heading")).toBeNull();
  });

  it("opens a drawn wikilink with a plain click, and the caret stays where it was", () => {
    const { view, host } = makeView("See [[Пример заметки]] here.");
    const link = drawnLink(view, "Пример заметки");
    const { pressDefault, clickDefault } = click(link);
    expect(pressDefault).toBe(false);
    expect(clickDefault).toBe(false);
    expect(host.openNote).toHaveBeenCalledWith("Пример заметки");
    expect(view.state.selection.main.head).toBe(0);
    view.destroy();
  });

  it("gives a revealed link the caret and opens it with ⌘-click", () => {
    const { view, host } = makeView("See [link](https://example.com) here.");
    view.dispatch({ selection: { anchor: 6 }, userEvent: "select" });
    const link = drawnLink(view, "link");
    click(link);
    expect(host.openExternal).not.toHaveBeenCalled();
    const command = click(link, { metaKey: true });
    expect(command.pressDefault).toBe(false);
    expect(host.openExternal).toHaveBeenCalledWith("https://example.com");
    view.destroy();
  });

  it("jumps to a footnote's definition from its number without moving the caret", () => {
    const { view, host } = makeView("Text[^1].\n\n[^1]: The note.");
    const scrolled: unknown[] = [];
    const original = view.dispatch.bind(view);
    view.dispatch = ((...specs: Parameters<EditorView["dispatch"]>) => {
      scrolled.push(...specs);
      original(...specs);
    }) as EditorView["dispatch"];
    const number = view.contentDOM.querySelector(".cm-md-footnote a");
    if (!number) throw new Error("no footnote number");
    const { pressDefault } = click(number);
    expect(pressDefault).toBe(false);
    expect(host.openNote).not.toHaveBeenCalled();
    // The jump is one transaction of effects only: it scrolls, the caret stays.
    const jumps = scrolled.filter((spec) => typeof spec === "object" && spec !== null && "effects" in spec && !("selection" in spec) && !("changes" in spec));
    expect(jumps.length).toBeGreaterThan(0);
    expect(view.state.selection.main.head).toBe(0);
    view.destroy();
  });
});
