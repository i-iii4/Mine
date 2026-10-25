import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { useContext } from "react";
import { NoteEditingSwitch } from "@/components/editing/noteEditingSwitch";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { editingEditorHandle } from "./editingEditorHandle";

// The page brings its own made-up backend through Tauri's internals, as the
// browser check of row 50.29 will drive it: the real Tauri modules, not the
// test setup's mocks.
vi.unmock("@tauri-apps/api/core");
vi.unmock("@tauri-apps/api/event");
vi.unmock("@tauri-apps/api/webview");

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidLayout: vi.fn(() => ({ fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

interface EditingHandle {
  record: { writes: Array<{ base: string; accepted: boolean; length: number; body?: string }>; sessions: string[] };
  body(): string;
  writeFromOutside(body: string): void;
}

function handle(): EditingHandle {
  const value: unknown = Reflect.get(window, "__editing");
  if (!value || typeof value !== "object") throw new Error("the page installed no backend");
  // The page sets this handle itself (EditingPage.tsx).
  return value as EditingHandle;
}

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

describe("the editing page (SPEC_EDITING.md, Л17)", () => {
  it("has the editor on where nothing turns it off: the card opens straight in it (Л1, row 50.12)", () => {
    let seen: boolean | null = null;
    function Probe() {
      seen = useContext(NoteEditingSwitch);
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(true);
  });

  it("opens the fixture in the editor and writes every edit over its base", async () => {
    const { EditingPage } = await import("./EditingPage");
    render(<EditingPage />);
    const content = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".cm-content");
      if (!found) throw new Error("no editor yet");
      return found;
    }, { timeout: 5000 });
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error("no view");
    const backend = handle();
    expect(backend.record.sessions).toContain("begin Cards/Проверка просмотрщика");
    const firstLine = view.state.doc.line(1);
    act(() => {
      view.dispatch({ changes: { from: firstLine.to, insert: "!" }, userEvent: "input.type" });
    });
    await waitFor(() => expect(backend.body().split("\n")[0]).toBe("# Проверка просмотрщика: код, Mermaid, таблицы!"));
    expect(backend.record.writes.every((write) => write.accepted)).toBe(true);
    // Only the last write keeps its body.
    expect(backend.record.writes.slice(0, -1).every((write) => write.body === undefined)).toBe(true);
    expect(backend.record.writes.at(-1)?.body).toBe(backend.body());
    await waitFor(() => expect(backend.record.sessions).toContain("unsaved false"));

    // The handle the browser checks drive the editor by (Л17).
    const editor = editingEditorHandle();
    expect(await editor.text()).toBe(backend.body());
    expect(await editor.after("# Пров")).toBe(6);
    expect(await editor.after("no such text")).toBeNull();
    expect(await editor.select(2)).toBe(true);
    expect(await editor.selection()).toEqual({ anchor: 2, head: 2 });
    const parsed = await editor.parsed();
    expect(parsed?.length).toBe(view.state.doc.length);
    expect(await editor.undo()).toBe(true);
    await waitFor(() => expect(backend.body().split("\n")[0]).toBe("# Проверка просмотрщика: код, Mermaid, таблицы"));
  });
});
