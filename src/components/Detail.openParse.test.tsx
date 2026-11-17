import { act, render } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Detail, preloadNoteEditor } from "@/components/Detail";
import { NoteEditingSwitch } from "@/components/editing/noteEditingSwitch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beginNoteEdit, noteBodyState } from "@/lib/commands";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import type { IndexedBlock } from "@/types";

// SPEC_READING_MODE.md, Ч0.5: a card on its way to the page parses its body
// once, whole: the wikilink pre-processing, the open card's reading of its
// videos and the article all read that one parse, in the reading surface
// and in the editor alike.

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
  copyMediaAssetToClipboard: vi.fn(),
  prepareDeleteMediaAsset: vi.fn(),
  icloudDownloadProgress: vi.fn(async () => ({ status: "unknown", percent: null })),
  youtubePlayerUrl: vi.fn(),
  startSourceVideoDownload: vi.fn(async () => null),
  cancelSourceVideoDownload: vi.fn(async () => null),
  sourceVideoDownloadStatus: vi.fn(async () => null),
  listCardAssociations: vi.fn(async (slug: string) => ({ generation: 1, slug, groups: [] })),
}));

/** An article as the clipper saves it: text, and every picture a wikilink
 *  embed on a line of its own. */
function articleBody(title: string, embed: (index: number) => string): string {
  const paragraph = `Paragraph of ${title} with **bold** text and a [link](https://example.com). `.repeat(6);
  return Array.from({ length: 12 }, (_, index) => `${paragraph}\n\n${embed(index + 1)}`).join("\n\n");
}

beforeAll(async () => {
  installCodeMirrorLayoutStubs();
  // The editor's part of the bundle is loaded before a card opens, as the
  // card's window loads it (SPEC_CARD_PEEK.md, О12): the editor then comes
  // when its session opens, not after the module's import, whose time
  // depends on how busy the machine is.
  await preloadNoteEditor();
});

function cardOf(slug: string, body: string): IndexedBlock {
  return indexedBlock({ slug, body, body_hash: "hash-0", display_title: slug });
}

/** The parses of a whole body (or most of it) since the watches were cleared:
 *  the texts given to the reading parser and to the plain one. */
function wholeBodyParses(body: string): string[] {
  return [
    ...vi.mocked(parseReadingSyntax).mock.calls.map(([text]) => text),
    ...vi.mocked(fromMarkdown).mock.calls.map(([text]) => (typeof text === "string" ? text : "")),
  ].filter((text) => text.length >= body.length / 2);
}

function openCard(card: IndexedBlock, editing: boolean) {
  return render(
    <TooltipProvider>
      <DndContext>
        <NoteEditingSwitch.Provider value={editing}>
          <Detail
            block={card}
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
}

/** Lets the card's reads and effects land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  vi.mocked(parseReadingSyntax).mockClear();
  vi.mocked(fromMarkdown).mockClear();
});

describe("the parses of a body on opening its card (SPEC_READING_MODE.md, Ч0.5)", () => {
  it("parses a body with wikilinks once in the reading surface: the body as written", async () => {
    const body = articleBody("reading", (index) => `![[reading (image ${index}).jpg]]`);
    const { container } = openCard(cardOf("Cards/Reading", body), false);
    await settle();
    expect(container.querySelectorAll("[data-article-body] img").length).toBeGreaterThan(0);
    expect(wholeBodyParses(body)).toEqual([body]);
  });

  it("parses a body without wikilinks once in the reading surface", async () => {
    const body = articleBody("plain", (index) => `![](plain-image-${index}.jpg)`);
    openCard(cardOf("Cards/Plain", body), false);
    await settle();
    expect(wholeBodyParses(body)).toEqual([body]);
  });

  it("parses the body once for the card that opens in the editor", async () => {
    const body = articleBody("editing", (index) => `![[editing (image ${index}).jpg]]`);
    const card = cardOf("Cards/Editing", body);
    vi.mocked(beginNoteEdit).mockImplementation(async () => card);
    vi.mocked(noteBodyState).mockImplementation(async () => ({ body, body_hash: "hash-0" }));
    const { container } = openCard(card, true);
    // The session opens on the backend's answer: the editor stands once
    // those promises have settled.
    await act(async () => {});
    if (!container.querySelector(".cm-content")) throw new Error("no editor once the session opened");
    await settle();
    expect(wholeBodyParses(body)).toEqual([body]);
  });
});
