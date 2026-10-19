import { describe, expect, it } from "vitest";
import { parseReadingSyntax } from "@/lib/reading/syntax";
import { parseTable, rowCount } from "@/lib/editing/tableModel";
import { PERF_MIDDLE_MARK, PERF_SETS, PERF_TYPING_MARK, perfImageName, perfSetBody } from "./editingPerfSets";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** The node types the reading mode finds in `body`, with how many of each. */
function readingNodes(body: string): Map<string, number> {
  const found = new Map<string, number>();
  const visit = (node: { type: string; children?: unknown[] }) => {
    found.set(node.type, (found.get(node.type) ?? 0) + 1);
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(parseReadingSyntax(body));
  return found;
}

describe("the sets of the editor's performance check (SPEC_EDITING.md, Л14.2)", () => {
  it("makes every set to its size, the same each time, with a place to type at the top and in the middle", () => {
    for (const name of Object.keys(PERF_SETS)) {
      const body = perfSetBody(name) ?? "";
      expect(count(body, new RegExp(PERF_TYPING_MARK, "g")), name).toBe(1);
      expect(count(body, new RegExp(PERF_MIDDLE_MARK, "g")), name).toBe(1);
      expect(body.indexOf(PERF_MIDDLE_MARK), name).toBeGreaterThan(body.length / 3);
    }
    const prose = perfSetBody("prose-1mb") ?? "";
    expect(bytes(prose)).toBeGreaterThanOrEqual(1024 * 1024);
    expect(bytes(prose)).toBeLessThan(1024 * 1024 + 4096);
    expect(perfSetBody("prose-1mb")).toBe(prose);
    const large = perfSetBody("prose-10mb") ?? "";
    expect(bytes(large)).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    expect(bytes(large)).toBeLessThan(10 * 1024 * 1024 + 4096);
    expect(perfSetBody("tables")).toBeNull();
    expect(perfSetBody(null)).toBeNull();
    // Any whole number of megabytes, for the size where typing stops
    // holding its limit (Л14.4).
    const four = perfSetBody("prose-4mb") ?? "";
    expect(bytes(four)).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(bytes(four)).toBeLessThan(4 * 1024 * 1024 + 4096);
    expect(perfSetBody("prose-123mb")).toBeNull();
  });

  it("holds what each set is named for", () => {
    const headings = perfSetBody("headings-10k") ?? "";
    expect(count(headings, /^#{2,3} Заголовок \d+$/gm)).toBe(10_000);
    expect(count(headings, /\[\[Заметка \d+\]\]/g)).toBe(10_000);

    const tasks = perfSetBody("tasks-10k") ?? "";
    expect(count(tasks, /^ *- (?:\[[ x]\] )?Пункт \d+/gm)).toBe(10_000);
    expect(count(tasks, /^ *- \[[ x]\] /gm)).toBeGreaterThan(6_000);
    expect(count(tasks, /^ {4}- /gm)).toBeGreaterThan(1_000);
    // A list of the set, as the reading mode reads it: nested items, no
    // indented code.
    const firstList = tasks.slice(0, tasks.indexOf("## Список 2"));
    const nodes = readingNodes(firstList);
    expect(nodes.get("listItem")).toBe(1_000);
    expect(nodes.get("code") ?? 0).toBe(0);
    expect(nodes.get("list")).toBeGreaterThan(100);

    const images = perfSetBody("images-1000") ?? "";
    expect(count(images, /^!\[\[Картинка \d+\.png\]\]$/gm)).toBe(1_000);
    expect(images).toContain(`![[${perfImageName(1000)}]]`);

    const mermaid = perfSetBody("mermaid-100") ?? "";
    expect(count(mermaid, /^```mermaid$/gm)).toBe(100);

    const tables = perfSetBody("tables-200") ?? "";
    const blocks = tables.split(/\n\n/).filter((part) => part.startsWith("| № |"));
    expect(blocks).toHaveLength(200);
    for (const block of blocks) {
      const model = parseTable(block);
      expect(model ? rowCount(model) : 0).toBe(21);
    }
  });
});
