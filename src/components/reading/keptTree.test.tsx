import { readFileSync } from "node:fs";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { preprocessWikilinks } from "@/lib/markdownWikilinks";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { readingTree } from "@/lib/reading/tree";
import { ArticleMarkdown } from "./ArticleMarkdown";
import { NoteEmbedLookups } from "./NoteEmbed";

// SPEC_READING_MODE.md, Ч0.5: the article draws the kept tree of its body.
// Drawing it again parses nothing, and no drawing changes the tree, which
// the open card reads too.

vi.mock("@/lib/reading/syntax", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/reading/syntax")>();
  return { ...original, parseReadingSyntax: vi.fn(original.parseReadingSyntax) };
});

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(async () => null),
  resolveNoteLink: vi.fn(async () => null),
  toggleTaskItem: vi.fn(),
}));

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidLayout: vi.fn(() => ({ fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

const SOURCE = "Cards/Source";
const noop = () => undefined;

function TestImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  return <img data-test-image="" src={src} alt={alt} />;
}

function article(body: string, lookups: NoteEmbedLookups, title: string) {
  return (
    <ArticleMarkdown
      body={body}
      sourceSlug={SOURCE}
      vaultPath="/vault"
      thumbsRootPath="/thumbs"
      noteEmbeds={lookups}
      tasks={null}
      image={TestImage}
      onOpenNote={noop}
      title={title}
    />
  );
}

/** Freezes `value` and all it holds: a write to any of it throws. */
function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const held of Object.values(value)) freezeDeep(held);
}

const fixture = readFileSync("scripts/fixtures/reading-mode.md", "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");

beforeEach(() => {
  vi.mocked(parseReadingSyntax).mockClear();
});

describe("the article's kept tree", () => {
  it("is parsed once for an article drawn again and again", () => {
    const body = "# Title\n\nText with [[a link]] and ![[picture.png]].\n\n> [!note] A callout\n> with a body\n";
    const lookups = new NoteEmbedLookups(SOURCE);
    const view = render(article(body, lookups, "first"));
    const parses = vi.mocked(parseReadingSyntax).mock.calls.length;
    expect(parses).toBeGreaterThan(0);
    const drawn = view.container.innerHTML;
    view.rerender(article(body, lookups, "second"));
    view.rerender(article(body, lookups, "first"));
    expect(vi.mocked(parseReadingSyntax).mock.calls.length).toBe(parses);
    expect(view.container.innerHTML).toBe(drawn);
  });

  it("is not changed by drawing the fixture of the reading mode", async () => {
    const tree = readingTree(preprocessWikilinks(fixture));
    freezeDeep(tree);
    const lookups = new NoteEmbedLookups(SOURCE);
    const view = render(article(fixture, lookups, "frozen"));
    // The embeds' notes are looked up; none is found.
    await act(async () => {
      await lookups.settled();
    });
    const drawn = view.container.innerHTML;
    expect(view.container.querySelector("[data-callout]")).not.toBeNull();
    view.rerender(article(fixture, lookups, "again"));
    view.rerender(article(fixture, lookups, "frozen"));
    expect(view.container.innerHTML).toBe(drawn);
  });
});
