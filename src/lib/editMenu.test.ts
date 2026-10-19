import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditMenuCommand, FocusedEditor } from "@/types";
import { reportFocusedEditor } from "./commands";
import { EDIT_MENU_EVENT, refreshEditMenu, registerEditMenuEditor, type EditMenuEditor } from "./editMenu";

// SPEC_EDITING.md, Л12 (row 50.24): the page tells the backend whether its
// note editor holds the focus and what its history can do, and carries out
// the Edit menu's commands the backend sends while it does.

vi.mock("./commands", () => ({ reportFocusedEditor: vi.fn(async () => undefined) }));

/** A made-up editor around a real field of the page. */
function fakeEditor(history: FocusedEditor = { can_undo: false, can_redo: false }) {
  const field = document.createElement("textarea");
  document.body.append(field);
  const ran: EditMenuCommand[] = [];
  let current = history;
  const editor: EditMenuEditor = {
    hasFocus: () => document.activeElement === field,
    history: () => current,
    run: (command) => {
      ran.push(command);
    },
  };
  return {
    editor,
    field,
    ran,
    setHistory(next: FocusedEditor) {
      current = next;
    },
  };
}

/** The backend's command, as the page hears it (the test setup bridges page
 *  events to window events). */
function emitCommand(command: EditMenuCommand) {
  act(() => {
    window.dispatchEvent(new CustomEvent(EDIT_MENU_EVENT, { detail: { event: EDIT_MENU_EVENT, payload: command } }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const releases: Array<() => void> = [];

beforeEach(() => {
  vi.mocked(reportFocusedEditor).mockClear();
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  document.body.replaceChildren();
});

describe("the Edit menu in the page (SPEC_EDITING.md, Л12)", () => {
  it("reports the editor in focus with its history, and nothing once the focus leaves it", async () => {
    const fake = fakeEditor({ can_undo: true, can_redo: false });
    releases.push(registerEditMenuEditor(fake.editor));
    // Nothing holds the focus yet: the backend already knows that.
    expect(reportFocusedEditor).not.toHaveBeenCalled();
    fake.field.focus();
    await settle();
    expect(reportFocusedEditor).toHaveBeenLastCalledWith({ can_undo: true, can_redo: false });
    // A change of the history is told once, a refresh without one is not.
    fake.setHistory({ can_undo: true, can_redo: true });
    refreshEditMenu();
    refreshEditMenu();
    expect(vi.mocked(reportFocusedEditor).mock.calls).toEqual([
      [{ can_undo: true, can_redo: false }],
      [{ can_undo: true, can_redo: true }],
    ]);
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    await settle();
    expect(reportFocusedEditor).toHaveBeenLastCalledWith(null);
    expect(reportFocusedEditor).toHaveBeenCalledTimes(3);
  });

  it("carries a command out in the editor in focus", async () => {
    const fake = fakeEditor({ can_undo: true, can_redo: false });
    releases.push(registerEditMenuEditor(fake.editor));
    fake.field.focus();
    await settle();
    emitCommand("undo");
    emitCommand("redo");
    emitCommand("select_all");
    expect(fake.ran).toEqual(["undo", "redo", "select_all"]);
  });

  it("gives a command that comes after the focus left the editor to the field in focus, as the stock item would", async () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const fake = fakeEditor();
    releases.push(registerEditMenuEditor(fake.editor));
    emitCommand("undo");
    emitCommand("select_all");
    expect(fake.ran).toEqual([]);
    expect(execCommand.mock.calls).toEqual([["undo"], ["selectAll"]]);
    Reflect.deleteProperty(document, "execCommand");
  });

  it("tells the backend nothing holds the focus when the editor's session ends, and stops listening", async () => {
    const fake = fakeEditor({ can_undo: false, can_redo: true });
    const release = registerEditMenuEditor(fake.editor);
    fake.field.focus();
    await settle();
    expect(reportFocusedEditor).toHaveBeenLastCalledWith({ can_undo: false, can_redo: true });
    release();
    release();
    expect(reportFocusedEditor).toHaveBeenLastCalledWith(null);
    expect(reportFocusedEditor).toHaveBeenCalledTimes(2);
    await settle();
    emitCommand("undo");
    expect(fake.ran).toEqual([]);
  });
});
