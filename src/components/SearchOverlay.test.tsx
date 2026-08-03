import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  ReadOnlyCardPreview: ({ block, previewMode }: { block: LightBlock; previewMode?: string }) => (
    <div data-testid="overlay-preview" data-preview-mode={previewMode}>{block.slug}</div>
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
    renderOverlay({ scrollEdgeFade: true });

    const list = document.getElementById("search-overlay-listbox") as HTMLElement;
    expect(list).toBeTruthy();
    expect(list.dataset.searchResultsTopFade).toBeUndefined();
    const resting = document.querySelector('[data-top-fade-scrim="search"]') as HTMLElement;
    expect(resting.style.opacity).toBe("0");
  });

  it("dissolves the results list once it is scrolled", () => {
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
    expect(screen.getByText("Title fresh")).toBeInTheDocument();
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
      expect(screen.getByText("Title alpha")).toBeInTheDocument();
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
      expect(screen.queryByText("Title alpha")).not.toBeInTheDocument();
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

    await screen.findByText("Title recent");
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
    expect(screen.getByTestId("overlay-preview")).toHaveAttribute("data-preview-mode", "micro");
    const metadata = within(
      document.querySelector("[data-search-overlay-metadata]") as HTMLElement,
    );
    expect(metadata.getByText("Date")).toBeInTheDocument();
    expect(metadata.getByText("Type")).toBeInTheDocument();
    expect(metadata.getByText("Article")).toBeInTheDocument();
    expect(metadata.getByText("example.com")).toBeInTheDocument();
    expect(metadata.getByText("Author")).toBeInTheDocument();
    expect(metadata.getByText("@author")).toBeInTheDocument();
    await waitFor(() => {
      expect(metadata.getByText("Collections")).toBeInTheDocument();
    });
    expect(metadata.getByText("design, reading")).toBeInTheDocument();
    // Hover actions live on the card preview, like the main-page hover menu.
    const preview = within(
      document.querySelector("[data-search-overlay-preview]") as HTMLElement,
    );
    expect(preview.getByRole("button", { name: /Source/ })).toBeInTheDocument();
    expect(preview.getByRole("button", { name: /Connect/ })).toBeInTheDocument();
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

  it("hover actions open the source url; blocks without url render no Source button", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([
      makeBlock(1, "with-url", { url: "https://example.com/article" }),
      makeBlock(2, "no-url", { url: null }),
    ]));
    renderOverlay({ query: "al" });
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/article");
    expect(screen.getByRole("button", { name: /Connect/ })).toBeInTheDocument();
    // The real CardHoverMenu contract: wrapper + More (⋯) + Source + Connect.
    const preview = within(
      document.querySelector("[data-search-overlay-preview]") as HTMLElement,
    );
    expect(preview.getAllByRole("button")).toHaveLength(3);
    expect(
      document.querySelector("[data-card-hover-bottom-actions]"),
    ).not.toBeNull();

    // Move to the block without url — Source disappears, Connect stays.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.queryByRole("button", { name: /Source/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect/ })).toBeInTheDocument();
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

  it("Connect toggle updates the Collections row optimistically", async () => {
    listGridBlocksMock.mockResolvedValue(snapshot([makeBlock(1, "alpha")]));
    const loadBlockTags = vi.fn(async () => new Map([["alpha", ["reading"]]]));
    const onToggleTag = vi.fn();
    renderOverlay({ query: "alpha", loadBlockTags, onToggleTag });

    await waitFor(() => {
      expect(screen.getByText("reading")).toBeInTheDocument();
    });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Connect/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByTestId("picker-toggle-design"));

    expect(onToggleTag).toHaveBeenCalledWith("alpha", "design", false);
    await waitFor(() => {
      expect(screen.getByText("reading, design")).toBeInTheDocument();
    });
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
    expect(screen.queryByText("Title alpha")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Title beta")).not.toBeInTheDocument();
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
