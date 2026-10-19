import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext, type DragStartEvent } from "@dnd-kit/core";
import { EditorView } from "@codemirror/view";
import { Detail } from "@/components/Detail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beginNoteEdit, getBlock, noteBodyState, resolveNoteLink, saveNoteBody } from "@/lib/commands";
import { computeBodyHash } from "@/lib/editing/bodyHash";
import { HOVER_PREVIEW_COLD_OPEN_DELAY_MS } from "@/lib/hoverPreviewTiming";
import { getActiveMineTextSelectionDragPayload } from "@/lib/textSelectionDrag";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import type { IndexedBlock, SaveNoteBodyParams } from "@/types";
import { NoteEditingSwitch } from "./noteEditingSwitch";

// The open card with the editor mounted (SPEC_EDITING.md, Л11, row 50.23):
// what the reading mode offers around the note goes on working while the
// note is edited: text selection extraction, the media of the body with
// their actions, drag and ⤢, the right panel and its previews, the jump to
// a block, and the column the article stands in.

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
  copyMediaAssetToClipboard: vi.fn(),
  prepareDeleteMediaAsset: vi.fn(async () => ({ media_ref: "photo.png", media_kind: "image", canvases: [], referenced_by: [] })),
  icloudDownloadProgress: vi.fn(async () => ({ status: "unknown", percent: null })),
  youtubePlayerUrl: vi.fn(),
  startSourceVideoDownload: vi.fn(async () => null),
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

const SLUG = "Cards/Open";
const RELATED = "Cards/Related";

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

/** The file of the open note: writes land in it, the card read after a
 *  write carries the related notes its links give. */
let disk = { body: "", hash: "hash-0" };

function cardOf(body: string, hash: string, related: string[] = []): IndexedBlock {
  return indexedBlock({ slug: SLUG, body, body_hash: hash, display_title: "Open", related_notes: related });
}

beforeEach(() => {
  vi.mocked(beginNoteEdit).mockImplementation(async () => cardOf(disk.body, disk.hash));
  vi.mocked(noteBodyState).mockImplementation(async () => ({ body: disk.body, body_hash: disk.hash }));
  let writes = 0;
  vi.mocked(saveNoteBody).mockImplementation(async (params: SaveNoteBodyParams) => {
    writes += 1;
    disk = { body: params.body, hash: `hash-${writes}` };
    return { block: cardOf(params.body, disk.hash, params.body.includes("[[Related]]") ? [RELATED] : []), split_changed: false, unchanged: false };
  });
  vi.mocked(getBlock).mockImplementation(async (slug) => (slug === RELATED
    ? indexedBlock({ slug: RELATED, display_title: "Related", body: "Body of the related note", preview_text: "Body of the related note", body_hash: "hash-r" })
    : null));
  vi.mocked(resolveNoteLink).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderOpenCard(body: string, extra: Partial<Parameters<typeof Detail>[0]> = {}, editing = true) {
  disk = { body, hash: "hash-0" };
  const onDragStart = vi.fn((_event: DragStartEvent) => undefined);
  const onOpenImagePreview = vi.fn();
  const onTextSelectionDrop = vi.fn();
  const result = render(
    <TooltipProvider>
      <DndContext onDragStart={onDragStart}>
        <NoteEditingSwitch.Provider value={editing}>
          <Detail
            block={cardOf(body, "hash-0")}
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
            onOpenImagePreview={onOpenImagePreview}
            onTextSelectionDrop={onTextSelectionDrop}
            onTextSelectionDelete={vi.fn()}
            {...extra}
          />
        </NoteEditingSwitch.Provider>
      </DndContext>
    </TooltipProvider>,
  );
  return { ...result, onDragStart, onOpenImagePreview, onTextSelectionDrop };
}

async function editorOf(container: HTMLElement): Promise<EditorView> {
  return waitFor(() => {
    const content = container.querySelector<HTMLElement>(".cm-content");
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error("no editor yet");
    return view;
  });
}

describe("the open card with the editor mounted (SPEC_EDITING.md, Л11)", () => {
  it("offers the selection's action bar without Delete Text, with the exact range of the body (Л11.2)", async () => {
    const body = "Alpha **beta** gamma\r\n\r\nSecond line.";
    const { container } = renderOpenCard(body);
    const view = await editorOf(container);
    const from = view.state.doc.toString().indexOf("**beta**");
    act(() => view.dispatch({ selection: { anchor: from, head: from + "**beta**".length }, userEvent: "select" }));
    const grip = await screen.findByRole("button", { name: "Drag selected text to a collection" });
    const bar = grip.closest<HTMLElement>("[data-text-selection-action-bar]");
    if (!bar) throw new Error("no action bar");
    expect(within(bar).getByRole("button", { name: "Create Element" })).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Delete Text" })).toBeNull();
    fireEvent.pointerDown(grip, { button: 0 });
    const start = new TextEncoder().encode(body.slice(0, body.indexOf("**beta**"))).length;
    expect(getActiveMineTextSelectionDragPayload()).toEqual({
      type: "text_selection",
      sourceSlug: SLUG,
      selectedText: "**beta**",
      firstBlockStart: start,
      firstBlockEnd: start + "**beta**".length,
      sourceBodyHash: computeBodyHash(body),
      sourceRange: { start, end: start + "**beta**".length },
    });
    fireEvent.pointerUp(window);
    // An edit after the selection names the body as it is now.
    act(() => view.dispatch({ changes: { from: 0, insert: "¡" }, selection: { anchor: from + 1, head: from + 1 + 8 }, userEvent: "input.type" }));
    await waitFor(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Drag selected text to a collection" }), { button: 0 });
      expect(getActiveMineTextSelectionDragPayload()?.sourceBodyHash).toBe(computeBodyHash(`¡${body}`));
    });
    fireEvent.pointerUp(window);
    // Collapsing the selection takes the bar away.
    act(() => view.dispatch({ selection: { anchor: 0 }, userEvent: "select" }));
    await waitFor(() => expect(document.querySelector("[data-text-selection-action-bar]")).toBeNull());
  });

  it("keeps the body's picture with ⤢, its menus and its drag (Л11.3)", async () => {
    const { container, onOpenImagePreview, onDragStart } = renderOpenCard("Text.\n\n![[photo.png]]\n\nEnd.");
    await editorOf(container);
    const frame = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-editor-block='media'] [data-detail-media-action-frame]");
      if (!found) throw new Error("no picture yet");
      return found;
    });
    // ⤢ opens the viewer.
    fireEvent.click(within(frame).getByRole("button", { name: "Expand image" }));
    expect(onOpenImagePreview).toHaveBeenCalledWith(expect.objectContaining({ mediaRef: "photo.png" }));
    // The ellipsis and a right click open the media's menu.
    expect(frame.querySelector("[data-detail-media-more-button]")).not.toBeNull();
    const image = must(frame.querySelector("img"), "image");
    fireEvent.contextMenu(image, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Create Element")).toBeInTheDocument();
    expect(within(menu).getByText("Rename Media...")).toBeInTheDocument();
    expect(within(menu).getByText("Delete Media")).toBeInTheDocument();
    fireEvent.click(within(menu).getByText("Delete Media"));
    expect(await screen.findByRole("alertdialog", { name: "Delete media file?" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    // The picture drags onto a collection as when reading (SPEC_INLINE_MEDIA_EXTRACTION.md).
    expect(frame).toHaveAttribute("data-detail-inline-media-drag", "true");
    fireEvent.pointerDown(frame, { button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { button: 0, isPrimary: true, clientX: 40, clientY: 10 });
    await waitFor(() => expect(onDragStart).toHaveBeenCalled());
    const started = onDragStart.mock.calls[0]?.[0];
    expect(started?.active.data.current).toEqual(expect.objectContaining({ type: "media_asset" }));
    fireEvent.pointerUp(document, { button: 0, isPrimary: true });
  });

  it("removes the chosen one of two pictures of the same file, counted from the document when asked (Л11.3, Л14)", async () => {
    const onRemoveMediaAssetFromCard = vi.fn(async () => undefined);
    const { container } = renderOpenCard("![[photo.png]]\n\nMiddle.\n\n![[photo.png]]", { onRemoveMediaAssetFromCard });
    const view = await editorOf(container);
    // Text typed before the pictures after they were drawn: the count is
    // taken when Remove asks, from the document as it is then.
    act(() => view.dispatch({ changes: { from: 0, insert: "![[other.png]] " }, userEvent: "input.type" }));
    const triggers = await waitFor(() => {
      const found = [...container.querySelectorAll<HTMLElement>("[data-editor-block='media'] [data-detail-media-more-button]")];
      if (found.length < 1) throw new Error("no pictures yet");
      return found;
    });
    const last = must(triggers.at(-1), "the last picture's menu");
    fireEvent.pointerDown(last, { button: 0, ctrlKey: false });
    fireEvent.click(last);
    fireEvent.click(within(await screen.findByRole("menu")).getByText("Remove from Element"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from Element" }));
    await waitFor(() => expect(onRemoveMediaAssetFromCard).toHaveBeenCalledWith(expect.objectContaining({ media_ref: "photo.png", occurrence_index: 2 })));
  });

  it("brings a link written in the text to the panel after the write, its preview on hover (Л11.6)", async () => {
    const { container } = renderOpenCard("Start.");
    const view = await editorOf(container);
    expect(screen.queryByText("Related notes")).toBeNull();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " [[Related]]" }, userEvent: "input.type" }));
    // The row: the note's name and the start of its text.
    const row = await screen.findByRole("button", { name: /^Related/ });
    expect(screen.getByText("Related notes")).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.mouseEnter(row);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("[data-related-note-hover-preview]")).not.toBeNull();
    fireEvent.mouseLeave(row);
    vi.useRealTimers();
  });

  it("scrolls to the block its link names (Л11.8)", async () => {
    const body = `${Array.from({ length: 40 }, (_, index) => `Line ${index}.`).join("\n\n")}\n\nThe place. ^here\n\nAfter.`;
    const scrolled = vi.spyOn(EditorView, "scrollIntoView");
    const { container } = renderOpenCard(body, { scrollAnchor: "^here" });
    const view = await editorOf(container);
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith(view.state.doc.toString().indexOf("The place."), { y: "center" }));
    scrolled.mockRestore();
  });

  it("stands in the column the article stands in (Р1 to Р4, Л11.7)", async () => {
    const reading = renderOpenCard("Text.", {}, false);
    const article = must(reading.container.querySelector("[data-article-body]"), "article");
    const readingChain = classChain(article.parentElement);
    reading.unmount();
    const editing = renderOpenCard("Text.");
    await editorOf(editing.container);
    const editor = must(editing.container.querySelector("[data-note-editor]"), "editor");
    expect(classChain(editor.parentElement)).toEqual(readingChain);
  });
});

function must<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) throw new Error(`no ${what}`);
  return element;
}

/** The classes of an element and of every element above it. */
function classChain(element: Element | null): string[] {
  const chain: string[] = [];
  for (let node = element; node; node = node.parentElement) chain.push(node.className);
  return chain;
}
