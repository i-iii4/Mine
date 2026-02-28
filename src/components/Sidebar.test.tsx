import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import type { TagCount } from "@/types";

function tag(name: string, count = 3): TagCount {
  return { tag: name, count };
}

const defaultProps = {
  orderedTags: [tag("alpha", 10), tag("beta", 5)],
  totalBlocks: 17,
  isCardDragging: false,
  onSearchOpen: vi.fn(),
  onImportOpen: vi.fn(),
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

  it("renders tags in provided order", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    // "All" link is first, then tags in orderedTags order
    expect(links[1]).toHaveTextContent("Alpha");
    expect(links[2]).toHaveTextContent("Beta");
  });

  it("does not render Tags section header", () => {
    renderSidebar();
    expect(screen.queryByText("Tags")).not.toBeInTheDocument();
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
});
