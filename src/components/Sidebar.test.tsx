import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { Sidebar } from "./Sidebar";
import type { TagCount } from "@/types";

function tag(name: string, count = 3): TagCount {
  return { tag: name, count };
}

const defaultProps = {
  tags: [tag("beta", 5), tag("alpha", 10)],
  totalBlocks: 17,
  onSearchOpen: vi.fn(),
  onImportOpen: vi.fn(),
  onDeleteTag: vi.fn(),
  onRenameTag: vi.fn(),
};

function renderSidebar(props = defaultProps) {
  return render(
    <MemoryRouter>
      <DndContext>
        <Sidebar {...props} />
      </DndContext>
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

  it("renders tags sorted alphabetically", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    // "All" link is first, then "Alpha" (a < b), then "Beta"
    expect(links[1]).toHaveTextContent("Alpha");
    expect(links[2]).toHaveTextContent("Beta");
  });

  it("renders Tags section header", () => {
    renderSidebar();
    expect(screen.getByText("Tags")).toBeInTheDocument();
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

  it("tag items are not draggable", () => {
    const { container } = renderSidebar();
    const draggables = container.querySelectorAll("[draggable='true']");
    expect(draggables.length).toBe(0);
  });

  it("shows Tags header even when no tags", () => {
    renderSidebar({ ...defaultProps, tags: [] });
    expect(screen.getByText("Tags")).toBeInTheDocument();
  });

  it("does not show create button (tags created via context menu)", () => {
    renderSidebar();
    expect(
      screen.queryByRole("button", { name: /Create/ }),
    ).not.toBeInTheDocument();
  });
});
