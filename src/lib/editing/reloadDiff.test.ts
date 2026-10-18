import { history, redo, undo } from "@codemirror/commands";
import { ChangeSet, EditorSelection, EditorState, Text, type ChangeSpec, type Extension } from "@codemirror/state";
import { bodyOfState, editorBody, lineEndingExtensions } from "./lineEndings";
import { externalChange, externalChangeSpec, lineHunks, reloadChanges } from "./reloadDiff";

function text(value: string): Text {
  return Text.of(value.split("\n"));
}

/** The changes as `[from, to, insert]`, the inserted lines joined by `\n`. */
function described(changes: ChangeSpec[]): Array<[number, number, string]> {
  return changes.map((change) => {
    if (typeof change !== "object" || change === null || !("from" in change)) throw new Error("unexpected change");
    const insert = change.insert;
    const inserted = insert instanceof Text ? insert.sliceString(0, insert.length, "\n") : String(insert ?? "");
    return [change.from, change.to ?? change.from, inserted];
  });
}

function applied(before: string, after: string): string {
  const changes = reloadChanges(text(before), text(after));
  return ChangeSet.of(changes, text(before).length).apply(text(before)).sliceString(0, undefined, "\n");
}

function editorState(body: string, extra: Extension = []) {
  const loaded = editorBody(body);
  return EditorState.create({ doc: loaded.text, extensions: [lineEndingExtensions(loaded.mode), history(), extra] });
}

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state;
  command({ state, dispatch: (tr) => { next = tr.state; } });
  return next;
}

describe("reloadChanges (SPEC_EDITING.md, Л4.2)", () => {
  it("finds no change between equal documents", () => {
    expect(reloadChanges(text("same\ntext"), text("same\ntext"))).toEqual([]);
  });

  it("changes only the sign that differs", () => {
    expect(described(reloadChanges(text("one two three"), text("one twO three")))).toEqual([[6, 7, "O"]]);
  });

  it("changes separate lines separately, the lines between untouched", () => {
    const before = "alpha\nbeta\ngamma\ndelta\nepsilon";
    const after = "alpha\nBETA\ngamma\ndelta\nepsilon!";
    const changes = described(reloadChanges(text(before), text(after)));
    expect(changes).toEqual([[6, 10, "BETA"], [30, 30, "!"]]);
    expect(applied(before, after)).toBe(after);
  });

  it("inserts and deletes whole lines", () => {
    expect(applied("a\nb\nc", "a\nx\nb\nc")).toBe("a\nx\nb\nc");
    expect(applied("a\nb\nc", "a\nc")).toBe("a\nc");
    expect(applied("a", "a\nb")).toBe("a\nb");
    expect(applied("a\nb", "b")).toBe("b");
    expect(applied("", "new")).toBe("new");
    expect(applied("old", "")).toBe("");
  });

  it("gives every random edit back exactly", () => {
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    const words = ["a", "b", "line", "", "# h", "- [ ] t", "x y"];
    for (let round = 0; round < 200; round += 1) {
      const lines = Array.from({ length: random(12) }, () => words[random(words.length)] ?? "");
      const edited = [...lines];
      for (let edit = 0; edit < 1 + random(4); edit += 1) {
        const at = random(edited.length + 1);
        const kind = random(3);
        if (kind === 0) edited.splice(at, 0, words[random(words.length)] ?? "");
        else if (kind === 1) edited.splice(at, 1);
        else edited[at] = `${edited[at] ?? ""}!`;
      }
      expect(applied(lines.join("\n"), edited.join("\n"))).toBe(edited.join("\n"));
    }
  });

  it("finds the fewest changed lines and gives up past its limit", () => {
    expect(lineHunks(["a", "b", "c"], ["a", "c"])).toEqual([{ oldFrom: 1, oldTo: 2, newFrom: 1, newTo: 1 }]);
    expect(lineHunks(["a", "b"], ["c", "d"], 3)).toBeNull();
  });

  it("applies a body with \\r\\n line breaks by its lines", () => {
    const state = editorState("one\r\ntwo\r\nthree\r\n");
    const next = state.update(externalChangeSpec(state, "one\r\n2\r\nthree\r\nfour\r\n")).state;
    expect(bodyOfState(next, false)).toBe("one\r\n2\r\nthree\r\nfour\r\n");
  });
});

describe("an external change (Л4.2, Л4.10)", () => {
  it("carries the caret and the selection through the change", () => {
    let state = editorState("first line\nsecond line\nthird line");
    const second = state.doc.line(2);
    state = state.update({ selection: EditorSelection.range(second.from + 2, second.from + 6) }).state;
    state = state.update(externalChangeSpec(state, "a new first line\nsecond line\nthird line")).state;
    const moved = state.doc.line(2);
    expect(state.selection.main.from).toBe(moved.from + 2);
    expect(state.selection.main.to).toBe(moved.from + 6);
  });

  it("is marked as external and kept out of the history: ⌘Z undoes only the session's own edit", () => {
    let state = editorState("own text\nfile text");
    state = state.update({ changes: { from: 3, insert: " typed" }, userEvent: "input.type" }).state;
    const external = state.update(externalChangeSpec(state, "own typed text\nfile text changed elsewhere"));
    expect(external.annotation(externalChange)).toBe(true);
    state = external.state;
    state = run(state, undo);
    expect(state.sliceDoc()).toBe("own text\nfile text changed elsewhere");
    state = run(state, redo);
    expect(state.sliceDoc()).toBe("own typed text\nfile text changed elsewhere");
  });
});
