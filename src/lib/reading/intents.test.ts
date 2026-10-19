import { noteInteractionIntent, observeNoteIntents, type NoteElement, type NoteEvent, type NoteInteraction, type NoteSurface } from "./intents";

function intent(surface: NoteSurface, element: NoteElement, event: NoteEvent, extra: Partial<NoteInteraction> = {}) {
  return noteInteractionIntent({ surface, element, event, ...extra }).kind;
}

const NOTE_LINK: NoteElement = { kind: "link", to: { kind: "note", target: "Пример заметки" } };
const EXTERNAL_LINK: NoteElement = { kind: "link", to: { kind: "external", href: "https://example.com" } };
const ANCHOR_LINK: NoteElement = { kind: "link", to: { kind: "anchor", fragment: "fn-1" } };

describe("noteInteractionIntent (SPEC_EDITING.md, Л11.1)", () => {
  it("opens a link on both surfaces where it is drawn", () => {
    expect(noteInteractionIntent({ surface: "reading", element: NOTE_LINK, event: "click" })).toEqual({ kind: "OpenNote", target: "Пример заметки" });
    expect(noteInteractionIntent({ surface: "editing", element: EXTERNAL_LINK, event: "click" })).toEqual({ kind: "OpenExternal", href: "https://example.com" });
    expect(noteInteractionIntent({ surface: "reading", element: ANCHOR_LINK, event: "click" })).toEqual({ kind: "JumpToAnchor", fragment: "fn-1" });
  });

  it("gives a revealed link in the editor the caret and opens it with ⌘-click (Л10.1)", () => {
    expect(intent("editing", NOTE_LINK, "click", { revealed: true })).toBe("PlaceCaret");
    expect(intent("editing", NOTE_LINK, "command-click", { revealed: true })).toBe("OpenNote");
    expect(intent("editing", NOTE_LINK, "enter")).toBe("Nothing");
  });

  it("changes a task with a click and Space, never Enter, on both surfaces (Л7.4, Ч12.7)", () => {
    for (const surface of ["reading", "editing"] as const) {
      expect(intent(surface, { kind: "task" }, "click")).toBe("ToggleTask");
      expect(intent(surface, { kind: "task" }, "space")).toBe("ToggleTask");
      expect(intent(surface, { kind: "task" }, "enter")).toBe("Nothing");
    }
  });

  it("opens a picture's preview and an embed's note when reading, and chooses them as blocks when editing (Л5.3)", () => {
    expect(intent("reading", { kind: "image" }, "click")).toBe("OpenImagePreview");
    expect(intent("reading", { kind: "embed" }, "click")).toBe("OpenEmbed");
    expect(intent("reading", { kind: "embed" }, "enter")).toBe("OpenEmbed");
    expect(intent("editing", { kind: "image" }, "click")).toBe("SelectBlock");
    expect(intent("editing", { kind: "embed" }, "click")).toBe("SelectBlock");
    expect(intent("editing", { kind: "image" }, "enter", { selected: true })).toBe("RevealBlock");
    expect(intent("editing", { kind: "embed" }, "enter")).toBe("Nothing");
  });

  it("opens a picture and an embed with ⌘-click on both surfaces, as a click opens them when reading (Л10.1, Л11.5)", () => {
    for (const surface of ["reading", "editing"] as const) {
      expect(intent(surface, { kind: "image" }, "command-click")).toBe("OpenImagePreview");
      expect(intent(surface, { kind: "embed" }, "command-click")).toBe("OpenEmbed");
    }
  });

  it("lets the parity corpus hear every decision, and stops when it is done", () => {
    const heard: string[] = [];
    const stop = observeNoteIntents((interaction, decided) => heard.push(`${interaction.surface} ${decided.kind}`));
    intent("reading", { kind: "task" }, "click");
    stop();
    intent("editing", { kind: "task" }, "click");
    expect(heard).toEqual(["reading ToggleTask"]);
  });

  it("shows the source of code, a diagram, a formula, a callout and HTML at a click when editing", () => {
    for (const kind of ["code", "mermaid", "math", "callout", "html"] as const) {
      expect(intent("editing", { kind }, "click")).toBe("RevealBlock");
      expect(intent("editing", { kind }, "enter", { selected: true })).toBe("RevealBlock");
      expect(intent("reading", { kind }, "click")).toBe("Nothing");
    }
  });

  it("opens a cell of a table when editing (Л9.2)", () => {
    expect(intent("editing", { kind: "table" }, "click")).toBe("EnterTableCell");
    expect(intent("editing", { kind: "table" }, "enter", { selected: true })).toBe("EnterTableCell");
    expect(intent("editing", { kind: "table-cell" }, "click")).toBe("EnterTableCell");
    expect(intent("reading", { kind: "table-cell" }, "click")).toBe("Nothing");
  });

  it("gives the caret to text and a rule when editing, and does nothing when reading", () => {
    expect(intent("editing", { kind: "text" }, "click")).toBe("PlaceCaret");
    expect(intent("editing", { kind: "rule" }, "click")).toBe("PlaceCaret");
    expect(intent("reading", { kind: "text" }, "click")).toBe("Nothing");
  });
});
