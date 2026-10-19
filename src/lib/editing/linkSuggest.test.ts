import { waitFor } from "@testing-library/react";
import {
  completionStatus,
  currentCompletions,
  insertBracket,
  selectedCompletion,
} from "@codemirror/autocomplete";
import { LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import {
  linkSuggestHost,
  linkSuggestions,
  wikilinkContext,
  wikilinkInsertion,
  type LinkQuery,
  type LinkSuggestion,
} from "./linkSuggest";
import { mineMarkdownLanguage } from "./syntax";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

/** The caret's mark in a document of a test. */
const CARET = "‸";

function stateOf(doc: string, caret = doc.indexOf(CARET) >= 0 ? doc.indexOf(CARET) : doc.length) {
  const text = doc.replace(CARET, "");
  return EditorState.create({ doc: text, selection: { anchor: caret }, extensions: [new LanguageSupport(mineMarkdownLanguage)] });
}

/** The context at the caret, written as `‸` in `doc`. */
function contextAt(doc: string) {
  const state = stateOf(doc);
  return wikilinkContext(state, state.selection.main.head);
}

const NOTES: LinkSuggestion[] = [
  { label: "Пример заметки", detail: "Cards", target: "Пример заметки", slug: "Cards/Пример заметки", matches: [{ start: 0, end: 6 }] },
  { label: "Проверка просмотрщика", detail: "Cards", target: "Проверка просмотрщика", slug: "Cards/Проверка просмотрщика", matches: [] },
];

function makeView(doc: string, suggest: (query: LinkQuery) => Promise<readonly LinkSuggestion[]>) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [new LanguageSupport(mineMarkdownLanguage), linkSuggestHost.of({ suggest }), linkSuggestions()],
    }),
  });
}

function typeText(view: EditorView, text: string) {
  const at = view.state.selection.main.head;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
}

function press(view: EditorView, key: string): boolean {
  return runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
}

describe("the context of the `[[` menu (SPEC_EDITING.md, Л10.2)", () => {
  it("opens in an open `[[` and keeps the spaces of the query", () => {
    expect(contextAt("See [[Пример зам‸")).toEqual({
      open: 4,
      end: 16,
      keepsAlias: false,
      queryFrom: 6,
      query: { kind: "notes", text: "Пример зам" },
    });
    expect(contextAt("[[‸")?.query).toEqual({ kind: "notes", text: "" });
  });

  it("switches to headings after `#` and to blocks after `^`, and ends at `|`", () => {
    expect(contextAt("[[Пример заметки#Раз‸")?.query).toEqual({ kind: "headings", note: "Пример заметки", text: "Раз" });
    expect(contextAt("[[Пример заметки#Раз#Два‸")?.query).toEqual({ kind: "headings", note: "Пример заметки", text: "Два" });
    expect(contextAt("[[Пример заметки#^abc‸")?.query).toEqual({ kind: "blocks", note: "Пример заметки", text: "abc" });
    expect(contextAt("[[Пример заметки|подп‸")).toBeNull();
    expect(contextAt("[[#Раз‸")).toBeNull();
  });

  it("has no place in code, in a formula, in an embed or after a closed link", () => {
    expect(contextAt("`[[Пример‸`")).toBeNull();
    expect(contextAt("```\n[[Пример‸\n```")).toBeNull();
    expect(contextAt("$[[x‸$")).toBeNull();
    expect(contextAt("![[Пример‸")).toBeNull();
    expect(contextAt("[[Пример]] и ‸")).toBeNull();
    expect(contextAt("\\[[Пример‸")).toBeNull();
  });

  it("replaces the whole construct, the closing `]]` included, and keeps an alias", () => {
    const closed = contextAt("[[Прим‸]]");
    expect(closed).not.toBeNull();
    if (!closed) return;
    expect(wikilinkInsertion(closed, "Пример заметки")).toEqual({
      changes: { from: 0, to: 8, insert: "[[Пример заметки]]" },
      selection: { anchor: 18 },
      userEvent: "input.complete",
    });
    const aliased = contextAt("[[Прим‸ер|подпись]] дальше");
    expect(aliased?.keepsAlias).toBe(true);
    if (!aliased) return;
    const spec = wikilinkInsertion(aliased, "Пример заметки");
    const state = stateOf("[[Пример|подпись]] дальше", 0);
    expect(state.update(spec).state.doc.toString()).toBe("[[Пример заметки|подпись]] дальше");
  });
});

describe("the `[[` menu in the editor (Л10.2)", () => {
  it("asks the backend while typing, keeps the menu through spaces, and Enter inserts the chosen note once", async () => {
    const suggest = vi.fn(async () => NOTES);
    const view = makeView("Текст ", suggest);
    typeText(view, "[[]]");
    view.dispatch({ selection: { anchor: view.state.doc.length - 2 } });
    typeText(view, "Пример за");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(suggest).toHaveBeenLastCalledWith({ kind: "notes", text: "Пример за" });
    expect(currentCompletions(view.state).map((option) => option.label)).toEqual(["Пример заметки", "Проверка просмотрщика"]);
    expect(selectedCompletion(view.state)?.label).toBe("Пример заметки");
    // The highlighted letters and the folder's line come from the backend.
    const menu = view.dom.querySelector(".mine-link-menu");
    expect(menu).toHaveAttribute("data-floating-menu", "search");
    expect(menu?.querySelector(".cm-completionMatchedText")?.textContent).toBe("Пример");
    expect(menu?.querySelector(".cm-completionDetail")?.textContent).toBe("Cards");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("Текст [[Пример заметки]]");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it("moves with the arrows, takes a suggestion with Tab, and Escape leaves the text as typed", async () => {
    const view = makeView("", async () => NOTES);
    typeText(view, "[[Пр");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    press(view, "ArrowDown");
    expect(selectedCompletion(view.state)?.label).toBe("Проверка просмотрщика");
    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("[[Проверка просмотрщика]]");

    typeText(view, " [[Пр");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(press(view, "Escape")).toBe(true);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe("[[Проверка просмотрщика]] [[Пр");
    view.destroy();
  });

  it("asks for headings and blocks of the note before `#` and `^`", async () => {
    const suggest = vi.fn(async (query: LinkQuery): Promise<LinkSuggestion[]> => (query.kind === "headings"
      ? [{ label: "Раздел", detail: "H2", target: "Пример заметки#Раздел", slug: "Cards/Пример заметки", matches: [] }]
      : []));
    const view = makeView("", suggest);
    typeText(view, "[[Пример заметки#Ра");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(suggest).toHaveBeenLastCalledWith({ kind: "headings", note: "Пример заметки", text: "Ра" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    press(view, "Enter");
    expect(view.state.doc.toString()).toBe("[[Пример заметки#Раздел]]");
    view.destroy();
  });

  it("asks nothing in code and nothing for an embed", async () => {
    const suggest = vi.fn(async () => NOTES);
    const view = makeView("`code ", suggest);
    typeText(view, "[[Пр`");
    view.dispatch({ selection: { anchor: view.state.doc.length - 1 } });
    typeText(view, "и");
    typeText(view, " ![[Пр");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(suggest).not.toHaveBeenCalled();
    expect(completionStatus(view.state)).toBeNull();
    view.destroy();
  });

  it("closes brackets but not quotes, which are the text's apostrophes", () => {
    const view = makeView("", async () => []);
    const bracket = insertBracket(view.state, "[");
    expect(bracket?.state.doc.toString()).toBe("[]");
    expect(insertBracket(view.state, "(")?.state.doc.toString()).toBe("()");
    expect(insertBracket(view.state, "{")?.state.doc.toString()).toBe("{}");
    expect(insertBracket(view.state, "\"")).toBeNull();
    expect(insertBracket(view.state, "'")).toBeNull();
    view.destroy();
  });
});
