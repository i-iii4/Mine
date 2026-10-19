import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { EditorView } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Detail } from "@/components/Detail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beginNoteEdit, getBlock, resolveNoteLink, saveNoteBody, toggleTaskItem } from "@/lib/commands";
import { revealField } from "@/lib/editing/reveal";
import { observeNoteIntents, type NoteInteractionIntent, type NoteSurface } from "@/lib/reading/intents";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { READING_FIXTURE_BODY } from "@/test/editingFixture";
import type { IndexedBlock, SaveNoteBodyParams } from "@/types";
import { NoteEditingSwitch } from "./noteEditingSwitch";

// The parity corpus (SPEC_EDITING.md, Л11.1; Local MD, SPEC_SURFACE_PARITY):
// the same note in the open card's reading mode and in its editor, the same
// real pointer and key events on each kind of element, and the intent each
// surface decided for them, heard as the shared decision makes it. Where the
// two differ, the difference is named below with its rule.

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidTheme: vi.fn(() => ({ dark: false, fontFamily: "system-ui", width: 680, variables: {} })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(),
  resolveNoteLink: vi.fn(),
  toggleTaskItem: vi.fn(),
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  reportFocusedEditor: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(),
  suggestNoteLinks: vi.fn(async () => []),
  copyMediaAssetToClipboard: vi.fn(),
  prepareDeleteMediaAsset: vi.fn(),
  icloudDownloadProgress: vi.fn(async () => ({ status: "unknown", percent: null })),
  youtubePlayerUrl: vi.fn(),
  startSourceVideoDownload: vi.fn(async () => null),
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

const SLUG = "Cards/Проверка просмотрщика";
const EMBED_SLUG = "Cards/Пример заметки";

/** A part of the fixture, as it stands in it: the corpus is the fixture's,
 *  cut to what jsdom's editor draws at once (it lays nothing out). */
function piece(text: string): string {
  if (!READING_FIXTURE_BODY.includes(text)) throw new Error(`the fixture lost “${text.slice(0, 40)}”`);
  return text;
}

const FIRST_PARAGRAPH = READING_FIXTURE_BODY.split("\n").find((line) => line.startsWith("Короткий абзац")) ?? "";
/** A picture of the body: the fixture has none, its form is Р5's. */
const PICTURE = "![[Образец.png]]";

/** The corpus in two notes: jsdom's editor draws only the first screen it
 *  estimates, so each note is short enough to be drawn whole. */
const CORPUS_PARTS = [
  [
    piece(FIRST_PARAGRAPH),
    piece("- [ ] Невыполненная задача\n- [x] Выполненная задача"),
    piece("> [!note] Заметка\n> Выноска Obsidian типа note."),
    piece("```\nplain text block\n    with indentation\n```"),
    piece("```mermaid\nflowchart LR\n  A[[Подпрограмма]] --> B\n```"),
    piece("[^1]: Текст сноски с [ссылкой](https://example.com)."),
  ].join("\n\n"),
  [
    piece("$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$"),
    piece("<details>\n<summary>Раскрывающийся блок HTML</summary>\n\nСкрытое содержимое с **разметкой**.\n\n</details>"),
    piece("| Ключ | Значение |\n|---|---|\n| a | 1 |\n| b | 2 |"),
    piece("![[Пример заметки]]"),
    PICTURE,
    "Последний абзац.",
  ].join("\n\n"),
];
const [FIRST_PART = "", SECOND_PART = ""] = CORPUS_PARTS;

const EMBEDDED: IndexedBlock = indexedBlock({
  slug: EMBED_SLUG,
  display_title: "Пример заметки",
  body: "Текст примера заметки.",
  preview_text: "Текст примера заметки.",
  body_hash: "hash-embed",
});

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

beforeEach(() => {
  vi.mocked(resolveNoteLink).mockImplementation(async (_source, target) => (target.split("#")[0] === "Пример заметки" ? EMBED_SLUG : null));
  vi.mocked(getBlock).mockImplementation(async (slug) => (slug === EMBED_SLUG ? EMBEDDED : null));
  vi.mocked(toggleTaskItem).mockImplementation(async () => indexedBlock({ slug: SLUG, body: FIRST_PART, body_hash: "hash-0" }));
  vi.mocked(beginNoteEdit).mockImplementation(async () => indexedBlock({ slug: SLUG, body: openedBody, body_hash: "hash-0" }));
  vi.mocked(saveNoteBody).mockImplementation(async (params: SaveNoteBodyParams) => ({
    block: indexedBlock({ slug: SLUG, body: params.body, body_hash: "hash-1" }),
    split_changed: false,
    unchanged: false,
  }));
  vi.mocked(openUrl).mockClear();
});

let stopObserving: (() => void) | null = null;
afterEach(() => {
  stopObserving?.();
  stopObserving = null;
});

interface Surface {
  container: HTMLElement;
  onOpenRelatedNote: ReturnType<typeof vi.fn>;
  onOpenImagePreview: ReturnType<typeof vi.fn>;
  /** The intents decided for the events of the last `act`, in order. */
  decided: Array<{ surface: NoteSurface; intent: NoteInteractionIntent }>;
  view: EditorView | null;
}

/** The body the editor's session opens with: the note last opened. */
let openedBody = FIRST_PART;

async function open(surface: NoteSurface, body: string): Promise<Surface> {
  openedBody = body;
  const decided: Surface["decided"] = [];
  stopObserving = observeNoteIntents((interaction, intent) => decided.push({ surface: interaction.surface, intent }));
  const onOpenRelatedNote = vi.fn();
  const onOpenImagePreview = vi.fn();
  const card = indexedBlock({ slug: SLUG, body, body_hash: "hash-0", display_title: "Проверка просмотрщика" });
  const { container } = render(
    <TooltipProvider>
      <DndContext>
        <NoteEditingSwitch.Provider value={surface === "editing"}>
          <Detail
            block={card}
            vaultPath="/vault"
            thumbsRootPath="/thumbs"
            tags={[]}
            onClose={vi.fn()}
            onNavigate={vi.fn()}
            onToggleTag={vi.fn()}
            onCreateAndAssign={vi.fn()}
            onTagsChanged={vi.fn()}
            onRequestRename={vi.fn()}
            onRequestDelete={vi.fn()}
            onOpenRelatedNote={onOpenRelatedNote}
            onOpenImagePreview={onOpenImagePreview}
          />
        </NoteEditingSwitch.Provider>
      </DndContext>
    </TooltipProvider>,
  );
  let view: EditorView | null = null;
  if (surface === "editing") {
    view = await waitFor(() => {
      const content = container.querySelector<HTMLElement>(".cm-content");
      const found = content ? EditorView.findFromDOM(content) : null;
      if (!found) throw new Error("no editor yet");
      return found;
    });
  }
  // The embeds have answered and drawn their cards.
  if (body.includes("![[Пример заметки]]")) {
    await waitFor(() => expect(container.querySelector("[data-note-embed-open]")).not.toBeNull());
  }
  return { container, onOpenRelatedNote, onOpenImagePreview, decided, view };
}

/** A press and a click of the pointer, as a person makes them. */
async function click(element: Element, modifiers: { metaKey?: boolean } = {}) {
  const init = { bubbles: true, cancelable: true, button: 0, ...modifiers };
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", init));
    // A link the browser would follow stays on this page.
    const stay = (event: Event) => event.preventDefault();
    window.addEventListener("click", stay, { once: true });
    element.dispatchEvent(new MouseEvent("click", init));
    window.removeEventListener("click", stay);
  });
}

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

/** The first intent the surface itself decided for the last events. */
function firstDecided(on: Surface, surface: NoteSurface): NoteInteractionIntent["kind"] | "none" {
  return on.decided.find((entry) => entry.surface === surface)?.intent.kind ?? "none";
}

function must<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) throw new Error(`no ${what}`);
  return element;
}

/** Where each kind of element stands on each surface: in the editor, the
 *  drawn text outside widgets, or the widget of the block. */
const FIND: Record<string, Record<NoteSurface, (root: HTMLElement) => Element | null>> = {
  "note link": {
    reading: (root) => [...root.querySelectorAll("[data-article-body] a")].find((a) => a.textContent === "Пример заметки") ?? null,
    editing: (root) => [...root.querySelectorAll(".cm-content a")].find((a) => a.textContent === "Пример заметки" && !a.closest(".cm-md-block")) ?? null,
  },
  "external link": {
    reading: (root) => [...root.querySelectorAll("[data-article-body] a")].find((a) => a.textContent === "внешней ссылкой") ?? null,
    editing: (root) => [...root.querySelectorAll(".cm-content a")].find((a) => a.textContent === "внешней ссылкой") ?? null,
  },
  footnote: {
    reading: (root) => root.querySelector("[data-article-body] sup a"),
    editing: (root) => root.querySelector(".cm-md-footnote a"),
  },
  task: {
    reading: (root) => root.querySelector("[data-article-body] [data-task-checkbox]"),
    editing: (root) => root.querySelector(".cm-md-inline-task [data-task-checkbox]"),
  },
  embed: {
    reading: (root) => root.querySelector("[data-article-body] [data-note-embed-open]"),
    editing: (root) => root.querySelector("[data-editor-block] [data-note-embed-open]"),
  },
  picture: {
    reading: (root) => root.querySelector("[data-article-body] [data-detail-media-action-frame] img"),
    editing: (root) => root.querySelector("[data-editor-block] [data-detail-media-action-frame] img"),
  },
  code: {
    reading: (root) => root.querySelector("[data-article-body] [data-code-block]"),
    editing: (root) => root.querySelector("[data-editor-block='code'] [data-code-block]"),
  },
  mermaid: {
    reading: (root) => root.querySelector("[data-article-body] [data-mermaid]"),
    editing: (root) => root.querySelector("[data-editor-block='mermaid'] [data-mermaid]"),
  },
  formula: {
    reading: (root) => root.querySelector("[data-article-body] [data-math-display], [data-article-body] [data-math-source]"),
    editing: (root) => root.querySelector("[data-editor-block='math'] .mine-article"),
  },
  callout: {
    reading: (root) => root.querySelector("[data-article-body] [data-callout]"),
    editing: (root) => root.querySelector("[data-editor-block='callout'] [data-callout]"),
  },
  html: {
    reading: (root) => root.querySelector("[data-article-body] [data-html-details] p"),
    editing: (root) => root.querySelector("[data-editor-block='html'] [data-html-details]"),
  },
  table: {
    reading: (root) => root.querySelector("[data-article-body] td"),
    editing: (root) => root.querySelector("[data-editor-block='table'] td"),
  },
  text: {
    reading: (root) => [...root.querySelectorAll("[data-article-body] p")].find((p) => p.textContent === "Последний абзац.") ?? null,
    editing: (root) => [...root.querySelectorAll(".cm-line")].find((line) => line.textContent === "Последний абзац.") ?? null,
  },
};

type Expected = NoteInteractionIntent["kind"] | "none";

/** The corpus: an element, an event, and what each surface decides. Rows
 *  whose two columns differ are the named differences of the rules. */
const CORPUS_ROWS: Array<{ element: keyof typeof FIND; event: "click" | "command-click"; reading: Expected; editing: Expected; rule?: string }> = [
  { element: "note link", event: "click", reading: "OpenNote", editing: "OpenNote" },
  { element: "note link", event: "command-click", reading: "OpenNote", editing: "OpenNote" },
  { element: "external link", event: "click", reading: "OpenExternal", editing: "OpenExternal" },
  { element: "footnote", event: "click", reading: "JumpToAnchor", editing: "JumpToAnchor" },
  { element: "task", event: "click", reading: "ToggleTask", editing: "ToggleTask" },
  { element: "embed", event: "command-click", reading: "OpenEmbed", editing: "OpenEmbed" },
  { element: "picture", event: "command-click", reading: "OpenImagePreview", editing: "OpenImagePreview" },
  // Л5.3: a click chooses a picture or an embed as a block in the editor.
  { element: "embed", event: "click", reading: "OpenEmbed", editing: "SelectBlock", rule: "Л5.3" },
  { element: "picture", event: "click", reading: "OpenImagePreview", editing: "SelectBlock", rule: "Л5.3" },
  // Л5.3, Л11.1: code, a diagram, a formula, a callout and HTML show their
  // source at a click, which only the editor has.
  { element: "code", event: "click", reading: "none", editing: "RevealBlock", rule: "RevealBlock" },
  { element: "mermaid", event: "click", reading: "none", editing: "RevealBlock", rule: "RevealBlock" },
  { element: "formula", event: "click", reading: "none", editing: "RevealBlock", rule: "RevealBlock" },
  { element: "callout", event: "click", reading: "none", editing: "RevealBlock", rule: "RevealBlock" },
  { element: "html", event: "click", reading: "none", editing: "RevealBlock", rule: "RevealBlock" },
  // Л9.2: a table opens a cell, which only the editor has.
  { element: "table", event: "click", reading: "none", editing: "EnterTableCell", rule: "EnterTableCell" },
  // Text takes the caret in the editor: CodeMirror places it, nothing is
  // decided (PlaceCaret); the reading mode does nothing.
  { element: "text", event: "click", reading: "none", editing: "none", rule: "PlaceCaret" },
];

describe("the parity corpus of the open card (SPEC_EDITING.md, Л11.1)", () => {
  it("decides the same intent on both surfaces for the same events, the named rules apart", async () => {
    const results: Record<NoteSurface, Map<number, string>> = { reading: new Map(), editing: new Map() };
    for (const surface of ["reading", "editing"] as const) {
      for (const body of CORPUS_PARTS) {
        const on = await open(surface, body);
        for (const [index, row] of CORPUS_ROWS.entries()) {
          const target = FIND[row.element]?.[surface](on.container);
          if (!target || results[surface].has(index)) continue;
          on.decided.length = 0;
          await click(target, { metaKey: row.event === "command-click" });
          results[surface].set(index, `${row.element} ${row.event}: ${firstDecided(on, surface)}`);
          // Each row starts from a card that shows its text, nothing chosen.
          if (on.view) {
            const view = on.view;
            act(() => view.dispatch({ selection: { anchor: 0 } }));
            await press(view.contentDOM, "Escape");
          }
        }
        stopObserving?.();
        stopObserving = null;
        cleanup();
      }
    }
    const inOrder = (found: Map<number, string>) => CORPUS_ROWS.map((_row, index) => found.get(index) ?? "not found");
    expect(inOrder(results.reading)).toEqual(CORPUS_ROWS.map((row) => `${row.element} ${row.event}: ${row.reading}`));
    expect(inOrder(results.editing)).toEqual(CORPUS_ROWS.map((row) => `${row.element} ${row.event}: ${row.editing}`));
    // Every difference is named by its rule.
    for (const row of CORPUS_ROWS) {
      if (row.reading !== row.editing) expect(row.rule).toBeDefined();
    }
  });

  it("carries the shared intents out on both surfaces", async () => {
    const reading = await open("reading", SECOND_PART);
    await click(must(FIND.picture?.reading(reading.container), "picture"));
    expect(reading.onOpenImagePreview).toHaveBeenCalledTimes(1);
    await click(must(FIND.embed?.reading(reading.container), "embed"));
    expect(reading.onOpenRelatedNote).toHaveBeenCalledWith(EMBED_SLUG);
    stopObserving?.();
    cleanup();
    const readingFirst = await open("reading", FIRST_PART);
    await click(must(FIND["note link"]?.reading(readingFirst.container), "note link"));
    await waitFor(() => expect(readingFirst.onOpenRelatedNote).toHaveBeenCalledWith(EMBED_SLUG));
    await click(must(FIND.task?.reading(readingFirst.container), "task"));
    await waitFor(() => expect(toggleTaskItem).toHaveBeenCalled());
    stopObserving?.();
    cleanup();

    const editing = await open("editing", FIRST_PART);
    const view = editing.view;
    if (!view) throw new Error("no editor");
    await click(must(FIND["note link"]?.editing(editing.container), "note link"));
    await waitFor(() => expect(editing.onOpenRelatedNote).toHaveBeenCalledWith(EMBED_SLUG));
    await click(must(FIND["external link"]?.editing(editing.container), "external link"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    // A task's box changes its one sign in the document, as an edit.
    const before = view.state.doc.toString();
    await click(must(FIND.task?.editing(editing.container), "task"));
    expect(view.state.doc.toString()).toBe(before.replace("- [ ] Невыполненная", "- [x] Невыполненная"));
    await waitFor(() => expect(saveNoteBody).toHaveBeenCalled());
    // A click on code shows its source.
    await click(must(FIND.code?.editing(editing.container), "code"));
    expect(view.state.field(revealField).blocks.length).toBe(1);
    stopObserving?.();
    cleanup();

    const editingSecond = await open("editing", SECOND_PART);
    await click(must(FIND.picture?.editing(editingSecond.container), "picture"), { metaKey: true });
    expect(editingSecond.onOpenImagePreview).toHaveBeenCalledTimes(1);
    await click(must(FIND.embed?.editing(editingSecond.container), "embed"), { metaKey: true });
    expect(editingSecond.onOpenRelatedNote).toHaveBeenLastCalledWith(EMBED_SLUG);
  });
});
