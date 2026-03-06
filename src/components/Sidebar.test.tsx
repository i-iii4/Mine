import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import type { TagCount } from "@/types";

function tag(name: string, count = 3): TagCount {
  return { tag: name, count };
}

const defaultProps = {
  width: 300,
  collapsed: false,
  isResizing: false,
  orderedTags: [tag("alpha", 10), tag("beta", 5)],
  channelPreviews: new Map(),
  totalBlocks: 17,
  isCardDragging: false,
  onDeleteTag: vi.fn(),
  onRenameTag: vi.fn(),
  onCreateChannel: vi.fn(),
};

function renderSidebar(props = defaultProps) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <DndContext>
          <Sidebar {...props} />
        </DndContext>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  it("renders All link with total block count", () => {
    renderSidebar();
    const allLink = screen.getByRole("link", { name: /All/ });
    expect(allLink).toBeInTheDocument();
    expect(allLink).toHaveTextContent("17");
  });

  it("renders tags in provided order", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    // "All" link is first, then tags in orderedTags order
    expect(links[0]).toHaveTextContent("All");
    expect(links[1]).toHaveTextContent("Alpha");
    expect(links[2]).toHaveTextContent("Beta");
  });

  it("renders New channel button", () => {
    renderSidebar();
    expect(
      screen.getByRole("button", { name: /New channel/ }),
    ).toBeInTheDocument();
  });

  it("shows New channel button even when no tags", () => {
    renderSidebar({ ...defaultProps, orderedTags: [] });
    expect(
      screen.getByRole("button", { name: /New channel/ }),
    ).toBeInTheDocument();
  });

  it("renders tag counts", () => {
    renderSidebar();
    // Alpha has count 10, Beta has count 5
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("applies collapsed width via style", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 0, collapsed: true });
    const aside = container.querySelector("aside");
    expect(aside).toHaveStyle({ width: "0px" });
  });
});
