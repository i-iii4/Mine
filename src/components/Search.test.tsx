import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Search } from "./Search";
import type { IndexedBlock } from "@/types";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

function block(id: number, title: string): IndexedBlock {
  return {
    id,
    slug: title.toLowerCase().replace(/ /g, "-"),
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
    tags: [],
  };
}

describe("Search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
