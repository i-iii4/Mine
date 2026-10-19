import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { beginNoteEdit, endNoteEdit, noteBodyState, reportNoteEdits, saveNoteBody } from "@/lib/commands";
import { clearActionFailures, NOTE_SAVE_FAILED_TITLE, useActionFailures } from "@/lib/actionFailures";
import { followNoteRename, isNoteHeldForEditing, noteMissingFromIndex } from "@/lib/noteEditSessions";
import { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { TASK_NOTE_GONE, taskInCloudLine } from "@/components/reading/TaskCheckbox";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import type { IndexedBlock, NoteBodyState, NoteEditError, NoteSaveError, SavedNoteBody, SaveNoteBodyParams } from "@/types";
import { NoteEditor } from "./NoteEditor";

// SPEC_EDITING.md, Л4 (row 50.16): the file's own changes, conflicts, two
// tabs, a rename and a deletion during a session, iCloud and read-only.

vi.mock("@/lib/commands", () => ({
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(),
  suggestNoteLinks: vi.fn(async () => []),
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
  return <img src={src} alt={alt} />;
}

function card(slug: string, body: string, hash: string): IndexedBlock {
  return indexedBlock({ slug, body, body_hash: hash });
}

let failures: ReturnType<typeof useActionFailures> = [];
function FailureProbe() {
  failures = useActionFailures();
  return null;
}

/**
 * A made-up file and the backend over it: a write is checked against its
 * base, the file can change from outside, and the sessions hear
 * `note-changed` as the backend sends it to the tabs that did not write.
 */
function fakeDisk(initial: string) {
  let body = initial;
  let hashes = 0;
  let hash = "hash-0";
  let gone = false;
  const writes: SaveNoteBodyParams[] = [];
  const hold: Array<() => void> = [];
  let holding = false;
  let answersLate = false;
  const answer = (params: SaveNoteBodyParams): SavedNoteBody => {
    if (gone) throw { kind: "source_not_found", source_slug: params.source_slug } satisfies NoteSaveError;
    if (params.base_body_hash !== hash) {
      throw { kind: "stale_body", source_slug: params.source_slug, disk_body: body, disk_body_hash: hash } satisfies NoteSaveError;
    }
    const unchanged = params.body === body;
    if (!unchanged) {
      hashes += 1;
      hash = `hash-${hashes}`;
      body = params.body;
    }
    return { block: card(params.source_slug, body, hash), split_changed: false, unchanged };
  };
  vi.mocked(saveNoteBody).mockImplementation((params) => {
    writes.push(params);
    if (answersLate) {
      // The file takes the bytes now; the answer reaches the tab later.
      let outcome: { ok: SavedNoteBody } | { error: unknown };
      try {
        outcome = { ok: answer(params) };
      } catch (error) {
        outcome = { error };
      }
      return new Promise<SavedNoteBody>((resolve, reject) => {
        hold.push(() => ("ok" in outcome ? resolve(outcome.ok) : reject(outcome.error)));
      });
    }
    if (!holding) {
      try {
        return Promise.resolve(answer(params));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise<SavedNoteBody>((resolve, reject) => {
      hold.push(() => {
        try {
          resolve(answer(params));
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  vi.mocked(noteBodyState).mockImplementation(async (): Promise<NoteBodyState> => {
    if (gone) throw { kind: "source_not_found", source_slug: SLUG } satisfies NoteEditError;
    return { body_hash: hash, body };
  });
  vi.mocked(beginNoteEdit).mockImplementation(async (slug) => card(slug, body, hash));
  return {
    writes,
    get body() {
      return body;
    },
    get hash() {
      return hash;
    },
    /** Writes wait until `release`. */
    holdWrites() {
      holding = true;
    },
    /** Writes land in the file at once, their answers wait until `release`. */
    holdAnswers() {
      answersLate = true;
    },
    async release() {
      holding = false;
      answersLate = false;
      const waiting = hold.splice(0);
      await act(async () => {
        for (const run of waiting) run();
      });
    },
    /** Obsidian, an agent or another tab writes the file. */
    writeFromOutside(next: string, slug = SLUG) {
      hashes += 1;
      hash = `hash-${hashes}`;
      body = next;
      emitPage("note-changed", { slug, body_hash: hash });
    },
    delete() {
      gone = true;
    },
    restore() {
      gone = false;
    },
  };
}

function emitPage(event: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
  });
}

function editorProps(slug: string, body: string, bodyHash: string) {
  return {
    slug,
    body,
    bodyHash,
    fileName: "Note.md",
    vaultPath: "/vault",
    thumbsRootPath: "/thumbs",
    noteEmbeds: new NoteEmbedLookups(slug),
    image: TestImage,
    onOpenNote: vi.fn(),
    onSaved: vi.fn(),
    omittedEmbed: null,
    fallback: <p data-testid="reading">reading</p>,
  };
}

async function editorViews(count = 1): Promise<EditorView[]> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>(".cm-content")];
    if (found.length < count) throw new Error("no editor yet");
    return found.map((content) => {
      const view = EditorView.findFromDOM(content);
      if (!view) throw new Error("no view");
      return view;
    });
  });
}

async function editorView(): Promise<EditorView> {
  const [view] = await editorViews(1);
  if (!view) throw new Error("no view");
  return view;
}

function type(view: EditorView, at: number, text: string) {
  act(() => {
    view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });
  });
}

async function settle() {
  await act(async () => {
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.mocked(saveNoteBody).mockReset();
  vi.mocked(beginNoteEdit).mockReset();
  vi.mocked(noteBodyState).mockReset();
  vi.mocked(reportNoteEdits).mockClear();
  vi.mocked(endNoteEdit).mockClear();
  clearActionFailures();
});

describe("the file's own changes (SPEC_EDITING.md, Л4.1, Л4.2)", () => {
  it("applies an outside change as the least changes, out of the history, the caret carried through", async () => {
    const disk = fakeDisk("First line\nSecond line\nThird line");
    render(<NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />);
    const view = await editorView();
    const caret = view.state.doc.length;
    act(() => view.dispatch({ selection: { anchor: caret }, userEvent: "select" }));
    type(view, 0, "My ");
    await waitFor(() => expect(disk.body).toBe("My First line\nSecond line\nThird line"));
    disk.writeFromOutside("My First line\nSecond line, changed\nThird line");
    await waitFor(() => expect(view.state.doc.toString()).toBe("My First line\nSecond line, changed\nThird line"));
    // Only the change of the second line moved what stands after it: the
    // caret at the end stays at the end, shifted by the inserted words.
    expect(view.state.selection.main.head).toBe(caret + "My ".length + ", changed".length);
    expect(disk.writes).toHaveLength(1);
    // ⌘Z takes back the session's own edit, not the file's.
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("First line\nSecond line, changed\nThird line");
  });

  it("weighs no answer about the file that a write of its own may predate", async () => {
    const disk = fakeDisk("Body");
    render(<NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />);
    const view = await editorView();
    disk.holdAnswers();
    type(view, 4, "!");
    type(view, 5, "?");
    // The window comes back while the write is under way: the file already
    // holds the write's bytes, the base is still the old one, and the
    // document holds more. Weighed now, that would read as a conflict.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(disk.body).toBe("Body!");
    await disk.release();
    await waitFor(() => expect(disk.body).toBe("Body!?"));
    type(view, 6, ".");
    await waitFor(() => expect(disk.body).toBe("Body!?."));
    expect(view.state.doc.toString()).toBe("Body!?.");
  });

  it("does not take back its text for an older card of the open card", async () => {
    const disk = fakeDisk("Body");
    const props = editorProps(SLUG, disk.body, disk.hash);
    const { rerender } = render(<NoteEditor {...props} />);
    const view = await editorView();
    type(view, 4, "!");
    await waitFor(() => expect(disk.body).toBe("Body!"));
    rerender(<NoteEditor {...props} body="Body" bodyHash="hash-old" />);
    await settle();
    expect(view.state.doc.toString()).toBe("Body!");
    expect(disk.writes).toHaveLength(1);
  });
});

describe("a conflict (Л4.3)", () => {
  it("keeps both sides when the file changes while edits are unsaved, and ends when the file holds the editor's text", async () => {
    const disk = fakeDisk("Body");
    render(<NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />);
    const view = await editorView();
    disk.holdWrites();
    type(view, 4, " mine");
    disk.writeFromOutside("Body theirs");
    await disk.release();
    await settle();
    type(view, 9, "!");
    await settle();
    expect(view.state.doc.toString()).toBe("Body mine!");
    expect(disk.body).toBe("Body theirs");
    expect(disk.writes).toHaveLength(1);
    // The other side wrote exactly the editor's text: nothing is lost, the
    // session goes on from it.
    disk.writeFromOutside("Body mine!");
    await settle();
    type(view, 10, "?");
    await waitFor(() => expect(disk.body).toBe("Body mine!?"));
  });
});

describe("two tabs of the same note (Л4.4)", () => {
  it("brings one tab's write into the other while it has nothing unsaved, and is a conflict when it has", async () => {
    const disk = fakeDisk("Shared");
    render(
      <>
        <NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />
        <NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />
      </>,
    );
    const [first, second] = await editorViews(2);
    if (!first || !second) throw new Error("two editors expected");
    type(first, 6, " one");
    await waitFor(() => expect(disk.body).toBe("Shared one"));
    // The backend tells the other tab, not the writing one.
    emitPage("note-changed", { slug: SLUG, body_hash: disk.hash });
    await waitFor(() => expect(second.state.doc.toString()).toBe("Shared one"));

    disk.holdWrites();
    type(second, 10, " two");
    await disk.release();
    await settle();
    expect(disk.body).toBe("Shared one two");
    // Now the first tab holds an edit the file has not when the second's
    // write arrives.
    disk.holdWrites();
    type(first, 0, ">");
    emitPage("note-changed", { slug: SLUG, body_hash: disk.hash });
    await disk.release();
    await settle();
    expect(first.state.doc.toString()).toBe(">Shared one");
    expect(disk.body).toBe("Shared one two");
  });
});

describe("a rename during the session (Л4.8)", () => {
  it("goes on under the new name: the same view, its history, its writes and its news", async () => {
    const disk = fakeDisk("Body");
    const props = editorProps(SLUG, disk.body, disk.hash);
    const { rerender } = render(<NoteEditor {...props} />);
    const view = await editorView();
    type(view, 4, "!");
    await waitFor(() => expect(disk.body).toBe("Body!"));
    expect(isNoteHeldForEditing(SLUG)).toBe(true);
    act(() => followNoteRename(SLUG, "Cards/Renamed"));
    await settle();
    expect(noteBodyState).toHaveBeenLastCalledWith("Cards/Renamed");
    // The open card still shows the old name for a moment, then the new one.
    rerender(<NoteEditor {...props} />);
    rerender(<NoteEditor {...props} slug="Cards/Renamed" />);
    await settle();
    expect(await editorView()).toBe(view);
    expect(beginNoteEdit).toHaveBeenCalledTimes(1);
    type(view, 5, "?");
    await waitFor(() => expect(disk.writes.at(-1)?.source_slug).toBe("Cards/Renamed"));
    expect(reportNoteEdits).toHaveBeenLastCalledWith("Cards/Renamed", false);
    // The rename rewrote a link of the note itself: it comes in by itself.
    disk.writeFromOutside("Body!? [[Renamed]]", "Cards/Renamed");
    await waitFor(() => expect(view.state.doc.toString()).toBe("Body!? [[Renamed]]"));
    // The history went on through the rename: ⌘Z takes back the session's
    // own typing (one step, typed in a row), not the file's change.
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Body [[Renamed]]");
  });

  it("is another session when the card goes to another note", async () => {
    const disk = fakeDisk("Body");
    const props = editorProps(SLUG, disk.body, disk.hash);
    const { rerender } = render(<NoteEditor {...props} />);
    const view = await editorView();
    rerender(<NoteEditor {...props} slug="Cards/Other" />);
    const next = await waitFor(async () => {
      const found = await editorView();
      if (found === view) throw new Error("still the first session");
      return found;
    });
    expect(next).not.toBe(view);
    expect(beginNoteEdit).toHaveBeenLastCalledWith("Cards/Other");
    await waitFor(() => expect(endNoteEdit).toHaveBeenCalledWith(SLUG));
    // Back to the first note: a session of its own, opened anew.
    rerender(<NoteEditor {...props} />);
    const again = await waitFor(async () => {
      const found = await editorView();
      if (found === next) throw new Error("still the second session");
      return found;
    });
    expect(again).not.toBe(view);
    expect(beginNoteEdit).toHaveBeenCalledTimes(3);
    expect(beginNoteEdit).toHaveBeenLastCalledWith(SLUG);
  });
});

describe("a note gone during the session (Л4.9)", () => {
  it("holds the text, writes nothing, says so, and goes on when the note is back", async () => {
    const disk = fakeDisk("Body");
    render(
      <>
        <FailureProbe />
        <NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />
      </>,
    );
    const view = await editorView();
    disk.delete();
    act(() => noteMissingFromIndex(SLUG));
    await waitFor(() => expect(failures).toEqual([{ kind: "note-save", title: NOTE_SAVE_FAILED_TITLE, messages: [TASK_NOTE_GONE] }]));
    type(view, 4, " kept");
    await settle();
    expect(disk.writes).toHaveLength(0);
    expect(view.state.doc.toString()).toBe("Body kept");
    expect(isNoteHeldForEditing(SLUG)).toBe(true);
    // The note comes back as the session knew it (Trash, iCloud): the edit
    // made meanwhile is written.
    disk.restore();
    emitPage("note-changed", { slug: SLUG, body_hash: disk.hash });
    await waitFor(() => expect(disk.body).toBe("Body kept"));
    expect(failures).toEqual([]);
  });

  it("learns it from a refused write as well", async () => {
    const disk = fakeDisk("Body");
    render(
      <>
        <FailureProbe />
        <NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />
      </>,
    );
    const view = await editorView();
    disk.delete();
    type(view, 4, "!");
    await waitFor(() => expect(failures[0]?.messages).toEqual([TASK_NOTE_GONE]));
    type(view, 5, "?");
    await settle();
    expect(disk.writes).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("Body!?");
  });
});

describe("iCloud and read-only during the session (Л4.5, Л4.6)", () => {
  it("keeps the text when the contents went to iCloud, says so and writes once they are back", async () => {
    const disk = fakeDisk("Body");
    render(
      <>
        <FailureProbe />
        <NoteEditor {...editorProps(SLUG, disk.body, disk.hash)} />
      </>,
    );
    const view = await editorView();
    const save = vi.mocked(saveNoteBody).getMockImplementation();
    vi.mocked(saveNoteBody).mockImplementationOnce(async () => {
      throw { kind: "in_cloud", file_name: "Note.md" } satisfies NoteSaveError;
    });
    type(view, 4, "!");
    await waitFor(() => expect(failures).toEqual([{ kind: "note-save", title: NOTE_SAVE_FAILED_TITLE, messages: [taskInCloudLine("Note.md")] }]));
    expect(view.state.doc.toString()).toBe("Body!");
    if (save) vi.mocked(saveNoteBody).mockImplementation(save);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(disk.body).toBe("Body!"));
    expect(failures).toEqual([]);
  });
});
