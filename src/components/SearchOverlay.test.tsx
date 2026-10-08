import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { GridSnapshot, LightBlock, SearchMatch } from "@/types";
import { TOP_FADE_HEIGHT } from "@/lib/edgeFade";
import {
  SearchOverlay,
  SEARCH_OVERLAY_MIN_QUERY_CHARS,
  SEARCH_OVERLAY_RECENT_LIMIT,
  SEARCH_OVERLAY_RESULT_LIMIT,
} from "./SearchOverlay";

const listGridBlocksMock = vi.fn<(
  tag?: string,
  offset?: number,
  limit?: number,
  query?: string,
) => Promise<GridSnapshot>>();

vi.mock("@/lib/commands", () => ({
  listGridBlocks: (
    tag?: string,
    offset?: number,
    limit?: number,
    query?: string,
  ) => listGridBlocksMock(tag, offset, limit, query),
  searchGridBlocks: async (tag: string | undefined, query: string, limit: number) => {
    const grid = await listGridBlocksMock(tag, 0, limit, query);
    return {
      generation: grid.generation,
      search_generation: 1,
      blocks: grid.blocks,
      has_more: grid.has_more,
      next_cursor: null,
      cursor_reset: false,
    };
  },
  // CardHoverMenu lazily loads the full block for its Connect submenu.
  getBlock: async () => null,
}));

vi.mock("@/components/Card", () => ({
  ReadOnlyCardPreview: ({ block, shadow }: { block: LightBlock; shadow?: string }) => (
    <div data-testid="overlay-preview" data-preview-shadow={shadow}>card {block.slug}</div>
  ),
}));

const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrlMock(url),
  revealItemInDir: vi.fn(),
}));

vi.mock("@/components/CollectionPicker", () => ({
  COLLECTION_PICKER_CONTENT_CLASS: "",
  CollectionPicker: ({
    blockSlug,
    selectedTags,
    onToggleTag,
  }: {
    blockSlug: string;
    selectedTags: string[];
    onToggleTag: (slug: string, tag: string, hasTag: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="picker-toggle-design"
      onClick={() => onToggleTag(blockSlug, "design", selectedTags.includes("design"))}
    >
      toggle design
    </button>
  ),
}));

function makeBlock(id: number, slug: string, overrides: Partial<LightBlock> = {}): LightBlock {
  return {
    id,
    slug,
    card_kind: "article",
    block_type: "article",
    title: `Title ${slug}`,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: `Body ${slug}`,
    preview_text: `Preview ${slug}`,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: [],
    feed_playback: null,
    ...overrides,
  };
}

function bodyMatch(excerpt: string, ranges: SearchMatch["ranges"]): SearchMatch {
  return { field: "body", kind: "exact", excerpt, ranges, score: 100 };
}

function snapshot(
  blocks: LightBlock[],
  total = blocks.length,
  hasMore = false,
): GridSnapshot {
  return { generation: 1, blocks, total_blocks: total, has_more: hasMore };
}

function renderOverlay(props: Partial<Parameters<typeof SearchOverlay>[0]> = {}) {
  const onQueryChange = vi.fn();
  const onClose = vi.fn();
  const onOpenBlock = vi.fn();
  const utils = render(
    <SearchOverlay
      open
      query=""
      vaultPath="/vault"
      onQueryChange={onQueryChange}
      onClose={onClose}
      onOpenBlock={onOpenBlock}
      {...props}
    />,
  );
  return { ...utils, onQueryChange, onClose, onOpenBlock };
}

beforeEach(() => {
  listGridBlocksMock.mockReset();
  listGridBlocksMock.mockResolvedValue(snapshot([]));
  openUrlMock.mockReset();
});

describe("SearchOverlay", () => {
  it("does not mask the results list while it is at rest", () => {
    // The band is a dark-theme treatment; jsdom resolves to light by default.
    document.documentElement.setAttribute("data-theme", "dark");
    renderOverlay({ scrollEdgeFade: true });

    const list = document.getElementById("search-overlay-listbox") as HTMLElement;
    expect(list).toBeTruthy();
    expect(list.dataset.searchResultsTopFade).toBeUndefined();
    const resting = document.querySelector('[data-top-fade-scrim="search"]') as HTMLElement;
    expect(resting.style.opacity).toBe("0");
  });

  it("dissolves the results list once it is scrolled", () => {
    // The band is a dark-theme treatment; jsdom resolves to light by default.
    document.documentElement.setAttribute("data-theme", "dark");
    // The list lives inside a Radix Dialog and is mounted only after the dialog
    // opens, so the fade must attach to a node that appeared after mount.
    renderOverlay({ scrollEdgeFade: true });

    const list = document.getElementById("search-overlay-listbox") as HTMLElement;
    Object.defineProperty(list, "scrollTop", { value: 240, configurable: true });
    fireEvent.scroll(list);

    expect(list.dataset.searchResultsTopFade).toBe("true");
    const scrim = document.querySelector('[data-top-fade-scrim="search"]') as HTMLElement;
    expect(scrim).toBeTruthy();
    expect(scrim.style.opacity).toBe("1");
    // Search results are a dense list, so they use the shorter band.
    expect(scrim.style.height).toBe(`${TOP_FADE_HEIGHT}px`);
    expect(list.contains(scrim)).toBe(false);
  });

  it("leaves the results list alone when the preference is off", () => {
    // The band is a dark-theme treatment; jsdom resolves to light by default.
    document.documentElement.setAttribute("data-theme", "dark");
    renderOverlay();

    const list = document.getElementById("search-overlay-listbox") as HTMLElement;
    Object.defineProperty(list, "scrollTop", { value: 240, configurable: true });
    fireEvent.scroll(list);

    expect(list.dataset.searchResultsTopFade).toBeUndefined();
    const off = document.querySelector('[data-top-fade-scrim="search"]') as HTMLElement;
    expect(off.style.opacity).toBe("0");
  });

  it("renders the focused input and selects the previous query on open", () => {
    renderOverlay({ query: "previous query" });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("previous query".length);
  });

  it("uses the feed card surface for the floating overlay", () => {
    renderOverlay({ query: "previous query" });

    expect(document.querySelector("[data-search-overlay]")).toHaveClass(
      "bg-card",
      "text-card-foreground",
    );
    expect(document.querySelector("[data-search-overlay]")).not.toHaveClass("bg-popover");
  });

  it("loads recently added elements for an empty query without debounce", async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    listGridBlocksMock.mockResolvedValue(
      snapshot(
        [
          makeBlock(1, "fresh", { saved_at: today.toISOString() }),
          makeBlock(2, "older", { saved_at: yesterday.toISOString() }),
        ],
        462,
      ),
    );
    renderOverlay();

    // Recent mode fires immediately (no debounce) with the recent limit and
    // no query — the canonical saved_at-DESC feed page.
    expect(listGridBlocksMock).toHaveBeenCalledWith(
      undefined,
      0,
      SEARCH_OVERLAY_RECENT_LIMIT,
      undefined,
    );

    // Rows are grouped into dynamic date sections derived from saved_at.
    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("fresh")).toBeInTheDocument();
    // The header count is a query-result number — hidden in recent mode.
    expect(screen.queryByText("462")).not.toBeInTheDocument();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });

  it("keeps arrow navigation flat across recent date sections", async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    listGridBlocksMock.mockResolvedValue(
      snapshot([
        makeBlock(1, "fresh", { saved_at: today.toISOString() }),
        makeBlock(2, "older", { saved_at: yesterday.toISOString() }),
      ]),
    );
    renderOverlay();
    await screen.findByText("Today");

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The second row lives in the next section — the index walks into it.
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("returns to recent mode when the query is cleared", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha", { saved_at: new Date().toISOString() })]),
    );
    const { rerender, onQueryChange, onClose, onOpenBlock } = renderOverlay({
      query: "alpha",
    });
    await waitFor(() => {
      expect(listGridBlocksMock).toHaveBeenCalledWith(
        undefined,
        0,
        SEARCH_OVERLAY_RESULT_LIMIT,
        "alpha",
      );
    });
    // Search results are never grouped — relevance order, no date sections.
    expect(screen.queryByText("Today")).not.toBeInTheDocument();

    rerender(
      <SearchOverlay
        open
        query=""
        vaultPath="/vault"
        onQueryChange={onQueryChange}
        onClose={onClose}
        onOpenBlock={onOpenBlock}
      />,
    );
    await waitFor(() => {
      expect(listGridBlocksMock).toHaveBeenCalledWith(
        undefined,
        0,
        SEARCH_OVERLAY_RECENT_LIMIT,
        undefined,
      );
    });
    expect(await screen.findByText("Today")).toBeInTheDocument();
  });

  it("debounces input and queries vault-wide with the result limit", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha")]));
    renderOverlay({ query: "  alpha   query " });
    await waitFor(() => {
      expect(listGridBlocksMock).toHaveBeenCalledWith(
        undefined,
        0,
        SEARCH_OVERLAY_RESULT_LIMIT,
        "alpha query",
      );
    });
  });

  it("keeps a one-character query pending without an IPC request or empty state", () => {
    renderOverlay({ query: "a" });

    expect(SEARCH_OVERLAY_MIN_QUERY_CHARS).toBe(2);
    expect(listGridBlocksMock).not.toHaveBeenCalled();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toBeNull();
    expect(screen.queryByTestId("overlay-preview")).not.toBeInTheDocument();
  });

  it("clears visible results when an existing search is replaced by one Cyrillic character", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha")]));
    const { rerender, onQueryChange, onClose, onOpenBlock } = renderOverlay({
      query: "alpha",
    });

    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeInTheDocument();
    });
    expect(listGridBlocksMock).toHaveBeenCalledTimes(1);

    rerender(
      <SearchOverlay
        open
        query="Г"
        vaultPath="/vault"
        onQueryChange={onQueryChange}
        onClose={onClose}
        onOpenBlock={onOpenBlock}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(listGridBlocksMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toBeNull();
  });

  it("renders result rows, the displayed-result count, and the preview of the active row", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta")], 42),
    );
    renderOverlay({ query: "alpha" });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toHaveTextContent("2");
    expect(screen.queryByText("42")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("alpha");
    // Each row carries the standard micro preview thumbnail.
    expect(screen.getAllByRole("option")[0]!.querySelector("img")).not.toBeNull();
  });

  it("sets every row on one line in the Sidebar row's type: the name, then the text in the secondary color (06.10.2026)", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "alpha"),
      makeBlock(2, "Cards/Шуховская башня", { preview_text: "Шуховская башня гиперболоидная сетка" }),
      makeBlock(3, "Cards/1.0 (5)", { preview_text: null, card_kind: "media", block_type: "image" }),
    ]));
    renderOverlay({ query: "alpha" });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });
    const [plain, repeated, bare] = screen.getAllByRole("option");

    for (const option of [plain!, repeated!, bare!]) {
      // One line: a single line element, nothing that clamps or wraps.
      const lines = option.querySelectorAll("[data-card-row-line]");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveClass("flex", "font-sans", "text-base", "items-baseline", "gap-1");
      // The thumbnail and the line, nothing else.
      expect(option.children).toHaveLength(2);
      expect(option.querySelector(".line-clamp-1, .line-clamp-2")).toBeNull();
      expect(option.querySelector(".text-sm")).toBeNull();
    }

    const name = plain!.querySelector("[data-card-row-name]")!;
    const text = plain!.querySelector("[data-card-row-text]")!;
    expect(name).toHaveTextContent(/^alpha$/);
    expect(name).toHaveClass("truncate", "min-w-0", "text-foreground");
    // The name keeps at most three quarters of the line, so the text starts.
    expect((name as HTMLElement).style.maxWidth).toBe("75%");
    expect(name.className).not.toMatch(/(?:^|\s)font-(?:medium|semibold|bold)(?:\s|$)/);
    expect(text).toHaveTextContent(/^Preview alpha$/);
    expect(text).toHaveClass("truncate", "min-w-0", "flex-1", "text-muted-foreground");
    // No separator glyph between the name and the text.
    expect(plain!.querySelector("[data-card-row-line]")!.textContent).toBe("alphaPreview alpha");

    // The text does not repeat the name.
    expect(repeated!.querySelector("[data-card-row-name]")).toHaveTextContent(/^Шуховская башня$/);
    expect(repeated!.querySelector("[data-card-row-text]")).toHaveTextContent(/^гиперболоидная сетка$/);

    // No text: the name alone takes the whole line.
    const bareName = bare!.querySelector("[data-card-row-name]")!;
    expect(bareName).toHaveTextContent(/^1\.0 \(5\)$/);
    expect((bareName as HTMLElement).style.maxWidth).toBe("");
    expect(bare!.querySelector("[data-card-row-text]")).toBeNull();
  });

  it("keeps a deep mark of a long name in view: head, ellipsis, the words up to the mark (06.10.2026)", async () => {
    const post = "Every sea king knows the tide does not wait, and neither does the wind that carries a wager for glor";
    const start = post.indexOf("glor");
    // Layout stand-ins: a 480px line and an 8px monospace font.
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-card-row-line") ? 480 : 0;
    });
    const canvasSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    try {
      listGridBlocksMock.mockResolvedValue(snapshot([
        makeBlock(1, `Cards/${post}`, {
          preview_text: "Something else entirely",
          search_match: { field: "title", kind: "prefix", excerpt: post, ranges: [{ start, end: start + 4 }], score: 9 },
        }),
      ]));
      renderOverlay({ query: "glor" });

      const option = await screen.findByRole("option");
      const name = option.querySelector("[data-card-row-name]")!;
      await waitFor(() => expect(name).toHaveAttribute("data-card-row-name-window"));
      // 75% of 480px less the slack holds 44 characters.
      expect(name.textContent).toBe("Every sea king…that carries a wager for glor");
      expect(name.querySelector("mark")).toHaveTextContent(/^glor$/);
      expect(option.querySelector("[data-card-row-text]")).toHaveTextContent(/^Something else entirely$/);
    } finally {
      widthSpy.mockRestore();
      canvasSpy.mockRestore();
    }
  });

  it("keeps a text match past the line's end in view: the words just before the mark (07.10.2026)", async () => {
    const excerpt = "… using special computer chips that are optimized for running many operations in parallel, known as GPUs.";
    const start = Array.from(excerpt.slice(0, excerpt.indexOf("known"))).length;
    // Layout stand-ins: a 320px text and an 8px monospace font.
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-card-row-line")) return 640;
      return this.hasAttribute("data-card-row-text") ? 320 : 0;
    });
    const canvasSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    try {
      listGridBlocksMock.mockResolvedValue(snapshot([
        makeBlock(1, "Cards/Large Language Models explained briefly", {
          search_match: { field: "body", kind: "exact", excerpt, ranges: [{ start, end: start + 5 }], score: 9 },
        }),
      ]));
      renderOverlay({ query: "known" });

      const option = await screen.findByRole("option");
      const text = option.querySelector("[data-card-row-text]")!;
      await waitFor(() => expect(text).toHaveAttribute("data-card-row-text-window"));
      // 320px less the slack holds 39 characters: the rest from `operations`
      // on fits whole.
      expect(text.textContent).toBe("…operations in parallel, known as GPUs.");
      expect(text.querySelector("mark")).toHaveTextContent(/^known$/);
    } finally {
      widthSpy.mockRestore();
      canvasSpy.mockRestore();
    }
  });

  it("names each result row by its file name and marks a title match in it (05.10.2026)", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([
        makeBlock(1, "Cards/Шуховская башня", {
          title: null,
          content_heading: "Radio tower",
          display_title: "Radio tower",
          search_match: {
            field: "title",
            kind: "exact",
            excerpt: "Шуховская башня",
            ranges: [{ start: 10, end: 15 }],
            score: 8,
          },
        }),
      ]),
    );
    renderOverlay({ query: "башня" });

    const option = await screen.findByRole("option");
    const title = option.querySelector("[data-card-row-name]")!;
    expect(title).toHaveTextContent(/^Шуховская башня$/);
    const mark = within(option).getByText("башня");
    expect(mark.tagName).toBe("MARK");
    expect(option).not.toHaveTextContent("Radio tower");
  });

  it("adds a plus to the displayed-result count when more search rows exist", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta")], 508, true),
    );
    renderOverlay({ query: "alpha" });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toHaveTextContent("2+");
    expect(screen.queryByText("508")).not.toBeInTheDocument();
  });

  it("does not show the previous recent total while a typed query is still pending", async () => {
    listGridBlocksMock.mockResolvedValueOnce(
      snapshot([makeBlock(1, "recent", { saved_at: new Date().toISOString() })], 508),
    );
    let resolveSearch: ((grid: GridSnapshot) => void) | null = null;
    listGridBlocksMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );
    const { rerender, onQueryChange, onClose, onOpenBlock } = renderOverlay();

    await screen.findByText("recent");
    expect(screen.queryByText("508")).not.toBeInTheDocument();

    rerender(
      <SearchOverlay
        open
        query="csd"
        vaultPath="/vault"
        onQueryChange={onQueryChange}
        onClose={onClose}
        onOpenBlock={onOpenBlock}
      />,
    );

    await waitFor(() => {
      expect(listGridBlocksMock).toHaveBeenCalledWith(
        undefined,
        0,
        SEARCH_OVERLAY_RESULT_LIMIT,
        "csd",
      );
    });
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toBeNull();
    expect(screen.queryByText("508")).not.toBeInTheDocument();

    resolveSearch!(snapshot([], 508));
    await waitFor(() => {
      expect(screen.getByText("No results")).toBeInTheDocument();
    });
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toHaveTextContent("0");
    expect(screen.queryByText("508")).not.toBeInTheDocument();
  });

  it("moves the active row with arrows while focus stays in the input", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta")]),
    );
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("beta");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-activedescendant", "search-overlay-option-2");

    // No cycling at the edges.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter opens the active block; row and preview clicks open too", async () => {
    const blocks = [makeBlock(1, "alpha"), makeBlock(2, "beta")];
    listGridBlocksMock.mockResolvedValue(snapshot(blocks));
    const { onOpenBlock } = renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpenBlock).toHaveBeenLastCalledWith(blocks[0]);

    fireEvent.click(screen.getAllByRole("option")[1]!);
    expect(onOpenBlock).toHaveBeenLastCalledWith(blocks[1]);

    fireEvent.click(screen.getByTestId("overlay-preview"));
    expect(onOpenBlock).toHaveBeenLastCalledWith(blocks[0]);
  });

  it("ignores a stale response after the query changed", async () => {
    let resolveFirst: ((grid: GridSnapshot) => void) | null = null;
    listGridBlocksMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    listGridBlocksMock.mockResolvedValueOnce(snapshot([makeBlock(2, "fresh")]));

    const { rerender } = renderOverlay({ query: "stale" });
    await waitFor(() => {
      expect(listGridBlocksMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <SearchOverlay
        open
        query="fresh"
        vaultPath="/vault"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        onOpenBlock={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("overlay-preview")).toHaveTextContent("fresh");
    });

    resolveFirst!(snapshot([makeBlock(1, "stale")]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("fresh");
  });

  it("drops a response to the old text while the new text waits out the debounce (А6.11)", async () => {
    let resolveFirst: ((grid: GridSnapshot) => void) | null = null;
    listGridBlocksMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    listGridBlocksMock.mockResolvedValueOnce(snapshot([makeBlock(2, "fresh")]));
    const props = {
      open: true,
      vaultPath: "/vault",
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      onOpenBlock: vi.fn(),
    };
    const { rerender } = render(<SearchOverlay {...props} query="stale" />);
    await waitFor(() => expect(listGridBlocksMock).toHaveBeenCalledTimes(1));

    // The new text is typed; its request has not gone out yet.
    rerender(<SearchOverlay {...props} query="fresh" />);
    resolveFirst!(snapshot([makeBlock(1, "stale")]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listGridBlocksMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("stale")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("fresh")).toBeInTheDocument());
  });

  it("Enter before the results of the typed text opens that text's first result (А6.11)", async () => {
    const stale = makeBlock(1, "stale");
    const fresh = makeBlock(2, "fresh");
    listGridBlocksMock.mockImplementation(async (_tag, _offset, _limit, query) => (
      snapshot(query === "stale" ? [stale] : [fresh])
    ));
    const onOpenBlock = vi.fn();
    const props = {
      open: true,
      vaultPath: "/vault",
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      onOpenBlock,
    };
    const { rerender } = render(<SearchOverlay {...props} query="stale" />);
    await waitFor(() => expect(screen.getByText("stale")).toBeInTheDocument());

    rerender(<SearchOverlay {...props} query="fresh" />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpenBlock).not.toHaveBeenCalled();

    await waitFor(() => expect(onOpenBlock).toHaveBeenCalledWith(fresh));
    expect(onOpenBlock).toHaveBeenCalledTimes(1);
  });

  it("an Enter still waiting for results does not open a card after Escape (Б5.2)", async () => {
    const stale = makeBlock(1, "stale");
    const fresh = makeBlock(2, "fresh");
    const freshAnswers: Array<() => void> = [];
    listGridBlocksMock.mockImplementation((_tag, _offset, _limit, query) => (
      query === "fresh"
        ? new Promise<GridSnapshot>((resolve) => {
          freshAnswers.push(() => resolve(snapshot([fresh])));
        })
        : Promise.resolve(snapshot([stale]))
    ));
    const onOpenBlock = vi.fn();
    const props = {
      vaultPath: "/vault",
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      onOpenBlock,
    };
    const { rerender } = render(<SearchOverlay {...props} open query="stale" />);
    await waitFor(() => expect(screen.getByText("stale")).toBeInTheDocument());

    // Enter before the answer, then Escape before it lands.
    rerender(<SearchOverlay {...props} open query="fresh" />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(freshAnswers).toHaveLength(1);
    rerender(<SearchOverlay {...props} open={false} query="fresh" />);
    await act(async () => {
      for (const answer of freshAnswers) answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onOpenBlock).not.toHaveBeenCalled();

    // Opened again, the overlay searches as usual and opens only on a new Enter.
    rerender(<SearchOverlay {...props} open query="fresh" />);
    await waitFor(() => expect(freshAnswers).toHaveLength(2));
    await act(async () => { freshAnswers[1]!(); });
    await waitFor(() => expect(screen.getByText("fresh")).toBeInTheDocument());
    expect(onOpenBlock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpenBlock).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it("renders the body-match excerpt with a mark and the semantic excerpt without one", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "lexical", {
        search_match: bodyMatch("around the match here", [{ start: 11, end: 16 }]),
      }),
      makeBlock(2, "semantic", {
        search_match: { field: "semantic", kind: "semantic", excerpt: "meaning excerpt", ranges: [], score: 50 },
      }),
      makeBlock(3, "author", {
        search_match: { field: "author", kind: "exact", excerpt: "@hidden-author", ranges: [], score: 80 },
      }),
    ]));
    renderOverlay({ query: "match" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    const options = screen.getAllByRole("option");
    const mark = options[0]!.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark!).toHaveTextContent("match");

    expect(options[1]!.querySelector("mark")).toBeNull();
    expect(options[1]!).toHaveTextContent("meaning excerpt");

    expect(options[2]!.querySelector("mark")).toBeNull();
    expect(options[2]!).toHaveTextContent("Preview author");
    expect(options[2]!.textContent).not.toContain("@hidden-author");
  });

  it("shows a failed query as an error and leaves no older row to open (Г4.3)", async () => {
    const stale = makeBlock(1, "stale");
    const fresh = makeBlock(2, "fresh");
    let freshFails = true;
    listGridBlocksMock.mockImplementation(async (_tag, _offset, _limit, query) => {
      if (query === "stale") return snapshot([stale]);
      if (freshFails) throw new Error("index is busy");
      return snapshot([fresh]);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onOpenBlock = vi.fn();
    const props = {
      open: true,
      vaultPath: "/vault",
      onQueryChange: vi.fn(),
      onClose: vi.fn(),
      onOpenBlock,
    };
    try {
      const { rerender } = render(<SearchOverlay {...props} query="stale" />);
      await waitFor(() => expect(screen.getByText("stale")).toBeInTheDocument());

      rerender(<SearchOverlay {...props} query="fresh" />);
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Search failed");
      expect(alert).toHaveTextContent("index is busy");
      // Nothing from the older text is left to click or to open with Enter.
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.queryByTestId("overlay-preview")).not.toBeInTheDocument();
      expect(screen.queryByText("No results")).not.toBeInTheDocument();
      expect(document.querySelector("[data-search-overlay-result-count]")).toBeNull();

      // Enter asks again for the current text and opens its answer.
      freshFails = false;
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
      await waitFor(() => expect(onOpenBlock).toHaveBeenCalledWith(fresh));
      expect(onOpenBlock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows No results for a non-empty query with an empty response", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([], 508));
    renderOverlay({ query: "nothing" });
    await waitFor(() => {
      expect(screen.getByText("No results")).toBeInTheDocument();
    });
    expect(
      document.querySelector("[data-search-overlay-result-count]"),
    ).toHaveTextContent("0");
    expect(screen.queryByText("508")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overlay-preview")).not.toBeInTheDocument();
  });

  it("renders the metadata block for the active row and lazily loads collections", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "alpha", {
        url: "https://example.com/article",
        author: "@author",
        saved_at: "2026-03-05T10:00:00Z",
      }),
    ]));
    const loadBlockTags = vi.fn(async (slugs: string[]) => {
      expect(slugs).toEqual(["alpha"]);
      return new Map([["alpha", ["design", "reading"]]]);
    });
    renderOverlay({ query: "alpha", loadBlockTags });

    await waitFor(() => {
      expect(screen.getByTestId("overlay-preview")).toHaveTextContent("alpha");
    });
    // The feed's own card, standing in its pane rather than floating.
    expect(screen.getByTestId("overlay-preview")).toHaveAttribute("data-preview-shadow", "none");
    const metadata = within(
      document.querySelector("[data-search-overlay-metadata]") as HTMLElement,
    );
    expect(metadata.getByText("Date")).toBeInTheDocument();
    // The type taxonomy is gone (decision 044): no Type row anywhere.
    expect(metadata.queryByText("Type")).toBeNull();
    expect(metadata.getByText("example.com")).toBeInTheDocument();
    expect(metadata.getByText("Author")).toBeInTheDocument();
    expect(metadata.getByText("@author")).toBeInTheDocument();
    await waitFor(() => {
      expect(metadata.getByText("Collections")).toBeInTheDocument();
    });
    expect(metadata.getByText("design, reading")).toBeInTheDocument();
    // The preview has nothing to press (SPEC_CARD_STATES.md, С10): no hover
    // menu is laid over it; the card's commands live on the rows.
    const pane = document.querySelector("[data-search-overlay-preview]") as HTMLElement;
    expect(within(pane).queryAllByRole("button")).toHaveLength(0);
    expect(pane.querySelector("[data-card-hover-more-action], [data-card-hover-bottom-actions]")).toBeNull();
  });

  it("hides empty metadata rows for a block without url, author and collections", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "bare", { url: null, author: null }),
    ]));
    const loadBlockTags = vi.fn(async () => new Map([["bare", []]]));
    renderOverlay({ query: "bare", loadBlockTags });

    await waitFor(() => {
      expect(screen.getByTestId("overlay-preview")).toHaveTextContent("bare");
    });
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
    expect(screen.queryByText("Author")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(loadBlockTags).toHaveBeenCalled();
    });
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
  });

  it("metadata Source value is clickable and opens the url", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "alpha", { url: "https://example.com/article" }),
    ]));
    renderOverlay({ query: "alpha" });
    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "example.com" }));
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/article");
  });

  it("re-runs the active query on vault-refreshed and keeps the active row by slug", async () => {
    const blocks = [makeBlock(1, "alpha"), makeBlock(2, "beta"), makeBlock(3, "gamma")];
    listGridBlocksMock.mockResolvedValue(snapshot(blocks));
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    // Move to "beta", then simulate a vault mutation that deletes "alpha".
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("beta");

    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(2, "beta"), makeBlock(3, "gamma")]),
    );
    fireEvent(window, new Event("vault-refreshed"));

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    // The deleted card is gone; the active row followed the slug.
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("beta");
  });

  it("removes a row instantly on the optimistic block-deleted notice", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta"), makeBlock(3, "gamma")], 3),
    );
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    const fetchCallsBefore = listGridBlocksMock.mock.calls.length;

    fireEvent(
      window,
      new CustomEvent("block-deleted", { detail: { slug: "beta" } }),
    );

    // Immediate, no refetch needed: row gone, count decremented, index clamped.
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("gamma");
    expect(listGridBlocksMock.mock.calls.length).toBe(fetchCallsBefore);
  });

  it("clamps the active row when the active card itself was deleted", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta")]),
    );
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("beta");

    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha")]));
    fireEvent(window, new Event("vault-refreshed"));

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("alpha");
  });

  it("clear button resets the query and returns focus to the input", async () => {
    const { onQueryChange } = renderOverlay({ query: "abc" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("Escape closes the overlay regardless of the query", async () => {
    const { onClose } = renderOverlay({ query: "abc" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

// A row shows the feed card's commands at its right end (06.10.2026):
// Connect, Source and More, the card's own controls; ⌘K opens More.
describe("SearchOverlay result row commands", () => {
  const withUrl = makeBlock(1, "alpha", { url: "https://example.com/article" });
  const withoutUrl = makeBlock(2, "beta", { url: null });

  async function renderRows(props: Partial<Parameters<typeof SearchOverlay>[0]> = {}) {
    listGridBlocksMock.mockResolvedValue(snapshot([withUrl, withoutUrl]));
    const utils = renderOverlay({ query: "al", ...props });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    return utils;
  }

  function option(index: number): HTMLElement {
    return screen.getAllByRole("option")[index]!;
  }

  function rowOf(index: number): HTMLElement {
    return option(index).closest("[data-card-row]") as HTMLElement;
  }

  function rowCommands(index: number): string[] {
    return within(rowOf(index)).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");
  }

  let pointerX = 0;
  /** A real pointer move: new coordinates every time. */
  function hover(index: number) {
    pointerX += 7;
    fireEvent.pointerMove(option(index), { clientX: pointerX, clientY: 20 + index * 44 });
  }

  it("shows Connect, Source and More on the row under the pointer, in the card's buttons", async () => {
    await renderRows();
    // The active row holds its commands hidden until the pointer comes.
    expect(rowCommands(0)).toEqual([]);
    expect(rowOf(0).querySelector("[data-card-row-actions]")).toHaveAttribute("data-visible", "false");

    hover(0);
    expect(rowCommands(0)).toEqual(["Card actions", "Source", "Connect"]);
    const actions = rowOf(0).querySelector("[data-card-row-actions]") as HTMLElement;
    expect(actions).toHaveAttribute("data-visible", "true");
    expect(actions).toHaveClass("gap-1", "transition-opacity", "duration-[var(--hover-intent-fade-in)]");
    for (const button of within(actions).getAllByRole("button")) {
      expect(button).toHaveAttribute("data-variant", "raised");
      expect(button).toHaveAttribute("data-size", "icon-xs");
    }
    // The text stops short of three 24 px buttons, two 4 px gaps and the
    // row's 8 px gap; the name keeps its place.
    const text = option(0).querySelector("[data-card-row-text]") as HTMLElement;
    expect(text.style.paddingRight).toBe("88px");
    expect((option(0).querySelector("[data-card-row-name]") as HTMLElement).style.maxWidth).toBe("75%");

    // The pointer moves on: the commands go with it, Source only with a link.
    hover(1);
    expect(option(1)).toHaveAttribute("aria-selected", "true");
    expect(rowOf(0).querySelector("[data-card-row-actions]")).toBeNull();
    expect(rowCommands(1)).toEqual(["Card actions", "Connect"]);
    expect((option(1).querySelector("[data-card-row-text]") as HTMLElement).style.paddingRight).toBe("60px");
  });

  it("hides the commands when the arrows, the wheel or leaving the list take the row from the pointer", async () => {
    await renderRows();
    const input = screen.getByRole("combobox");
    const listbox = screen.getByRole("listbox");

    hover(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(option(1)).toHaveAttribute("aria-selected", "true");
    expect(rowCommands(0)).toEqual([]);
    expect(rowCommands(1)).toEqual([]);
    expect((option(1).querySelector("[data-card-row-text]") as HTMLElement).style.paddingRight).toBe("");

    hover(1);
    expect(rowCommands(1)).toEqual(["Card actions", "Connect"]);
    fireEvent.wheel(listbox);
    expect(rowCommands(1)).toEqual([]);

    hover(1);
    fireEvent.pointerLeave(listbox);
    expect(rowCommands(1)).toEqual([]);
    expect(rowOf(1).querySelector("[data-card-row-actions]")).toHaveClass("duration-[var(--hover-intent-fade-out)]");
  });

  it("stops a name alone short of the commands", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha", { preview_text: "alpha" })]));
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    const name = option(0).querySelector("[data-card-row-name]") as HTMLElement;
    expect(option(0).querySelector("[data-card-row-text]")).toBeNull();
    expect(name.style.maxWidth).toBe("");
    hover(0);
    expect(name.style.maxWidth).toBe("calc(100% - 60px)");
  });

  it("Source opens the link; a command never opens the card, the rest of the row does", async () => {
    const { onOpenBlock } = await renderRows();
    hover(0);
    fireEvent.click(within(rowOf(0)).getByRole("button", { name: "Source" }));
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/article");
    expect(onOpenBlock).not.toHaveBeenCalled();

    fireEvent.pointerDown(within(rowOf(0)).getByRole("button", { name: "Card actions" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
    expect(onOpenBlock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename…" }), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
    });

    fireEvent.click(option(0));
    expect(onOpenBlock).toHaveBeenCalledWith(withUrl);
  });

  it("Connect toggles a collection optimistically and holds the commands while its picker is open", async () => {
    const loadBlockTags = vi.fn(async () => new Map([["alpha", ["reading"]]]));
    const onToggleTag = vi.fn();
    const { onOpenBlock } = await renderRows({ loadBlockTags, onToggleTag });
    await waitFor(() => {
      expect(screen.getByText("reading")).toBeInTheDocument();
    });

    hover(0);
    fireEvent.pointerDown(within(rowOf(0)).getByRole("button", { name: "Connect" }), {
      button: 0,
      ctrlKey: false,
    });
    const picker = await screen.findByTestId("picker-toggle-design");
    expect(screen.getByRole("dialog").contains(picker)).toBe(true);
    // The pointer on its way to the picker leaves the list: the row holds.
    fireEvent.pointerLeave(screen.getByRole("listbox"));
    hover(1);
    expect(option(0)).toHaveAttribute("aria-selected", "true");
    expect(rowOf(0).querySelector("[data-card-row-actions]")).toHaveAttribute("data-visible", "true");

    fireEvent.click(picker);
    expect(onToggleTag).toHaveBeenCalledWith("alpha", "design", false);
    await waitFor(() => {
      expect(screen.getByText("reading, design")).toBeInTheDocument();
    });
    expect(onOpenBlock).not.toHaveBeenCalled();
  });

  it("⌘K opens the active row's More menu; Escape closes the menu first, then the overlay", async () => {
    const onRequestRename = vi.fn();
    const onRequestDelete = vi.fn();
    const { onClose } = await renderRows({ onRequestRename, onRequestDelete });
    const input = screen.getByRole("combobox");

    // The arrows reach the row; ⌘K needs no pointer.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    const rename = await screen.findByRole("menuitem", { name: "Rename…" });
    expect(screen.getByRole("dialog").contains(rename)).toBe(true);
    const more = within(rowOf(1)).getByRole("button", { name: "Card actions" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(rowOf(1).querySelector("[data-card-row-actions]")).toHaveAttribute("data-visible", "true");

    // The open menu holds its row against the pointer.
    hover(0);
    expect(option(1)).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(rename, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    // ⌘K again opens it; ⌘K inside it closes it.
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Rename…" }), { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
    });

    // The menu's commands are the card's, wired to the overlay's handlers.
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    expect(onRequestRename).toHaveBeenCalledWith(withoutUrl);
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    });
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(onRequestDelete).toHaveBeenCalledWith("beta");

    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("⌘K does nothing without a row", async () => {
    renderOverlay({ query: "abc" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "k", metaKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
