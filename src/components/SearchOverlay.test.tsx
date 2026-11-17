import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { GridSnapshot, LightBlock, SearchMatch, TabLocation } from "@/types";
import {
  SearchOverlay,
  SEARCH_OVERLAY_MIN_QUERY_CHARS,
  SEARCH_OVERLAY_PREVIEW_WIDTH_PX,
  SEARCH_OVERLAY_RECENT_LIMIT,
  SEARCH_OVERLAY_RESULT_LIMIT,
  searchOverlayQueryReady,
} from "./SearchOverlay";
import { lightBlock } from "@/test/blocks";
import { installMotionInput, MOTION_KEY_ATTRIBUTE, noteNativeMenuCommand } from "@/lib/motionInput";

const listGridBlocksMock = vi.fn<(
  tag?: string,
  offset?: number,
  limit?: number,
  query?: string,
) => Promise<GridSnapshot>>();

vi.mock("@/lib/commands", () => ({
  // Recent mode reads Everything: the mock hears no tag.
  // The overlay's recent cards are the feed's first: no card to start after
  // (`after` is null), which the mock hears as the number 0.
  listGridBlocks: (
    place: TabLocation,
    after: { saved_at: string; slug: string } | null,
    limit?: number,
    query?: string,
  ) => listGridBlocksMock(place.kind === "collection" ? place.tag : undefined, after === null ? 0 : -1, limit, query),
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
  // The rule of commands.ts, over the error its `invoke` throws.
  isSearchSuperseded: (error: unknown) =>
    error instanceof Error && (error.cause as { kind?: string } | undefined)?.kind === "search_superseded",
}));

vi.mock("@/components/Card", () => ({
  ReadOnlyCardPreview: ({ block, shadow }: { block: LightBlock; shadow?: string }) => (
    <div data-testid="overlay-preview" data-preview-shadow={shadow}>card {block.slug}</div>
  ),
}));

const openUrlMock = vi.fn(async (_url: string) => undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrlMock(url),
  revealItemInDir: vi.fn(async () => undefined),
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
  return lightBlock({
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
  });
}

function bodyMatch(excerpt: string, ranges: SearchMatch["ranges"]): SearchMatch {
  return { field: "body", kind: "exact", excerpt, ranges, score: 100, explanation: null };
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
    // A row of the list, its text at the rows' thumbnails.
    expect(screen.getByText("Today")).toHaveClass("flex", "h-row", "items-center", "px-plate");
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

  // One letter or digit is searched, by file names only, which the backend
  // narrows (user's decision of 15.11.2026): the same request, debounce,
  // rows, count and preview as any search.
  it("searches one letter by the ordinary request and shows its rows, count and preview", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "Cards/Город света", {
        search_match: { field: "title", kind: "prefix", excerpt: "Город света", ranges: [{ start: 0, end: 1 }], score: 8, explanation: null },
      }),
    ]));
    renderOverlay({ query: "г" });

    expect(SEARCH_OVERLAY_MIN_QUERY_CHARS).toBe(2);
    // The debounce of live typing holds it as any text.
    expect(listGridBlocksMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listGridBlocksMock).toHaveBeenCalledWith(undefined, 0, SEARCH_OVERLAY_RESULT_LIMIT, "г");
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(document.querySelector("[data-search-overlay-result-count]")).toHaveTextContent("1");
    expect(screen.getByRole("option").querySelector("mark")).toHaveTextContent("Г");
    expect(screen.getByTestId("overlay-preview")).toBeInTheDocument();
  });

  it("shows No results for one letter that no name starts a word with", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([], 508));
    renderOverlay({ query: "7" });
    await waitFor(() => expect(screen.getByText("No results")).toBeInTheDocument());
    expect(listGridBlocksMock).toHaveBeenCalledWith(undefined, 0, SEARCH_OVERLAY_RESULT_LIMIT, "7");
    expect(document.querySelector("[data-search-overlay-result-count]")).toHaveTextContent("0");
  });

  it.each(["#", "-", "."])("keeps one %s pending without an IPC request or empty state", async (query) => {
    renderOverlay({ query });
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(listGridBlocksMock).not.toHaveBeenCalled();
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
    expect(document.querySelector("[data-search-overlay-result-count]")).toBeNull();
    expect(screen.queryByTestId("overlay-preview")).not.toBeInTheDocument();
  });

  it("tells a searched character from one still being typed", () => {
    for (const query of ["a", "Г", "ё", "7", "Ω", "あ"]) expect(searchOverlayQueryReady(query)).toBe(true);
    for (const query of ["#", "-", ".", "\u2014", "\u{1F600}", " "]) expect(searchOverlayQueryReady(query)).toBe(false);
    expect(searchOverlayQueryReady("ab")).toBe(true);
    expect(searchOverlayQueryReady("#-")).toBe(true);
  });

  it("replaces the results of an existing search by those of one character at once", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha")]));
    const { rerender, onQueryChange, onClose, onOpenBlock } = renderOverlay({
      query: "alpha",
    });

    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeInTheDocument();
    });
    expect(listGridBlocksMock).toHaveBeenCalledTimes(1);

    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(2, "Город")]));
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
      expect(screen.getByText("Город")).toBeInTheDocument();
    });
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(listGridBlocksMock).toHaveBeenCalledTimes(2);
    expect(listGridBlocksMock).toHaveBeenLastCalledWith(undefined, 0, SEARCH_OVERLAY_RESULT_LIMIT, "Г");
  });

  it("clears visible results when an existing search is replaced by one character still being typed", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha")]));
    const { rerender, onQueryChange, onClose, onOpenBlock } = renderOverlay({
      query: "alpha",
    });
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeInTheDocument();
    });

    rerender(
      <SearchOverlay
        open
        query="#"
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
          search_match: { field: "title", kind: "prefix", excerpt: post, ranges: [{ start, end: start + 4 }], score: 9, explanation: null },
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
          search_match: { field: "body", kind: "exact", excerpt, ranges: [{ start, end: start + 5 }], score: 9, explanation: null },
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
            explanation: null,
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
        search_match: { field: "semantic", kind: "semantic", excerpt: "meaning excerpt", ranges: [], score: 50, explanation: null },
      }),
      makeBlock(3, "author", {
        search_match: { field: "author", kind: "exact", excerpt: "@hidden-author", ranges: [], score: 80, explanation: null },
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
    // The pane holds a card, not a list: its rows stay compact lines.
    expect(metadata.getByText("Date").closest("[data-metadata-row]"))
      .toHaveAttribute("data-metadata-row-spacing", "compact");
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
    expect(rowCommands(0)).toEqual(["Element actions", "Source", "Connect"]);
    const actions = rowOf(0).querySelector("[data-card-row-actions]") as HTMLElement;
    expect(actions).toHaveAttribute("data-visible", "true");
    expect(actions).toHaveClass("gap-1", "transition-opacity", "duration-(--motion-enter)");
    for (const button of within(actions).getAllByRole("button")) {
      expect(button).toHaveAttribute("data-variant", "raised");
      expect(button).toHaveAttribute("data-size", "icon-xs");
    }
    // The line stops short of three 24 px buttons, two 4 px gaps and the
    // row's 8 px gap; the name takes its share of what is left.
    const line = option(0).querySelector("[data-card-row-line]") as HTMLElement;
    expect(line.style.paddingRight).toBe("88px");
    expect((option(0).querySelector("[data-card-row-text]") as HTMLElement).style.paddingRight).toBe("");
    expect((option(0).querySelector("[data-card-row-name]") as HTMLElement).style.maxWidth).toBe("75%");

    // The pointer moves on: the commands go with it, Source only with a link.
    hover(1);
    expect(option(1)).toHaveAttribute("aria-selected", "true");
    expect(rowOf(0).querySelector("[data-card-row-actions]")).toBeNull();
    expect(rowCommands(1)).toEqual(["Element actions", "Connect"]);
    expect((option(1).querySelector("[data-card-row-line]") as HTMLElement).style.paddingRight).toBe("60px");
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
    expect((option(1).querySelector("[data-card-row-line]") as HTMLElement).style.paddingRight).toBe("");

    hover(1);
    expect(rowCommands(1)).toEqual(["Element actions", "Connect"]);
    fireEvent.wheel(listbox);
    expect(rowCommands(1)).toEqual([]);

    hover(1);
    fireEvent.pointerLeave(listbox);
    expect(rowCommands(1)).toEqual([]);
    expect(rowOf(1).querySelector("[data-card-row-actions]")).toHaveClass("duration-(--motion-exit)");
  });

  it("stops a name alone short of the commands", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha", { preview_text: "alpha" })]));
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    const name = option(0).querySelector("[data-card-row-name]") as HTMLElement;
    const line = option(0).querySelector("[data-card-row-line]") as HTMLElement;
    expect(option(0).querySelector("[data-card-row-text]")).toBeNull();
    expect(line.style.paddingRight).toBe("");
    hover(0);
    expect(line.style.paddingRight).toBe("60px");
    expect(name.style.maxWidth).toBe("");
  });

  it("shows no text where only a cut letter would fit beside a long name (09.10.2026)", async () => {
    // Layout stand-ins: a 6px text room and an 8px monospace font, the room
    // a long name and three buttons leave.
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-card-row-line")) return 480;
      return this.hasAttribute("data-card-row-text") ? 6 : 0;
    });
    const canvasSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    try {
      listGridBlocksMock.mockResolvedValue(snapshot([
        makeBlock(1, "Cards/NCSA Mosaic, 1993. The browser that put pictures on the web", {
          preview_text: "pictures inline with text",
        }),
      ]));
      renderOverlay({ query: "mosaic" });

      const text = (await screen.findByRole("option")).querySelector("[data-card-row-text]")!;
      await waitFor(() => expect(text).toHaveAttribute("data-card-row-text-hidden"));
      expect(text.textContent).toBe("");
    } finally {
      widthSpy.mockRestore();
      canvasSpy.mockRestore();
    }
  });

  it("Source opens the link; a command never opens the card, the rest of the row does", async () => {
    const { onOpenBlock } = await renderRows();
    hover(0);
    fireEvent.click(within(rowOf(0)).getByRole("button", { name: "Source" }));
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/article");
    expect(onOpenBlock).not.toHaveBeenCalled();

    fireEvent.pointerDown(within(rowOf(0)).getByRole("button", { name: "Element actions" }), {
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
    const more = within(rowOf(1)).getByRole("button", { name: "Element actions" });
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

// The preview column stands while the results list beside it keeps at least
// the column's own width (16.10.2026): the overlay's body decides, as its
// resize observer reports it, not the window.
describe("SearchOverlay preview column", () => {
  const PREVIEW = SEARCH_OVERLAY_PREVIEW_WIDTH_PX;
  // The body as wide as two columns: the list exactly as wide as the preview.
  const THRESHOLD = 2 * PREVIEW;

  // The page's resize observers; `resizeBody` reports a new width of the
  // overlay's body, as a frame of the page does after its layout.
  const observers = new Set<FakeResizeObserver>();
  class FakeResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  }
  const realResizeObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = realResizeObserver;
    observers.clear();
  });

  function body(): HTMLElement {
    return document.querySelector("[data-search-overlay-body]") as HTMLElement;
  }

  function resizeBody(width: number) {
    const target = body();
    act(() => {
      for (const observer of [...observers]) {
        if (!observer.targets.has(target)) continue;
        const size = [{ inlineSize: width, blockSize: 0 }];
        const entry: ResizeObserverEntry = {
          target,
          // The overlay reads the width alone.
          contentRect: { width } as DOMRectReadOnly,
          borderBoxSize: size,
          contentBoxSize: size,
          devicePixelContentBoxSize: size,
        };
        observer.callback([entry], observer as unknown as ResizeObserver);
      }
    });
  }

  function previewColumn(): HTMLElement | null {
    return document.querySelector("[data-search-overlay-preview-column]");
  }

  async function renderResults(blocks: LightBlock[]) {
    listGridBlocksMock.mockResolvedValue(snapshot(blocks));
    const utils = renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(blocks.length);
    });
    return utils;
  }

  it("keeps the preview while the list beside it is exactly as wide as the preview", async () => {
    await renderResults([makeBlock(1, "alpha")]);
    resizeBody(THRESHOLD);
    expect(previewColumn()).not.toBeNull();
    expect(previewColumn()).toHaveStyle({ width: `${PREVIEW}px` });
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("alpha");
  });

  it("drops the preview one pixel narrower; the list takes the whole body", async () => {
    await renderResults([makeBlock(1, "alpha")]);
    resizeBody(THRESHOLD - 1);
    expect(previewColumn()).toBeNull();
    expect(screen.queryByTestId("overlay-preview")).not.toBeInTheDocument();
    expect(document.querySelector("[data-search-overlay-metadata]")).toBeNull();
    // The list's column is all the body holds, `flex-1`: the whole width.
    expect(body().children).toHaveLength(1);
    expect(body().firstElementChild).toHaveClass("flex-1");
    expect(body().firstElementChild).toContainElement(screen.getByRole("listbox"));
  });

  it("moves the active row and opens results with Enter and a click without the preview", async () => {
    const blocks = [makeBlock(1, "alpha"), makeBlock(2, "beta")];
    const { onOpenBlock } = await renderResults(blocks);
    resizeBody(THRESHOLD - 1);
    expect(previewColumn()).toBeNull();

    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", "search-overlay-option-2");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenBlock).toHaveBeenLastCalledWith(blocks[1]);

    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(onOpenBlock).toHaveBeenLastCalledWith(blocks[0]);
  });

  it("shows the recent sections and No results without the preview", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "fresh", { saved_at: new Date().toISOString() })]),
    );
    const { rerender } = renderOverlay();
    expect(await screen.findByText("Today")).toBeInTheDocument();
    resizeBody(THRESHOLD - 1);
    expect(previewColumn()).toBeNull();
    expect(screen.getByText("fresh")).toBeInTheDocument();

    listGridBlocksMock.mockResolvedValue(snapshot([]));
    rerender(
      <SearchOverlay
        open
        query="nothing"
        vaultPath="/vault"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        onOpenBlock={vi.fn()}
      />,
    );
    expect(await screen.findByText("No results")).toBeInTheDocument();
    expect(previewColumn()).toBeNull();
  });

  it("switches live as the body is resized across the threshold, keeping the active row", async () => {
    await renderResults([makeBlock(1, "alpha"), makeBlock(2, "beta")]);
    resizeBody(1000);
    expect(previewColumn()).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    resizeBody(THRESHOLD - 1);
    expect(previewColumn()).toBeNull();
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

    resizeBody(THRESHOLD);
    expect(previewColumn()).not.toBeNull();
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("beta");
  });
});

/// SPEC_MOTION_LEVELS.md, М6: ⌘F and Find Elements (a native menu item,
/// a key by УД4, п. 1) open the search at once at every level; the bottom
/// bar's button opens it as the window does in Full, at once at Minimal and
/// Off (global.css).
describe("SearchOverlay by the input", () => {
  let removeInput: () => void;
  beforeEach(() => {
    removeInput = installMotionInput();
  });
  afterEach(() => removeInput());

  const parts = () => ({
    surface: document.querySelector<HTMLElement>("[data-search-overlay]"),
    scrim: document.querySelector<HTMLElement>("[data-search-overlay-scrim]"),
  });

  it("names its scrim for the rule that stands it at once at Minimal", () => {
    renderOverlay();
    const { surface, scrim } = parts();
    expect(surface).toHaveAttribute("data-slot", "dialog-content");
    expect(scrim).toHaveAttribute("data-slot", "dialog-overlay");
  });

  it("opened by the native menu's Find Elements carries the key's mark on the panel and the scrim", () => {
    noteNativeMenuCommand();
    renderOverlay();
    const { surface, scrim } = parts();
    expect(surface).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    expect(scrim).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("opened by the bottom bar's button carries none", () => {
    fireEvent.pointerDown(document.body);
    renderOverlay();
    const { surface, scrim } = parts();
    expect(surface).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    expect(scrim).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });
});

/// What the list shows is the answer to the text in the field, whatever order
/// the answers come back in and however the backend stops older searches
/// (SPEC_SEARCH_OVERLAY.md, «Ответ на набранный текст»).
describe("SearchOverlay answers to the typed text", () => {
  interface Asked {
    query: string;
    answer: (blocks: LightBlock[]) => void;
    fail: (error: unknown) => void;
  }
  let asked: Asked[];
  const props = {
    open: true,
    vaultPath: "/vault",
    onQueryChange: vi.fn(),
    onClose: vi.fn(),
    onOpenBlock: vi.fn(),
  };

  beforeEach(() => {
    asked = [];
    listGridBlocksMock.mockImplementation((_tag, _offset, _limit, query) => new Promise((resolve, reject) => {
      asked.push({ query: query ?? "", answer: (blocks) => resolve(snapshot(blocks)), fail: reject });
    }));
  });

  /** The cards an answer to `query` names, `label` telling two answers to
   *  the same text apart. */
  function cardsOf(query: string, label = "") {
    return [1, 2].map((index) => makeBlock(query.length * 10 + index, `${query} ${label}${index}`));
  }

  function shownNames(): string[] {
    return screen.queryAllByRole("option").map(
      (option) => option.querySelector("[data-card-row-name]")?.textContent ?? "",
    );
  }

  /** The person types `query`, and its request goes out once the debounce
   *  has passed. */
  async function type(view: ReturnType<typeof render>, query: string) {
    view.rerender(<SearchOverlay {...props} query={query} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 130));
    });
  }

  async function settle(work: () => void) {
    await act(async () => {
      work();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function superseded(): Error {
    return Object.assign(new Error("the search was superseded by a newer one"), {
      cause: { kind: "search_superseded" },
    });
  }

  const texts = ["me", "met", "meta", "metal"];
  it.each([
    ["in the order they were asked", [0, 1, 2, 3]],
    ["newest first", [3, 2, 1, 0]],
    ["the newest between older ones", [1, 3, 0, 2]],
    ["the oldest last", [3, 1, 2, 0]],
  ])("shows the answer to the text in the field when the answers come back %s", async (_name, order) => {
    const view = render(<SearchOverlay {...props} query="" />);
    for (const text of texts) await type(view, text);
    expect(asked.map((request) => request.query)).toEqual(["", ...texts]);

    for (const index of order) {
      await settle(() => asked[index + 1]!.answer(cardsOf(texts[index]!)));
      const expected = index === texts.length - 1 ? ["metal 1", "metal 2"] : null;
      // Before the answer to «metal» lands, the field shows no other text's
      // answer either: nothing older replaces the rows.
      if (expected) expect(shownNames()).toEqual(expected);
      else expect(shownNames().every((name) => name.startsWith("metal"))).toBe(true);
    }
    expect(shownNames()).toEqual(["metal 1", "metal 2"]);
    expect(document.querySelector("[data-search-overlay-result-count]")).toHaveTextContent("2");
  });

  it("keeps the earlier rows while the next text's answer is on its way, and shows it at once", async () => {
    const view = render(<SearchOverlay {...props} query="" />);
    await type(view, "me");
    await settle(() => asked[1]!.answer(cardsOf("me")));
    await type(view, "met");
    expect(shownNames()).toEqual(["me 1", "me 2"]);
    await settle(() => asked[2]!.answer(cardsOf("met")));
    expect(shownNames()).toEqual(["met 1", "met 2"]);
  });

  it("never shows an earlier asking of the same text over a later one", async () => {
    const view = render(<SearchOverlay {...props} query="" />);
    await type(view, "metal");
    await type(view, "me");
    await type(view, "metal");
    expect(asked.map((request) => request.query)).toEqual(["", "metal", "me", "metal"]);

    await settle(() => asked[3]!.answer(cardsOf("metal", "later ")));
    expect(shownNames()).toEqual(["metal later 1", "metal later 2"]);
    await settle(() => asked[1]!.answer(cardsOf("metal", "earlier ")));
    await settle(() => asked[2]!.answer(cardsOf("me")));
    expect(shownNames()).toEqual(["metal later 1", "metal later 2"]);
  });

  it("groups only the recent cards by date: a search answer on screen with the field emptied stays one list, and nothing of it is left behind", async () => {
    const dated = (id: number, slug: string, savedAt: string) => makeBlock(id, slug, { saved_at: savedAt });
    // In the order of relevance: the months go back and forth.
    const me = [
      dated(1, "MEK.txt", "2026-07-10T10:00:00Z"),
      dated(2, "mech", "2026-08-10T10:00:00Z"),
      dated(3, "meanswhile", "2026-07-11T10:00:00Z"),
      dated(4, "MetalUI", "2026-04-10T10:00:00Z"),
    ];
    const view = render(<SearchOverlay {...props} query="me" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 130));
    });
    await settle(() => asked[0]!.answer(me));
    expect(shownNames()).toEqual(["MEK.txt", "mech", "meanswhile", "MetalUI"]);

    // The field is emptied at once; the recent cards are on their way.
    view.rerender(<SearchOverlay {...props} query="" />);
    expect(document.querySelectorAll("[data-search-overlay-recent-label]")).toHaveLength(0);
    expect(shownNames()).toEqual(["MEK.txt", "mech", "meanswhile", "MetalUI"]);

    // «metal» is typed before they come: its answer alone is the list.
    await type(view, "metal");
    await settle(() => asked[1]!.answer([dated(9, "recent", "2026-11-17T10:00:00Z")]));
    await settle(() => asked[2]!.answer([me[3]!]));
    expect(shownNames()).toEqual(["MetalUI"]);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(document.querySelectorAll("[data-search-overlay-recent-label]")).toHaveLength(0);
  });

  it("keeps date sections whose label repeats apart, and leaves none behind", async () => {
    const view = render(<SearchOverlay {...props} query="" />);
    await settle(() => asked[0]!.answer([
      makeBlock(1, "one", { saved_at: "2026-07-10T10:00:00Z" }),
      makeBlock(2, "two", { saved_at: "2026-08-10T10:00:00Z" }),
      makeBlock(3, "three", { saved_at: "2026-07-11T10:00:00Z" }),
    ]));
    expect([...document.querySelectorAll("[data-search-overlay-recent-label]")].map((label) => label.textContent))
      .toEqual(["July", "August", "July"]);
    await type(view, "on");
    await settle(() => asked[1]!.answer([makeBlock(1, "one")]));
    expect(shownNames()).toEqual(["one"]);
    expect(document.querySelectorAll("[data-search-overlay-recent-label]")).toHaveLength(0);
  });

  it("shows nothing of a superseded search: an older one is dropped, the current one is asked again", async () => {
    const view = render(<SearchOverlay {...props} query="" />);
    await type(view, "me");
    await settle(() => asked[1]!.answer(cardsOf("me")));
    await type(view, "met");
    await type(view, "meta");

    // The backend stopped the older search: the rows stay as they were.
    await settle(() => asked[2]!.fail(superseded()));
    expect(shownNames()).toEqual(["me 1", "me 2"]);
    expect(document.querySelector("[data-search-overlay-error]")).toBeNull();

    // The current one was stopped too: an older request of the page reached
    // the backend after it. No error, the rows stay, the text is asked again.
    await settle(() => asked[3]!.fail(superseded()));
    expect(document.querySelector("[data-search-overlay-error]")).toBeNull();
    expect(shownNames()).toEqual(["me 1", "me 2"]);
    expect(asked.map((request) => request.query)).toEqual(["", "me", "met", "meta", "meta"]);

    await settle(() => asked[4]!.answer(cardsOf("meta")));
    expect(shownNames()).toEqual(["meta 1", "meta 2"]);
  });
});

/// The list scrolls as a macOS list does: only the person moves it, and the
/// arrows bring the row they moved to into view (SPEC_SEARCH_OVERLAY.md,
/// «Прокрутка списка»).
describe("SearchOverlay list scrolling", () => {
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);

  async function renderRows(count: number) {
    // Every answer is new rows, as every IPC answer is.
    listGridBlocksMock.mockImplementation(async () =>
      snapshot(Array.from({ length: count }, (_, index) => makeBlock(index + 1, `card ${index + 1}`))),
    );
    const view = renderOverlay({ query: "card" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(count));
    scrollIntoView.mockClear();
    return view;
  }

  it("never scrolls for the pointer or a silent refresh; the arrows scroll to the row they moved to", async () => {
    await renderRows(3);
    const options = () => screen.getAllByRole("option");

    fireEvent.pointerMove(options()[2]!, { clientX: 40, clientY: 90 });
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent(window, new Event("vault-refreshed"));
    await waitFor(() => expect(listGridBlocksMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent(window, new CustomEvent("block-deleted", { detail: { slug: "card 1" } }));
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getAllByRole("option")[0]);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  it("starts a new answer at the top of the list and keeps the place on a silent refresh", async () => {
    const { rerender, onQueryChange, onClose, onOpenBlock } = await renderRows(3);
    const listbox = screen.getByRole("listbox");

    listbox.scrollTop = 120;
    fireEvent(window, new Event("vault-refreshed"));
    await waitFor(() => expect(listGridBlocksMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listbox.scrollTop).toBe(120);

    rerender(
      <SearchOverlay open query="cards" vaultPath="/vault"
        onQueryChange={onQueryChange} onClose={onClose} onOpenBlock={onOpenBlock} />,
    );
    await waitFor(() => expect(listGridBlocksMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(listbox.scrollTop).toBe(0));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
