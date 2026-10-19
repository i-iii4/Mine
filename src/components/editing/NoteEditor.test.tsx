import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { EditorView } from "@codemirror/view";
import {
  beginNoteEdit,
  endNoteEdit,
  noteBodyState,
  reportEditsFlushed,
  reportNoteEdits,
  saveNoteBody,
} from "@/lib/commands";
import { clearActionFailures, NOTE_EDIT_FAILED_TITLE, NOTE_SAVE_FAILED_TITLE, useActionFailures } from "@/lib/actionFailures";
import { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { taskInCloudLine, taskReadOnlyLine } from "@/components/reading/TaskCheckbox";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import type { IndexedBlock, NoteSaveError, SavedNoteBody, SaveNoteBodyParams } from "@/types";
import { NoteEditor } from "./NoteEditor";
import { NOTE_WOULD_BE_COLLECTION, noteEditErrorLine, noteSaveDisposition, noteSaveErrorLine } from "./noteEditMessages";

vi.mock("@/lib/commands", () => ({
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(),
  getBlock: vi.fn(async () => null),
  resolveNoteLink: vi.fn(async () => null),
  toggleTaskItem: vi.fn(),
}));

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidTheme: vi.fn(() => ({ dark: false, fontFamily: "system-ui", width: 680, variables: {} })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

const SLUG = "Cards/Note";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

function TestImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  return <img data-test-image="" src={src} alt={alt} />;
}

function card(body: string, hash: string): IndexedBlock {
  return indexedBlock({ slug: SLUG, body, body_hash: hash });
}

/** A save that answers when the test says. */
function pendingSaves() {
  const calls: Array<{ params: SaveNoteBodyParams; resolve(saved: SavedNoteBody): void; reject(error: NoteSaveError): void }> = [];
  vi.mocked(saveNoteBody).mockImplementation((params) => new Promise<SavedNoteBody>((resolve, reject) => {
    calls.push({ params, resolve, reject });
  }));
  let hashes = 0;
  return {
    calls,
    async answer(index = 0) {
      const call = calls.splice(index, 1)[0];
      if (!call) throw new Error("no save under way");
      hashes += 1;
      await act(async () => {
        call.resolve({ block: card(call.params.body, `hash-${hashes}`), split_changed: false, unchanged: false });
      });
    },
    async refuse(error: NoteSaveError) {
      const call = calls.shift();
      if (!call) throw new Error("no save under way");
      await act(async () => {
        call.reject(error);
      });
    },
  };
}

let failures: ReturnType<typeof useActionFailures> = [];
function FailureProbe() {
  failures = useActionFailures();
  return null;
}

function renderEditor(body = "# Title\n\nFirst paragraph.\n", onSaved = vi.fn()) {
  vi.mocked(beginNoteEdit).mockResolvedValue(card(body, "hash-0"));
  const result = render(
    <>
      <FailureProbe />
      <NoteEditor
        slug={SLUG}
        body={body}
        bodyHash="hash-0"
        fileName="Note.md"
        vaultPath="/vault"
        thumbsRootPath="/thumbs"
        noteEmbeds={new NoteEmbedLookups(SLUG)}
        image={TestImage}
        onOpenNote={vi.fn()}
        onSaved={onSaved}
        omittedEmbed={null}
        fallback={<p data-testid="reading">reading</p>}
      />
    </>,
  );
  return { ...result, onSaved };
}

async function editorView(): Promise<EditorView> {
  const content = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(".cm-content");
    if (!found) throw new Error("no editor yet");
    return found;
  });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("no view");
  return view;
}

function type(view: EditorView, at: number, text: string) {
  act(() => {
    view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });
  });
}

/** Where the editor's own listeners hear a backend event (the test setup
 *  bridges page events to window events). */
function emitPage(event: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
  });
}

beforeEach(() => {
  vi.mocked(saveNoteBody).mockReset();
  vi.mocked(beginNoteEdit).mockReset();
  vi.mocked(noteBodyState).mockReset();
  vi.mocked(reportNoteEdits).mockClear();
  vi.mocked(endNoteEdit).mockClear();
  vi.mocked(reportEditsFlushed).mockClear();
  clearActionFailures();
});

describe("NoteEditor (SPEC_EDITING.md, Л2.8, Л3)", () => {
  it("opens the session first and shows the reading article until it opens", async () => {
    let open: (block: IndexedBlock) => void = () => undefined;
    vi.mocked(beginNoteEdit).mockImplementation(() => new Promise((resolve) => { open = resolve; }));
    render(
      <NoteEditor
        slug={SLUG}
        body="text"
        bodyHash="hash-0"
        fileName="Note.md"
        vaultPath="/vault"
        thumbsRootPath="/thumbs"
        noteEmbeds={new NoteEmbedLookups(SLUG)}
        image={TestImage}
        onOpenNote={vi.fn()}
        onSaved={vi.fn()}
        omittedEmbed={null}
        fallback={<p data-testid="reading">reading</p>}
      />,
    );
    expect(beginNoteEdit).toHaveBeenCalledWith(SLUG);
    expect(screen.getByTestId("reading")).toBeInTheDocument();
    await act(async () => open(card("Text from disk", "hash-disk")));
    const view = await editorView();
    expect(view.state.doc.toString()).toBe("Text from disk");
    expect(screen.queryByTestId("reading")).toBeNull();
    expect(view.contentDOM).toHaveAttribute("aria-label", "Text of Note.md");
  });

  it("stays in the reading article and says why when the note cannot be edited (Л2.8)", async () => {
    vi.mocked(beginNoteEdit).mockRejectedValue({ kind: "in_cloud", file_name: "Note.md" });
    await act(async () => {
      render(
      <>
        <FailureProbe />
        <NoteEditor
          slug={SLUG}
          body="text"
          bodyHash="hash-0"
          fileName="Note.md"
          vaultPath="/vault"
          thumbsRootPath="/thumbs"
          noteEmbeds={new NoteEmbedLookups(SLUG)}
          image={TestImage}
          onOpenNote={vi.fn()}
          onSaved={vi.fn()}
          omittedEmbed={null}
          fallback={<p data-testid="reading">reading</p>}
        />
      </>,
      );
    });
    await waitFor(() => expect(failures).toEqual([{ kind: "note-edit", title: NOTE_EDIT_FAILED_TITLE, messages: [taskInCloudLine("Note.md")] }]));
    expect(screen.getByTestId("reading")).toBeInTheDocument();
    expect(document.querySelector(".cm-content")).toBeNull();
  });

  it("writes an edit at once with its base and the whole body (Л3.1, Л3.3)", async () => {
    const saves = pendingSaves();
    const { onSaved } = renderEditor("# Title\r\n\r\nBody\r\n");
    const view = await editorView();
    type(view, view.state.doc.length, "More");
    expect(saves.calls.map((call) => call.params)).toEqual([
      { source_slug: SLUG, base_body_hash: "hash-0", body: "# Title\r\n\r\nBody\r\nMore" },
    ]);
    expect(reportNoteEdits).toHaveBeenLastCalledWith(SLUG, true);
    await saves.answer();
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ body_hash: "hash-1" }));
    expect(reportNoteEdits).toHaveBeenLastCalledWith(SLUG, false);
  });

  it("gathers the edits made during a write into one next write with the new base", async () => {
    const saves = pendingSaves();
    renderEditor("Body");
    const view = await editorView();
    type(view, 4, "1");
    type(view, 5, "2");
    type(view, 6, "3");
    expect(saves.calls).toHaveLength(1);
    await saves.answer();
    expect(saves.calls.map((call) => call.params)).toEqual([{ source_slug: SLUG, base_body_hash: "hash-1", body: "Body123" }]);
  });

  it("says a failed write in the tab's notice and takes it away after the next success (Л3.8)", async () => {
    const saves = pendingSaves();
    renderEditor("Body");
    const view = await editorView();
    type(view, 4, "!");
    await saves.refuse({ kind: "read_only", file_name: "Note.md" });
    expect(failures).toEqual([{ kind: "note-save", title: NOTE_SAVE_FAILED_TITLE, messages: [taskReadOnlyLine("Note.md")] }]);
    expect(view.state.doc.toString()).toBe("Body!");
    type(view, 5, "?");
    expect(saves.calls.map((call) => call.params.body)).toEqual(["Body!?"]);
    await saves.answer();
    expect(failures).toEqual([]);
  });

  it("writes what is left and ends the session when it closes (Л3.2, Л3.9)", async () => {
    const saves = pendingSaves();
    const { unmount } = renderEditor("Body");
    const view = await editorView();
    type(view, 4, "!");
    await saves.answer();
    type(view, 5, "?");
    unmount();
    expect(saves.calls.map((call) => call.params.body)).toEqual(["Body!?"]);
    expect(endNoteEdit).not.toHaveBeenCalled();
    await saves.answer();
    await waitFor(() => expect(endNoteEdit).toHaveBeenCalledWith(SLUG));
  });

  it("answers the backend's flush after writing (Л3.9)", async () => {
    const saves = pendingSaves();
    renderEditor("Body");
    const view = await editorView();
    type(view, 4, "!");
    emitPage("flush-edits", { request_id: 7 });
    expect(reportEditsFlushed).not.toHaveBeenCalled();
    await saves.answer();
    await waitFor(() => expect(reportEditsFlushed).toHaveBeenCalledWith(7));
  });

  it("applies the file's new body by itself while nothing is unsaved (Л4.1, Л4.2)", async () => {
    pendingSaves();
    renderEditor("First line\nSecond line");
    const view = await editorView();
    vi.mocked(noteBodyState).mockResolvedValue({ body_hash: "hash-disk", body: "First line\nSecond line, changed" });
    emitPage("note-changed", { slug: SLUG, body_hash: "hash-disk" });
    await waitFor(() => expect(view.state.doc.toString()).toBe("First line\nSecond line, changed"));
    expect(saveNoteBody).not.toHaveBeenCalled();
  });

  it("writes nothing over a file that changed while edits are unsaved (Л4.3)", async () => {
    const saves = pendingSaves();
    renderEditor("Body");
    const view = await editorView();
    type(view, 4, "!");
    vi.mocked(noteBodyState).mockResolvedValue({ body_hash: "hash-disk", body: "Body from Obsidian" });
    emitPage("note-changed", { slug: SLUG, body_hash: "hash-disk" });
    await waitFor(() => expect(noteBodyState).toHaveBeenCalled());
    await saves.refuse({ kind: "stale_body", source_slug: SLUG, disk_body: "Body from Obsidian", disk_body_hash: "hash-disk" });
    type(view, 5, "?");
    expect(saves.calls).toHaveLength(0);
    expect(view.state.doc.toString()).toBe("Body!?");
  });
});

describe("NoteEditor's accessibility (SPEC_EDITING.md, Л16)", () => {
  function editorWith(fileName: string) {
    return (
      <NoteEditor
        slug={SLUG}
        body="- [ ] Задача из списка\n\nАбзац."
        bodyHash="hash-0"
        fileName={fileName}
        vaultPath="/vault"
        thumbsRootPath="/thumbs"
        noteEmbeds={new NoteEmbedLookups(SLUG)}
        image={TestImage}
        onOpenNote={vi.fn()}
        onSaved={vi.fn()}
        omittedEmbed={null}
        fallback={<p data-testid="reading">reading</p>}
      />
    );
  }

  it("is a multiline text box labelled by the note's file, and the label follows a rename", async () => {
    vi.mocked(beginNoteEdit).mockResolvedValue(card("- [ ] Задача из списка\n\nАбзац.", "hash-0"));
    const { rerender } = render(editorWith("Note.md"));
    const view = await editorView();
    expect(view.contentDOM).toHaveAttribute("role", "textbox");
    expect(view.contentDOM).toHaveAttribute("aria-multiline", "true");
    expect(screen.getByRole("textbox", { name: "Text of Note.md" })).toBe(view.contentDOM);
    rerender(editorWith("Renamed note.md"));
    await waitFor(() => expect(view.contentDOM).toHaveAttribute("aria-label", "Text of Renamed note.md"));
  });

  it("labels a task's box by the task's text (Ч12.7)", async () => {
    vi.mocked(beginNoteEdit).mockResolvedValue(card("- [ ] Задача из списка\n\nАбзац.", "hash-0"));
    render(editorWith("Note.md"));
    await editorView();
    const box = await screen.findByRole("checkbox");
    const label = document.getElementById(box.getAttribute("aria-labelledby") ?? "");
    expect(label?.textContent?.trim()).toBe("Задача из списка");
  });

  it("gives Tab to the text, and after an Escape with nothing to close lets Tab move the focus (CodeMirror's rule)", async () => {
    vi.mocked(beginNoteEdit).mockResolvedValue(card("- [ ] Задача из списка\n\nАбзац.", "hash-0"));
    pendingSaves();
    render(editorWith("Note.md"));
    const view = await editorView();
    const paragraph = view.state.doc.length;
    act(() => {
      view.dispatch({ selection: { anchor: paragraph }, userEvent: "select" });
      view.focus();
    });
    const press = (key: string, keyCode: number) => {
      const event = new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true });
      act(() => {
        view.contentDOM.dispatchEvent(event);
      });
      return event;
    };
    const tab = press("Tab", 9);
    expect(tab.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("- [ ] Задача из списка\n\nАбзац.\t");
    press("Escape", 27);
    const leaving = press("Tab", 9);
    expect(leaving.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("- [ ] Задача из списка\n\nАбзац.\t");
  });
});

describe("what a failure means and says (Л2.8, Л3.8, Л4.3, Л4.9)", () => {
  it("stops at a conflict and a note that is gone, and tries passing failures again", () => {
    expect(noteSaveDisposition({ kind: "stale_body", source_slug: SLUG, disk_body: "", disk_body_hash: "h" })).toBe("conflict");
    expect(noteSaveDisposition({ kind: "changed", source_slug: SLUG })).toBe("conflict");
    expect(noteSaveDisposition({ kind: "source_not_found", source_slug: SLUG })).toBe("stop");
    expect(noteSaveDisposition({ kind: "not_a_card", source_slug: SLUG })).toBe("stop");
    expect(noteSaveDisposition({ kind: "in_cloud", file_name: "Note.md" })).toBe("retry");
    expect(noteSaveDisposition({ kind: "read_only", file_name: "Note.md" })).toBe("retry");
    expect(noteSaveDisposition({ kind: "no_vault" })).toBe("retry");
    expect(noteSaveDisposition({ kind: "internal", message: "x" })).toBe("retry");
  });

  it("says the lines of the task box's notices, and nothing for a collection page", () => {
    expect(noteEditErrorLine({ kind: "not_a_card", source_slug: SLUG })).toBeNull();
    expect(noteEditErrorLine({ kind: "read_only", file_name: "Note.md" })).toBe(taskReadOnlyLine("Note.md"));
    expect(noteSaveErrorLine({ kind: "in_cloud", file_name: "Note.md" })).toBe(taskInCloudLine("Note.md"));
    expect(noteSaveErrorLine({ kind: "not_a_card", source_slug: SLUG })).toBe(NOTE_WOULD_BE_COLLECTION);
  });
});
