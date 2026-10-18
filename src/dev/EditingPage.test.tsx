import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { useContext } from "react";
import { NoteEditingSwitch } from "@/components/editing/noteEditingSwitch";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";

// The page brings its own made-up backend through Tauri's internals, as the
// browser check of row 50.29 will drive it: the real Tauri modules, not the
// test setup's mocks.
vi.unmock("@tauri-apps/api/core");
vi.unmock("@tauri-apps/api/event");
vi.unmock("@tauri-apps/api/webview");

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidTheme: vi.fn(() => ({ dark: false, fontFamily: "system-ui", width: 680, variables: {} })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

interface EditingHandle {
  record: { writes: Array<{ base: string; body: string; accepted: boolean }>; sessions: string[] };
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
  it("leaves the editor off where no page turns its switch on (Л1, row 50.12)", () => {
    let seen: boolean | null = null;
    function Probe() {
      seen = useContext(NoteEditingSwitch);
      return null;
    }
    render(<Probe />);
    expect(seen).toBe(false);
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
    await waitFor(() => expect(backend.record.sessions).toContain("unsaved false"));
  });
});
