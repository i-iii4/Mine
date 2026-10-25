import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { ArticleMarkdown } from "./ArticleMarkdown";
import { NoteEmbedLookups } from "./NoteEmbed";
import { markdownSourceByteOffset, preprocessWikilinks } from "@/lib/markdownWikilinks";
import { getBlock, resolveNoteLink } from "@/lib/commands";
import { findArticleAnchor, parseArticleAnchor } from "@/lib/reading/anchors";

vi.mock("@/lib/commands", () => ({
  getBlock: vi.fn(),
  resolveNoteLink: vi.fn(),
  toggleTaskItem: vi.fn(),
}));

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidLayout: vi.fn(() => ({ fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 })),
  renderMermaid: vi.fn(() => new Promise(() => undefined)),
}));

const SOURCE = "Cards/Source";

/** The host's picture: a plain image, stable across renders. */
function TestImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  return <img data-test-image="" src={src} alt={alt} />;
}

function renderArticle(body: string, onOpenNote = vi.fn()) {
  const view = render(
    <ArticleMarkdown
      body={body}
      sourceSlug={SOURCE}
      vaultPath="/vault"
      thumbsRootPath="/thumbs"
      noteEmbeds={new NoteEmbedLookups(SOURCE)}
      tasks={null}
      image={TestImage}
      onOpenNote={onOpenNote}
      data-article-body=""
    />,
  );
  const root = view.container.querySelector<HTMLElement>("[data-article-body]")!;
  return { ...view, root, onOpenNote };
}

/** What the element's `data-mine-md-*` range holds of the rendered body. */
function blockSource(body: string, element: Element | null): string {
  const start = Number(element?.getAttribute("data-mine-md-start"));
  const end = Number(element?.getAttribute("data-mine-md-end"));
  return preprocessWikilinks(body).slice(start, end);
}

beforeEach(() => {
  vi.mocked(getBlock).mockReset();
  vi.mocked(resolveNoteLink).mockReset();
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
});

// SPEC_READING_MODE.md, Ч0.3: the places of blocks survive the new plugins.
describe("ArticleMarkdown positions", () => {
  const body = "First paragraph\n\n- item one\n- item two\n\n> A quote\n\n> [!note] Title\n> Callout body\n>\n> - callout item";

  it("keeps the place of a paragraph, a list item and a quote", () => {
    const { root } = renderArticle(body);
    expect(blockSource(body, root.querySelector("p"))).toBe("First paragraph");
    expect([...root.querySelectorAll("li")].slice(0, 2).map((item) => blockSource(body, item))).toEqual(["- item one", "- item two"]);
    expect(blockSource(body, root.querySelector("blockquote"))).toBe("> A quote");
  });

  it("keeps the place of a callout's paragraph and list item", () => {
    const { root } = renderArticle(body);
    const callout = root.querySelector("[data-callout]")!;
    expect(blockSource(body, callout.querySelector("[data-callout-body] p"))).toBe("Callout body");
    expect(blockSource(body, callout.querySelector("[data-callout-body] li"))).toBe("- callout item");
  });

  it("names the same source bytes for a selection in a callout as in a paragraph", () => {
    const callout = "Lead\n\n> [!note] Title\n> Alpha beta";
    const plain = "Lead\n\nAlpha beta";
    const byteRange = (source: string, element: Element | null) => [
      markdownSourceByteOffset(source, Number(element?.getAttribute("data-mine-md-start"))),
      markdownSourceByteOffset(source, Number(element?.getAttribute("data-mine-md-end"))),
    ];
    const inCallout = byteRange(callout, renderArticle(callout).root.querySelector("[data-callout-body] p"));
    const inParagraph = byteRange(plain, renderArticle(plain).root.querySelectorAll("p")[1] ?? null);
    const bytes = (source: string, [start, end]: (number | null)[]) => Buffer.from(source).subarray(start ?? 0, end ?? 0).toString();
    expect(bytes(callout, inCallout)).toBe("Alpha beta");
    expect(bytes(plain, inParagraph)).toBe("Alpha beta");
  });
});

describe("ArticleMarkdown elements", () => {
  it("draws code in a line as code, without backtick text", () => {
    const { root } = renderArticle("Use `npm test` here");
    expect(root.querySelector("p > code")?.textContent).toBe("npm test");
    expect(root.textContent).not.toContain("`");
  });

  it("draws the note's sanitized HTML", () => {
    const { root } = renderArticle("Press <kbd>⌘</kbd>, H<sub>2</sub>O, <mark>m</mark>\n\n<script>window.bad = 1</script>\n\n<img src=\"x.png\" onerror=\"window.bad = 2\">");
    expect(root.querySelector("kbd")?.textContent).toBe("⌘");
    expect(root.querySelector("sub")?.textContent).toBe("2");
    expect(root.querySelector("mark")?.textContent).toBe("m");
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("[onerror]")).toBeNull();
  });

  it("draws a checkbox from HTML inert", () => {
    const { root } = renderArticle("<input type=\"checkbox\" checked> from HTML");
    const box = root.querySelector("[data-html-checkbox]");
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("data-state", "checked");
    expect(root.querySelector("[data-task-checkbox]")).toBeNull();
  });

  it("opens an external link in the browser and drops a script address", () => {
    const { root } = renderArticle("[out](https://example.com) and [bad](javascript:alert(1))");
    const [out, bad] = root.querySelectorAll("a");
    expect(out).toHaveAttribute("target", "_blank");
    expect(out).toHaveAttribute("rel", "noopener noreferrer");
    expect(bad?.getAttribute("href") ?? "").toBe("");
  });

  it("opens a wikilink's note", async () => {
    vi.mocked(resolveNoteLink).mockResolvedValue("Notes/Peer");
    const { onOpenNote } = renderArticle("See [[Peer|my peer]]");
    fireEvent.click(screen.getByRole("link", { name: "my peer" }));
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith("Notes/Peer"));
    expect(resolveNoteLink).toHaveBeenCalledWith(SOURCE, "Peer");
  });

  it("draws code blocks, diagrams, formulas, tables and callouts by their own elements", () => {
    const { root } = renderArticle("```ts\nconst a = 1\n```\n\n```mermaid\ngraph A\n```\n\n$$\nx^2\n$$\n\n| A |\n|---|\n| 1 |\n\n> [!tip]- Folded\n> Body");
    expect(root.querySelector("[data-code-block][data-code-language='ts']")).not.toBeNull();
    expect(root.querySelector("[data-mermaid]")).not.toBeNull();
    expect(root.querySelector("[data-article-table-scroll] table")).not.toBeNull();
    expect(root.querySelector("details[data-callout='tip']")).toHaveProperty("open", false);
    expect(root.textContent).toContain("x^2");
  });
});

// SPEC_READING_MODE.md, Ч10.
describe("ArticleMarkdown footnotes", () => {
  const body = "Claim.[^1]\n\n[^1]: The note.";

  it("gives ids one user-content- prefix", () => {
    const { root } = renderArticle(body);
    expect(root.querySelector("#user-content-fn-1")).not.toBeNull();
    expect(root.querySelector("#user-content-fnref-1")).not.toBeNull();
    expect(root.querySelector("[id^='user-content-user-content']")).toBeNull();
  });

  it("jumps to the footnote and back inside the article, the address kept", () => {
    const { root } = renderArticle(body);
    const address = window.location.href;
    const reference = root.querySelector<HTMLAnchorElement>("[data-footnote-ref]")!;
    expect(reference).not.toHaveAttribute("target");
    fireEvent.click(reference);
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(root.querySelector("#user-content-fn-1"));
    fireEvent.click(root.querySelector<HTMLAnchorElement>("[data-footnote-backref]")!);
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(root.querySelector("#user-content-fnref-1"));
    expect(window.location.href).toBe(address);
  });

  it("does nothing for a place the article does not hold", () => {
    const { root } = renderArticle("[nowhere](#missing)");
    fireEvent.click(root.querySelector("a")!);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

// SPEC_READING_MODE.md, Ч4: `<details>` opens by a click and by keys.
describe("ArticleMarkdown details", () => {
  const body = "<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>";

  it("opens and closes by a click on its summary", () => {
    const { root } = renderArticle(body);
    const details = root.querySelector("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText("More"), { detail: 1 });
    expect(details.open).toBe(true);
    fireEvent.click(screen.getByText("More"), { detail: 1 });
    expect(details.open).toBe(false);
  });

  it("opens by Enter and Space, and a click the key makes does not undo it", () => {
    const { root } = renderArticle(body);
    const details = root.querySelector("details")!;
    const summary = root.querySelector("summary")!;
    expect(summary).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(summary, { key: "Enter" });
    fireEvent.click(summary, { detail: 0 });
    expect(details.open).toBe(true);
    fireEvent.keyDown(summary, { key: " " });
    expect(details.open).toBe(false);
    expect(root.querySelector("strong")?.textContent).toBe("text");
  });
});

// SPEC_READING_MODE.md, Ч11.8: the place an embed's or a related note's
// `#…` names, found in the drawn article as Obsidian finds it.
describe("ArticleMarkdown anchors", () => {
  function find(body: string, subpath: string) {
    const { root } = renderArticle(body);
    const anchor = parseArticleAnchor(subpath);
    if (!anchor) throw new Error(`no anchor in ${subpath}`);
    return findArticleAnchor(root, body, anchor);
  }

  it("finds a heading after wikilinks, by Obsidian's matching", () => {
    const body = "See [[Peer]] and [[Other|o]].\n\n## Plan: A/B [[Peer|p]]\n\nText\n\n### Steps\n\n## Steps";
    expect(find(body, "plan a b peer p")?.textContent).toBe("Plan: A/B p");
    const steps = find(body, "Plan A B Peer p#Steps");
    expect(steps?.tagName).toBe("H3");
    expect(find(body, "Steps")?.tagName).toBe("H3");
  });

  it("does not find a heading inside a callout, nor one the note has not", () => {
    const body = "> [!note] Callout\n> ## Hidden\n\n## Shown";
    expect(find(body, "Hidden")).toBeNull();
    expect(find(body, "Missing")).toBeNull();
    expect(find(body, "Shown")?.tagName).toBe("H2");
  });

  it("finds the block whose ^id ends it, in any letter case", () => {
    const body = "First ^other\n\nThe paragraph ^c0ffee\n\n- an item ^Item-1\n- next";
    expect(find(body, "^c0ffee")?.textContent).toBe("The paragraph ^c0ffee");
    expect(find(body, "^C0FFEE")?.tagName).toBe("P");
    expect(find(body, "^item-1")?.tagName).toBe("LI");
  });

  it("takes the block before a lone ^id, as Obsidian names a list, a quote or a table", () => {
    const body = "- one\n- two\n\n^list-id\n\n> quoted\n\n^quote-id";
    expect(find(body, "^list-id")?.tagName).toBe("UL");
    expect(find(body, "^quote-id")?.tagName).toBe("BLOCKQUOTE");
  });

  it("does not take a longer id, an id mid-line, or one in code", () => {
    const body = "Ends ^c0ffee-2\n\nMid ^c0ffee then text\n\n`^c0ffee`\n\n```\nline ^c0ffee\n```";
    expect(find(body, "^c0ffee")).toBeNull();
  });
});

// SPEC_READING_MODE.md, Ч15: a picture that is its list item's whole content
// stands as a picture of its own paragraph does.
describe("ArticleMarkdown pictures in lists and paragraphs", () => {
  /** What each list item starts with: the one box of its media and the
   *  pictures of its stack, or its own content. */
  const items = (root: HTMLElement) => [...root.querySelectorAll("li")].map((item) => {
    const stack = item.querySelector(":scope > [data-list-item-media] > [data-article-media-stack]:first-child");
    return stack && item.children.length === 1 ? `stack:${stack.querySelectorAll("img").length}` : item.firstElementChild?.tagName.toLowerCase() ?? "text";
  });

  it("draws an item of a tight list that is one picture as a stack of media, its marker kept", () => {
    const { root } = renderArticle("- ![[a.png]]\n- ![[b.png]] ![[c.png]]\n- text ![[d.png]]\n- [ ] ![[e.png]]");
    expect(items(root).slice(0, 2)).toEqual(["stack:1", "stack:2"]);
    // An item with words keeps its picture among them, a task its box.
    const [, , mixed, task] = root.querySelectorAll("li");
    expect(mixed?.querySelector("[data-article-media-stack]")).toBeNull();
    expect(task?.querySelector("[data-article-media-stack]")).toBeNull();
    expect(task).toHaveAttribute("data-task-item");
    // The item keeps its place in the source (Ч0.3).
    expect(root.querySelector("li")).toHaveAttribute("data-mine-md-start");
  });

  it("keeps a nested list under the stack, outside it, and a loose item's paragraph of pictures as its stack", () => {
    const { root } = renderArticle("- ![[a.png]]\n  - nested\n\n1. ![[b.png]]\n\n2. ![[c.png]]");
    const [first] = root.querySelectorAll("li");
    expect(items(root)[0]).toBe("stack:1");
    expect(first?.querySelector("[data-article-media-stack] ul")).toBeNull();
    expect(first?.querySelector(":scope > [data-list-item-media] > ul")).not.toBeNull();
    expect([...root.querySelectorAll("ol > li")].map((item) => item.querySelector(":scope > [data-list-item-media] > [data-article-media-stack]") !== null)).toEqual([true, true]);
  });

  it("draws pictures parted by hard line breaks as one stack, as by soft ones", () => {
    const { root } = renderArticle("![[a.png]]  \n![[b.png]]\\\n![[c.png]]\n\n![[d.png]]\n![[e.png]]\n\n![[f.png]]  \nwords");
    const stacks = [...root.querySelectorAll("[data-article-media-stack]")].map((stack) => stack.querySelectorAll("img").length);
    expect(stacks).toEqual([3, 2]);
    // Words after a break keep the paragraph of media and text.
    expect(root.querySelector("p")).toBeNull();
    expect(root.textContent).toContain("words");
  });
});
