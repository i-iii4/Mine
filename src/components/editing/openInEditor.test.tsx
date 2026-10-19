import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { Detail } from "@/components/Detail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TASK_NOTE_GONE, taskInCloudLine, taskReadOnlyLine } from "@/components/reading/TaskCheckbox";
import { beginNoteEdit, getBlock, noteBodyState } from "@/lib/commands";
import { clearActionFailures, NOTE_EDIT_FAILED_TITLE, useActionFailures } from "@/lib/actionFailures";
import { indexedBlock, lightBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import type { IndexedBlock, LightBlock, NoteEditError } from "@/types";

// SPEC_EDITING.md, Л1, Л2 (row 50.12, the user's decision of 18.10.2026 on
// ЛВ1): the open card opens straight in the editor, with nothing turned on
// by the page; a body that cannot be edited stays in the reading mode, with
// the reason the backend gives in the tab's notice.

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidTheme: vi.fn(() => ({ dark: false, fontFamily: "system-ui", width: 680, variables: {} })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => null),
  resolveNoteLink: vi.fn(async () => null),
  toggleTaskItem: vi.fn(),
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  reportFocusedEditor: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(),
  suggestNoteLinks: vi.fn(async () => []),
  icloudDownloadProgress: vi.fn(async () => ({ status: "unknown", percent: null })),
  youtubePlayerUrl: vi.fn(),
  startSourceVideoDownload: vi.fn(async () => null),
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

const SLUG = "Cards/Note";
const BODY = "# Note\n\nThe text of the note.";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

let failures: ReturnType<typeof useActionFailures> = [];
function FailureProbe() {
  failures = useActionFailures();
  return null;
}

function whole(overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  return indexedBlock({ slug: SLUG, body: BODY, body_hash: "hash-0", display_title: "Note", ...overrides });
}

function openCard(block: LightBlock | IndexedBlock) {
  return render(
    <TooltipProvider>
      <DndContext>
        <FailureProbe />
        <Detail
          block={block}
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
          onOpenRelatedNote={vi.fn()}
        />
      </DndContext>
    </TooltipProvider>,
  );
}

/** The editor's text box once it stands in the open card. */
async function editorIn(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const content = container.querySelector<HTMLElement>(".mine-note-editor .cm-content");
    if (!content) throw new Error("no editor yet");
    return content;
  }, { timeout: 5000 });
}

/** Let the lazy part of the editor and the backend's answers come. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.mocked(beginNoteEdit).mockReset();
  vi.mocked(beginNoteEdit).mockImplementation(async (slug) => whole({ slug }));
  vi.mocked(noteBodyState).mockReset();
  vi.mocked(noteBodyState).mockResolvedValue({ body: BODY, body_hash: "hash-0" });
  vi.mocked(getBlock).mockReset();
  vi.mocked(getBlock).mockResolvedValue(null);
  clearActionFailures();
});

describe("which card opens in the editor (Л1, Л2)", () => {
  it("opens a card with its whole body straight in the editor, nothing turned on (Л1, Л2.1)", async () => {
    const { container } = openCard(whole());
    const content = await editorIn(container);
    expect(beginNoteEdit).toHaveBeenCalledWith(SLUG);
    expect(content).toHaveAttribute("aria-label", "Text of Note.md");
    expect(container.querySelector("[data-article-body]")).toBeNull();
    // No button and no key turn it into a reading view (ЛВ1).
    expect(container.querySelector("button[aria-label='Edit'], button[aria-label='Done']")).toBeNull();
  });

  it("opens a media card's body under its media in the editor (Л2.7)", async () => {
    const body = "Text under the video.";
    const media = whole({ card_kind: "media", block_type: "video", media_file: "Media/clip.mp4", body, preview_text: body });
    vi.mocked(beginNoteEdit).mockResolvedValue(media);
    const { container } = openCard(media);
    const content = await editorIn(container);
    expect(beginNoteEdit).toHaveBeenCalledWith(SLUG);
    expect(content.textContent).toContain(body);
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("keeps the feed's start of the body in the reading mode, and opens the editor once the whole card comes (Л2.1)", async () => {
    let read: (block: IndexedBlock) => void = () => undefined;
    vi.mocked(getBlock).mockImplementation(() => new Promise((resolve) => { read = resolve; }));
    const light = lightBlock({ slug: SLUG, body: BODY, display_title: "Note" });
    const { container } = openCard(light);
    await settle();
    expect(container.querySelector("[data-article-body]")).not.toBeNull();
    expect(beginNoteEdit).not.toHaveBeenCalled();
    await act(async () => read(whole()));
    await editorIn(container);
    expect(beginNoteEdit).toHaveBeenCalledWith(SLUG);
  });

  it("never opens a collection page in the editor and never asks the backend (Л2.5)", async () => {
    const { container } = openCard(whole({ card_kind: "channel", block_type: "channel" }));
    await settle();
    expect(container.querySelector("[data-article-body]")).not.toBeNull();
    expect(container.querySelector(".mine-note-editor")).toBeNull();
    expect(beginNoteEdit).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
  });

  it("asks nothing for a link card, whose page has no body to edit", async () => {
    const { container } = openCard(whole({ card_kind: "link", block_type: "link", url: "https://example.com", body: "" }));
    await settle();
    expect(container.querySelector(".mine-note-editor")).toBeNull();
    expect(beginNoteEdit).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, NoteEditError, string | null]> = [
    ["in iCloud and not downloaded", { kind: "in_cloud", file_name: "Note.md" }, taskInCloudLine("Note.md")],
    ["read-only", { kind: "read_only", file_name: "Note.md" }, taskReadOnlyLine("Note.md")],
    ["no longer on disk", { kind: "source_not_found", source_slug: SLUG }, TASK_NOTE_GONE],
    ["a collection page after all", { kind: "not_a_card", source_slug: SLUG }, null],
  ];
  for (const [what, refusal, line] of refusals) {
    it(`shows a note ${what} in the reading mode, ${line ? "saying why" : "with nothing to say"} (Л2.8)`, async () => {
      vi.mocked(beginNoteEdit).mockRejectedValue(refusal);
      const { container } = openCard(whole());
      await waitFor(() => expect(beginNoteEdit).toHaveBeenCalledWith(SLUG), { timeout: 5000 });
      await settle();
      expect(container.querySelector("[data-article-body]")).not.toBeNull();
      expect(container.querySelector(".mine-note-editor")).toBeNull();
      expect(failures).toEqual(line ? [{ kind: "note-edit", title: NOTE_EDIT_FAILED_TITLE, messages: [line] }] : []);
    });
  }
});
