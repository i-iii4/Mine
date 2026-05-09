import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { Search } from "./Search";
import type { IndexedBlock } from "@/types";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

function block(id: number, title: string): IndexedBlock {
  return {
    id,
    slug: title.toLowerCase().replace(/ /g, "-"),
    card_kind: "media",
    block_type: "link",
    title,
    description: null,
    url: "https://example.com",
    media_file: null,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
    width: null,
    height: null,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    thumb_format: null,
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    tags: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <Search open={false} onClose={vi.fn()} onSelect={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders input when open", () => {
    render(<Search open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByPlaceholderText("Search blocks...")).toBeInTheDocument();
  });

  it("shows No results for unmatched search", async () => {
    mockInvoke.mockResolvedValue([]);
    render(<Search open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search blocks...");
    fireEvent.change(input, { target: { value: "nonexistent" } });
    await waitFor(() => {
      expect(screen.getByText("No results")).toBeInTheDocument();
    });
  });

  it("renders search results", async () => {
    mockInvoke.mockResolvedValue([block(1, "Result One"), block(2, "Result Two")]);
    render(<Search open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search blocks...");
    fireEvent.change(input, { target: { value: "result" } });
    await waitFor(() => {
      expect(screen.getByText("Result One")).toBeInTheDocument();
      expect(screen.getByText("Result Two")).toBeInTheDocument();
    });
  });

  it("shows card_kind badges instead of legacy block_type badges", async () => {
    mockInvoke.mockResolvedValue([
      { ...block(1, "Article Result"), card_kind: "article", block_type: "image" },
      { ...block(2, "Media Result"), card_kind: "media", block_type: "article" },
      { ...block(3, "Channel Result"), card_kind: "channel", block_type: "file" },
    ]);
    render(<Search open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search blocks...");
    fireEvent.change(input, { target: { value: "result" } });
    await waitFor(() => {
      expect(screen.getByText("ART")).toBeInTheDocument();
      expect(screen.getByText("MEDIA")).toBeInTheDocument();
      expect(screen.getByText("CH")).toBeInTheDocument();
    });
    expect(screen.queryByText("IMG")).not.toBeInTheDocument();
    expect(screen.queryByText("TXT")).not.toBeInTheDocument();
    expect(screen.queryByText("FILE")).not.toBeInTheDocument();
  });

  it("selects result on click", async () => {
    const b = block(1, "Clickable");
    mockInvoke.mockResolvedValue([b]);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<Search open={true} onClose={onClose} onSelect={onSelect} />);
    const input = screen.getByPlaceholderText("Search blocks...");
    fireEvent.change(input, { target: { value: "click" } });
    await waitFor(() => {
      expect(screen.getByText("Clickable")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Clickable"));
    expect(onSelect).toHaveBeenCalledWith(b);
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores stale responses after the query changes", async () => {
    vi.useFakeTimers();
    const slow = deferred<IndexedBlock[]>();
    const fastBlock = block(2, "Fast Result");

    mockInvoke.mockImplementation(async (_command, args) => {
      const query = (args as { query?: string } | undefined)?.query;
      if (query === "slow") {
        return slow.promise;
      }
      if (query === "fast") {
        return [fastBlock];
      }
      return [];
    });

    render(<Search open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search blocks...");

    fireEvent.change(input, { target: { value: "slow" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    fireEvent.change(input, { target: { value: "fast" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.getByText("Fast Result")).toBeInTheDocument();

    await act(async () => {
      slow.resolve([block(1, "Slow Result")]);
      await Promise.resolve();
    });

    expect(screen.queryByText("Slow Result")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
