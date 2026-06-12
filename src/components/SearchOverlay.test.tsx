import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GridSnapshot, LightBlock, SearchMatch } from "@/types";
import { SearchOverlay, SEARCH_OVERLAY_RESULT_LIMIT } from "./SearchOverlay";

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
}));

vi.mock("@/components/Card", () => ({
  ReadOnlyCardPreview: ({ block, previewMode }: { block: LightBlock; previewMode?: string }) => (
    <div data-testid="overlay-preview" data-preview-mode={previewMode}>{block.slug}</div>
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

function snapshot(blocks: LightBlock[], total = blocks.length): GridSnapshot {
  return { blocks, total_blocks: total, has_more: false };
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
});

describe("SearchOverlay", () => {
  it("renders the focused input and selects the previous query on open", () => {
    renderOverlay({ query: "previous query" });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("previous query".length);
  });

  it("does not query the backend while the query is empty", async () => {
    renderOverlay();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(listGridBlocksMock).not.toHaveBeenCalled();
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

  it("renders result rows, the count, and the preview of the active row", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta")], 42),
    );
    renderOverlay({ query: "alpha" });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("overlay-preview")).toHaveTextContent("alpha");
    // Each row carries the standard micro preview thumbnail.
    expect(screen.getAllByRole("option")[0]!.querySelector("img")).not.toBeNull();
  });

  it("moves the active row with arrows while focus stays in the input", async () => {
    listGridBlocksMock.mockResolvedValue(
      snapshot([makeBlock(1, "alpha"), makeBlock(2, "beta")]),
    );
    renderOverlay({ query: "a" });
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
    const { onOpenBlock } = renderOverlay({ query: "a" });
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
    listGridBlocksMock.mockResolvedValue(snapshot([]));
    renderOverlay({ query: "nothing" });
    await waitFor(() => {
      expect(screen.getByText("No results")).toBeInTheDocument();
    });
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
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Author")).toBeInTheDocument();
    expect(screen.getByText("@author")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Collections")).toBeInTheDocument();
    });
    expect(screen.getByText("design, reading")).toBeInTheDocument();
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
