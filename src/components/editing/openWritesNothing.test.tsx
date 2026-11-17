import { act, fireEvent, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { EditorView } from "@codemirror/view";
import { Detail, preloadNoteEditor } from "@/components/Detail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beginNoteEdit, endNoteEdit, noteBodyState, reportEditsFlushed, reportNoteEdits, saveNoteBody } from "@/lib/commands";
import { bodyOfState } from "@/lib/editing/lineEndings";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { LIST_OF_IMAGES_BODY, MEDIA_SHAPES_BODY } from "@/test/editingFixture";
import type { IndexedBlock } from "@/types";

// SPEC_EDITING.md, Л3 («при открытии ничего не записано»), Л17: the body of
// a card the clipper saved (a list of 20 pictures, tables with empty cells,
// items with tabbed lines, HTML, no line break at the end), opened in the
// open card as the app opens it, and everything a person does without
// typing: the focus, a scroll, the focus leaving, the window going and
// coming back, another tab, the backend's flush, closing the card. Nothing
// is written, and the session never says it holds unsaved edits.

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidLayout: vi.fn(() => ({ fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 })),
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

const SLUG = "Cards/Parachute Wide Track Pants";
const HASH = "hash-disk";

beforeAll(async () => {
  installCodeMirrorLayoutStubs();
  // The editor's part of the bundle is loaded before a card opens, as the
  // card's window loads it (SPEC_CARD_PEEK.md, О12): the editor then comes
  // when its session opens, not after the module's import, whose time
  // depends on how busy the machine is.
  await preloadNoteEditor();
});

function whole(body: string): IndexedBlock {
  return indexedBlock({ slug: SLUG, body, body_hash: HASH, display_title: "-", url: "https://example.com/product" });
}

function openCard(block: IndexedBlock) {
  return render(
    <TooltipProvider>
      <DndContext>
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

/** Let the lazy part of the editor and the backend's answers come. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A backend event to the page (the test setup bridges page events to
 *  window events). */
function emitPage(event: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(event, { detail: { event, payload } }));
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.mocked(saveNoteBody).mockReset();
  vi.mocked(beginNoteEdit).mockReset();
  vi.mocked(noteBodyState).mockReset();
  vi.mocked(reportNoteEdits).mockClear();
  vi.mocked(reportEditsFlushed).mockClear();
  vi.mocked(endNoteEdit).mockClear();
});

describe("opening a card writes nothing (SPEC_EDITING.md, Л3, Л17)", () => {
  for (const [name, body] of [["the clipper's list of pictures", LIST_OF_IMAGES_BODY], ["pictures in lists, paragraphs and quotes", MEDIA_SHAPES_BODY]] as const) {
    it(`opens ${name} in the editor, its text the file's byte for byte, and nothing it does without typing writes`, async () => {
      vi.mocked(beginNoteEdit).mockResolvedValue(whole(body));
      vi.mocked(noteBodyState).mockResolvedValue({ body, body_hash: HASH });
      const { container, unmount } = openCard(whole(body));
      // The session opens on the backend's answer: the editor stands once
      // those promises have settled.
      await settle();
      const content = container.querySelector<HTMLElement>(".mine-note-editor .cm-content");
      if (!content) throw new Error("no editor once the session opened");
      const view = EditorView.findFromDOM(content);
      if (!view) throw new Error("no view");
      expect(bodyOfState(view.state, false)).toBe(body);

      // The focus, a scroll, the focus leaving.
      act(() => {
        content.focus();
        view.dispatch({ selection: { anchor: view.state.doc.line(1).to }, userEvent: "select" });
      });
      const scroller = container.querySelector<HTMLElement>("[data-detail-scroll]");
      if (scroller) fireEvent.scroll(scroller, { target: { scrollTop: 2000 } });
      act(() => {
        content.blur();
      });
      // The window goes and comes back; another tab; the backend's flush.
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      setVisibility("hidden");
      emitPage("flush-edits", { request_id: 7 });
      setVisibility("visible");
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await settle();
      expect(reportEditsFlushed).toHaveBeenCalledWith(7);
      expect(noteBodyState).toHaveBeenCalledWith(SLUG);

      // Closing the card ends the session after its flush.
      unmount();
      await settle();
      expect(endNoteEdit).toHaveBeenCalledWith(SLUG);
      expect(saveNoteBody).not.toHaveBeenCalled();
      expect(vi.mocked(reportNoteEdits).mock.calls.filter(([, unsaved]) => unsaved)).toEqual([]);
    });
  }
});
