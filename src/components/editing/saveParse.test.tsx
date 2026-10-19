import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { EditorView } from "@codemirror/view";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Detail } from "@/components/Detail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { deriveCardContent } from "@/lib/cardLayout";
import { beginNoteEdit, noteBodyState, saveNoteBody } from "@/lib/commands";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import type { IndexedBlock, SaveNoteBodyParams } from "@/types";
import { NoteEditingSwitch } from "./noteEditingSwitch";

// SPEC_EDITING.md, Л14: while the editor holds the note, a keystroke's write
// parses no whole body anywhere on its way through the open card, and no
// derivation of the card's content goes through it: the reading mode's
// derivations keep the card they read, the editor's pictures count their
// place only when an action asks.

vi.mock("@/lib/cardLayout", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cardLayout")>();
  return { ...original, deriveCardContent: vi.fn(original.deriveCardContent) };
});

vi.mock("@/lib/reading/syntax", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/reading/syntax")>();
  return { ...original, parseReadingSyntax: vi.fn(original.parseReadingSyntax) };
});

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

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
  saveNoteBody: vi.fn(),
  suggestNoteLinks: vi.fn(async () => []),
  copyMediaAssetToClipboard: vi.fn(),
  prepareDeleteMediaAsset: vi.fn(),
  icloudDownloadProgress: vi.fn(async () => ({ status: "unknown", percent: null })),
  youtubePlayerUrl: vi.fn(),
  startSourceVideoDownload: vi.fn(async () => null),
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

const SLUG = "Cards/Long";

/** A note whose whole parse would be noticed: a long table, a picture, a
 *  video of the body, text around them. */
const BODY = [
  "Абзац перед таблицей.",
  ["| a | b |", "|---|---|", ...Array.from({ length: 200 }, (_, row) => `| ${row} | ячейка ${row} |`)].join("\n"),
  "![[photo.png]]",
  "![[clip.mp4]]",
  "Абзац после таблицы.",
].join("\n\n");

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

let disk = { body: BODY, hash: "hash-0" };

function cardOf(body: string, hash: string): IndexedBlock {
  return indexedBlock({ slug: SLUG, body, body_hash: hash, display_title: "Long" });
}

beforeEach(() => {
  disk = { body: BODY, hash: "hash-0" };
  vi.mocked(beginNoteEdit).mockImplementation(async () => cardOf(disk.body, disk.hash));
  vi.mocked(noteBodyState).mockImplementation(async () => ({ body: disk.body, body_hash: disk.hash }));
  let writes = 0;
  vi.mocked(saveNoteBody).mockImplementation(async (params: SaveNoteBodyParams) => {
    writes += 1;
    disk = { body: params.body, hash: `hash-${writes}` };
    return { block: cardOf(params.body, disk.hash), split_changed: false, unchanged: false };
  });
});

/** The parses of a whole body (or most of it) since the spies were cleared. */
function wholeBodyParses(): number {
  const inputs = [
    ...vi.mocked(parseReadingSyntax).mock.calls.map(([text]) => text),
    ...vi.mocked(fromMarkdown).mock.calls.map(([text]) => (typeof text === "string" ? text : "")),
  ];
  return inputs.filter((text) => text.length >= BODY.length / 2).length;
}

/** The derivations of the card's content (its preview text, its media) from
 *  a whole body since the spies were cleared. */
function wholeBodyDerivations(): number {
  return vi.mocked(deriveCardContent).mock.calls.filter(([card]) => card.body.length >= BODY.length / 2).length;
}

describe("a keystroke's write while editing (SPEC_EDITING.md, Л14)", () => {
  it("parses no whole body in the open card and derives nothing from one", async () => {
    const { container } = render(
      <TooltipProvider>
        <DndContext>
          <NoteEditingSwitch.Provider value>
            <Detail
              block={cardOf(BODY, "hash-0")}
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
          </NoteEditingSwitch.Provider>
        </DndContext>
      </TooltipProvider>,
    );
    const view = await waitFor(() => {
      const content = container.querySelector<HTMLElement>(".cm-content");
      const found = content ? EditorView.findFromDOM(content) : null;
      if (!found) throw new Error("no editor yet");
      return found;
    });
    // The reading mode read the body when the card opened.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(wholeBodyParses()).toBeGreaterThan(0);

    for (let key = 0; key < 3; key += 1) {
      vi.mocked(parseReadingSyntax).mockClear();
      vi.mocked(fromMarkdown).mockClear();
      vi.mocked(deriveCardContent).mockClear();
      const at = view.state.doc.line(1).to;
      act(() => view.dispatch({ changes: { from: at, insert: "x" }, userEvent: "input.type" }));
      await waitFor(() => expect(disk.body.split("\n")[0]).toBe(`Абзац перед таблицей.${"x".repeat(key + 1)}`));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(wholeBodyParses()).toBe(0);
      expect(wholeBodyDerivations()).toBe(0);
    }
  });
});
