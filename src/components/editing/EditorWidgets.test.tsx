import { act, render, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useContext, type ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { EditorView } from "@codemirror/view";
import { beginNoteEdit, saveNoteBody } from "@/lib/commands";
import { ArticleMarkdown } from "@/components/reading/ArticleMarkdown";
import { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import type { TaskBoxes } from "@/components/reading/TaskCheckbox";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { EditorImagePlacementContext } from "./editorImagePlacement";
import { WidgetPortals } from "./EditorWidgets";
import { NoteEditor } from "./NoteEditor";

vi.mock("@/lib/commands", () => ({
  beginNoteEdit: vi.fn(),
  endNoteEdit: vi.fn(async () => undefined),
  noteBodyState: vi.fn(),
  reportEditsFlushed: vi.fn(async () => undefined),
  reportNoteEdits: vi.fn(async () => undefined),
  reportFocusedEditor: vi.fn(async () => undefined),
  saveNoteBody: vi.fn(() => new Promise(() => undefined)),
  getBlock: vi.fn(async () => null),
  resolveNoteLink: vi.fn(async () => null),
  toggleTaskItem: vi.fn(),
}));

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidTheme: vi.fn(() => ({ dark: false, fontFamily: "system-ui", width: 680, variables: {} })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

const SLUG = "Cards/Blocks";

/** The reading mode's boxes of a whole card: pressable, as the editor's. */
const PRESSABLE_BOXES: TaskBoxes = {
  active: true,
  visible: (_itemStart, inBody) => inBody,
  subscribe: () => () => undefined,
  toggle: () => undefined,
};

beforeAll(() => {
  installCodeMirrorLayoutStubs();
});

beforeEach(() => {
  vi.mocked(saveNoteBody).mockClear();
});

function TestImage({ src, alt, node }: ComponentProps<"img"> & ExtraProps) {
  const placement = useContext(EditorImagePlacementContext);
  return (
    <img
      data-test-image=""
      data-offset={node?.position?.start.offset}
      data-occurrence={placement?.occurrenceIndex() ?? undefined}
      src={src}
      alt={alt}
    />
  );
}

/** The blocks of the reading mode's fixture, one of each kind. */
const BLOCKS = {
  callout: "> [!todo] Todo\n> - [ ] Задача в выноске\n> - [x] Выполненная задача в выноске",
  table: "| Слева | По центру | Справа |\n|:---|:---:|---:|\n| текст | текст | 1 234 |",
  code: "```typescript\ninterface Card {\n  slug: string;\n}\n```",
  math: "$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$",
  html: "<details>\n<summary>Раскрывающийся блок HTML</summary>\n\nСкрытое содержимое с **разметкой**.\n\n</details>",
  mermaid: "```mermaid\nflowchart LR\n  A --> B\n```",
  media: "![[photo.png]]",
};

/** A body of `kinds`, between two paragraphs. jsdom lays nothing out, so
 *  CodeMirror draws only the first screen it estimates: a short body. */
function bodyOf(kinds: Array<keyof typeof BLOCKS>): string {
  return ["Intro.", ...kinds.map((kind) => BLOCKS[kind]), "End."].join("\n\n");
}

/** An element's markup without what depends on where its source starts or
 *  on React's ids. */
function normalized(element: Element | null): string {
  if (!element) return "";
  const copy = element.cloneNode(true) as Element;
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    // The table editor tells its rows and cells apart (Л9): the editor's
    // own marks, not the reading mode's look.
    for (const name of ["data-mine-md-start", "data-mine-md-end", "data-task-item-start", "id", "aria-labelledby", "data-offset", "data-occurrence", "data-table-row", "data-table-col", "data-table-line-row"]) {
      node.removeAttribute(name);
    }
  }
  return copy.outerHTML;
}

const SELECTORS: Record<keyof typeof BLOCKS, string> = {
  callout: "[data-callout]",
  table: "[data-article-table-scroll]",
  code: "[data-code-block]",
  math: "[data-math-display], [data-math-source]",
  html: "[data-html-details]",
  mermaid: "[data-mermaid]",
  media: "[data-test-image]",
};

async function renderBoth(kinds: Array<keyof typeof BLOCKS>) {
  const BODY = bodyOf(kinds);
  vi.mocked(beginNoteEdit).mockResolvedValue(indexedBlock({ slug: SLUG, body: BODY, body_hash: "hash-0" }));
  const lookups = new NoteEmbedLookups(SLUG);
  const reading = render(
    <ArticleMarkdown
      body={BODY}
      sourceSlug={SLUG}
      vaultPath="/vault"
      thumbsRootPath="/thumbs"
      noteEmbeds={lookups}
      tasks={PRESSABLE_BOXES}
      image={TestImage}
      onOpenNote={vi.fn()}
    />,
  );
  const editing = render(
    <NoteEditor
      slug={SLUG}
      body={BODY}
      bodyHash="hash-0"
      fileName="Blocks.md"
      vaultPath="/vault"
      thumbsRootPath="/thumbs"
      noteEmbeds={lookups}
      image={TestImage}
      onOpenNote={vi.fn()}
      onSaved={vi.fn()}
      omittedEmbed={null}
      fallback={null}
    />,
  );
  await waitFor(() => expect(editing.container.querySelectorAll("[data-editor-block] .mine-article").length).toBe(kinds.length));
  return { reading: reading.container, editing: editing.container };
}

describe("block widgets (SPEC_EDITING.md, Л8)", () => {
  it.each(Object.keys(BLOCKS) as Array<keyof typeof BLOCKS>)("draws the %s as the reading mode does", async (kind) => {
    const { reading, editing } = await renderBoth([kind]);
    const widget = editing.querySelector(`[data-editor-block="${kind}"]`);
    expect(widget).not.toBeNull();
    // Highlighting and KaTeX come on demand in both surfaces: the two are
    // compared once both have drawn.
    await waitFor(() => {
      const own = widget?.querySelector(SELECTORS[kind]) ?? null;
      expect(own).not.toBeNull();
      expect(normalized(own)).toBe(normalized(reading.querySelector(SELECTORS[kind])));
    }, { timeout: 4000 });
  });

  it("tells the host's picture its place among the body's pictures, counted from the document when asked (Л11.3, Л14)", async () => {
    const { editing } = await renderBoth(["media", "code", "media"]);
    const pictures = [...editing.querySelectorAll("[data-editor-block='media'] [data-test-image]")];
    expect(pictures.map((picture) => picture.getAttribute("data-occurrence"))).toEqual(["0", "1"]);
    // Not a parse of the body: the reading mode's offset is not asked.
    expect(pictures.every((picture) => picture.getAttribute("data-offset") === "0")).toBe(true);
  });

  it("changes a task inside a callout as an edit of the document (Л7.4)", async () => {
    const { editing } = await renderBoth(["callout"]);
    const box = editing.querySelector<HTMLButtonElement>("[data-editor-block='callout'] [data-task-checkbox]");
    expect(box).not.toBeNull();
    expect(box).not.toBeDisabled();
    const content = editing.querySelector<HTMLElement>(".cm-content");
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!box || !view) throw new Error("a box and a view");
    await act(async () => box.click());
    expect(view.state.doc.toString()).toContain("> - [x] Задача в выноске");
    expect(saveNoteBody).toHaveBeenCalledTimes(1);
  });

  it("shows a code block's source at a click on it (Л5.3)", async () => {
    const { editing } = await renderBoth(["code"]);
    const code = editing.querySelector<HTMLElement>("[data-editor-block='code'] pre");
    const content = editing.querySelector<HTMLElement>(".cm-content");
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!code || !view) throw new Error("code and a view");
    await act(async () => code.click());
    expect(editing.querySelector("[data-editor-block='code']")).toBeNull();
    expect(editing.querySelector(".cm-md-source")).not.toBeNull();
  });

  it("keeps one portal per container and lets an unmounted one go", () => {
    const portals = new WidgetPortals();
    const first = document.createElement("div");
    const second = document.createElement("span");
    portals.mount(first, { type: "math", source: "x" });
    portals.mount(second, { type: "task", checked: false, labelledBy: "label" });
    portals.update(first, { type: "math", source: "y" });
    expect(portals.current().map(([dom, entry]) => [dom.tagName, entry.widget])).toEqual([
      ["DIV", { type: "math", source: "y" }],
      ["SPAN", { type: "task", checked: false, labelledBy: "label" }],
    ]);
    portals.unmount(first);
    expect(portals.current().map(([dom]) => dom)).toEqual([second]);
  });
});
