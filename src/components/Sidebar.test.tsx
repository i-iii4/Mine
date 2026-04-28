import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
  isCreatingChannel: false,
  onSetCreatingChannel: vi.fn(),
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
  it("renders Everything link with total block count", () => {
    renderSidebar();
    const everythingLink = screen.getByRole("link", { name: /Everything/ });
    expect(everythingLink).toBeInTheDocument();
    expect(everythingLink).toHaveTextContent("17");
  });

  it("renders tags in provided order", () => {
    renderSidebar();
    const links = screen.getAllByRole("link");
    // "Everything" link is first, then tags in orderedTags order
    expect(links[0]).toHaveTextContent("Everything");
    expect(links[1]).toHaveTextContent("Alpha");
    expect(links[2]).toHaveTextContent("Beta");
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
    expect(aside).toHaveStyle({ width: "var(--sidebar-width)" });
  });

  it("renders link editor when a block is open", () => {
    const onToggleLinkedTag = vi.fn();
    const onNavClick = vi.fn();
    renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag,
      onNavClick,
    });

    expect(screen.queryByRole("link", { name: /Everything/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connected" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Remove from Alpha/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Add to Beta/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Add to Beta/ })).toHaveClass("opacity-0");

    fireEvent.click(screen.getByRole("link", { name: /Beta/ }));
    expect(onNavClick).toHaveBeenCalledOnce();
    expect(onToggleLinkedTag).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Add to Beta/ }));
    expect(onToggleLinkedTag).toHaveBeenCalledWith("open-block", "beta", false);
  });

  it("filters link editor to linked channels", () => {
    renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("uses classic detail-menu geometry for the link editor", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
      detailTopMenuMode: "classic",
    });

    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("h-8");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("gap-2");
    expect(screen.getByText("Channels:")).toBeInTheDocument();
    expect(container.querySelector("[data-sidebar-scroll]")).toHaveClass("pt-12");
  });

  it("places the island link editor bar at the top with the floating surface", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
      detailTopMenuMode: "island",
    });

    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("absolute");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("top-4");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("pointer-events-none");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("justify-center");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("bg-transparent");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).not.toHaveClass("bottom-[18px]");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("h-8");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("w-fit");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("rounded-1");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("pointer-events-auto");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("bg-accent");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("gap-2");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("pl-3");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("pr-[2px]");
    expect(screen.getByText("Channels:")).toBeInTheDocument();
    expect(container.querySelector("[data-sidebar-link-mode-control]")).not.toHaveClass("hover:bg-component-fill-hover");
    expect(screen.getByRole("button", { name: "Connected" })).toHaveClass("hover:text-foreground");
    expect(container.querySelector("[data-sidebar-scroll]")).toHaveClass("pt-20");
    expect(container.querySelector("aside")?.lastElementChild).toBe(
      container.querySelector("[data-sidebar-link-mode-bar]"),
    );
  });

});
