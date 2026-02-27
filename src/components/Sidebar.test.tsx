import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Sidebar } from "./Sidebar";
import type { ChannelDto, TagCount } from "@/types";

function ch(tag: string, position: number, block_count = 3): ChannelDto {
  return {
    tag,
    title: tag.charAt(0).toUpperCase() + tag.slice(1),
    description: null,
    color: null,
    icon: null,
    position,
    created_at: "2026-01-01T00:00:00Z",
    block_count,
  };
}

const defaultProps = {
  channels: [ch("beta", 1, 5), ch("alpha", 0, 10)],
  tags: [
    { tag: "alpha", count: 10 },
    { tag: "beta", count: 5 },
    { tag: "gamma", count: 2 },
  ] as TagCount[],
  totalBlocks: 17,
  onSearchOpen: vi.fn(),
  onImportOpen: vi.fn(),
  onReorderChannels: vi.fn(),
};

function renderSidebar(props = defaultProps) {
  return render(
    <MemoryRouter>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  it("renders header", () => {
    renderSidebar();
    expect(screen.getByText("Local Arena")).toBeInTheDocument();
  });

  it("renders All link with total block count", () => {
    renderSidebar();
    const allLink = screen.getByRole("link", { name: /All/ });
    expect(allLink).toBeInTheDocument();
    expect(within(allLink).getByText("17")).toBeInTheDocument();
  });

  it("renders channels sorted by position", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    // "All" link is first, then "Alpha" (pos 0), then "Beta" (pos 1)
    expect(links[1]).toHaveTextContent("Alpha");
    expect(links[2]).toHaveTextContent("Beta");
  });

  it("renders unpromoted tags (not channels)", () => {
    renderSidebar();
    // "gamma" is a tag but not a channel, so it should appear
    expect(screen.getByRole("link", { name: /gamma/ })).toBeInTheDocument();
  });

  it("does not duplicate promoted tags in Tags section", () => {
    renderSidebar();
    // "alpha" and "beta" are channels, only "gamma" should be in tags
    // Count how many links have "gamma" text
    const gammaLinks = screen.getAllByRole("link").filter(
      (l) => l.textContent?.includes("gamma"),
    );
    expect(gammaLinks).toHaveLength(1);
  });

  it("renders search button with keyboard shortcut", () => {
    renderSidebar();
    expect(screen.getByRole("button", { name: /Search/ })).toBeInTheDocument();
  });

  it("renders import button", () => {
    renderSidebar();
    expect(
      screen.getByRole("button", { name: /Import from Are.na/ }),
    ).toBeInTheDocument();
  });

  it("channel items are draggable", () => {
    const { container } = renderSidebar();
    const draggables = container.querySelectorAll("[draggable='true']");
    expect(draggables.length).toBe(2);
  });

  it("hides Channels section when no channels", () => {
    renderSidebar({ ...defaultProps, channels: [] });
    expect(screen.queryByText("Channels")).not.toBeInTheDocument();
  });

  it("hides Tags section when no unpromoted tags", () => {
    const props = {
      ...defaultProps,
      tags: [
        { tag: "alpha", count: 10 },
        { tag: "beta", count: 5 },
      ] as TagCount[],
    };
    renderSidebar(props);
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
  });
});
