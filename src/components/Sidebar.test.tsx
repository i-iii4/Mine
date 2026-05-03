import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  isDropDragging: false,
  isCreatingChannel: false,
  onSetCreatingChannel: vi.fn(),
  onDeleteTag: vi.fn(),
  onRenameTag: vi.fn(),
  onCreateChannel: vi.fn(),
};

function sidebarTree(props = defaultProps, initialEntries = ["/"]) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider>
        <DndContext>
          <Sidebar {...props} />
        </DndContext>
      </TooltipProvider>
    </MemoryRouter>
  );
}

function renderSidebar(props = defaultProps, initialEntries = ["/"]) {
  return render(sidebarTree(props, initialEntries));
}

describe("Sidebar", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("aligns full sidebar rows to the navigation edges with monospace counts", () => {
    renderSidebar({ ...defaultProps, width: 600 });

    const everythingLink = screen.getByRole("link", { name: /Everything/ });
    expect(everythingLink).not.toHaveClass("px-3");
    expect(screen.getByText("Everything")).toHaveClass("translate-x-px");
    expect(screen.getByText("17")).toHaveClass("font-mono");
    expect(screen.getByText("17")).toHaveClass("-translate-x-px");
    expect(screen.getByText("10")).toHaveClass("font-mono");
    expect(screen.getByText("10")).toHaveClass("-translate-x-px");
  });

  it("uses foreground rows by default and activates row focus mode without background highlight", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 600 }, ["/channel/alpha"]);

    const everythingLink = screen.getByRole("link", { name: /Everything/ });
    expect(everythingLink).not.toHaveClass("bg-sidebar-accent");
    expect(everythingLink).not.toHaveClass("text-sidebar-accent-foreground");
    expect(everythingLink).not.toHaveClass("hover:bg-accent");
    expect(everythingLink).not.toHaveClass("hover:bg-sidebar-accent");
    expect(everythingLink).toHaveClass("text-foreground");
    expect(screen.getByText("17")).toHaveClass("text-foreground");

    const alphaLink = screen.getByRole("link", { name: /Alpha/ });
    expect(alphaLink).not.toHaveClass("bg-sidebar-accent");
    expect(alphaLink).not.toHaveClass("text-sidebar-accent-foreground");
    expect(alphaLink).not.toHaveClass("hover:bg-accent");
    expect(alphaLink).not.toHaveClass("hover:bg-sidebar-accent");
    expect(alphaLink).toHaveClass("text-foreground");
    expect(screen.getByText("10")).toHaveClass("text-foreground");

    const betaLink = screen.getByRole("link", { name: /Beta/ });
    expect(betaLink).not.toHaveClass("hover:bg-accent");
    expect(betaLink).not.toHaveClass("hover:bg-sidebar-accent");
    expect(betaLink).toHaveClass("text-foreground");
    expect(screen.getByText("5")).toHaveClass("text-foreground");

    const nav = container.querySelector("[data-sidebar-scroll]")!;
    const alphaRow = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
    const betaRow = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;
    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");

    fireEvent.pointerMove(alphaRow);
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-focused");

    fireEvent.pointerMove(betaRow);
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(nav).toHaveAttribute("data-sidebar-row-switching", "true");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");
    expect(betaRow).toHaveAttribute("data-sidebar-row-focused", "true");

    fireEvent.pointerLeave(nav);
    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(nav).not.toHaveAttribute("data-sidebar-row-switching");
  });

  it("does not replace sidebar counts with a hover ellipsis menu", () => {
    const { container } = renderSidebar();

    expect(container.querySelector("[data-sidebar-tag-menu-trigger]")).not.toBeInTheDocument();
    expect(screen.getByText("10")).not.toHaveClass("group-hover:opacity-0");
  });

  it("does not treat native selected-text drops as Mine card creation", () => {
    const onTextSelectionDrop = vi.fn();
    renderSidebar({
      ...defaultProps,
      onTextSelectionDrop,
    });
    const alphaLink = screen.getByRole("link", { name: /Alpha/ });
    const alphaRow = alphaLink.parentElement!;

    fireEvent.dragOver(alphaRow);
    expect(alphaRow).not.toHaveClass("ring-2");

    fireEvent.drop(alphaRow);
    expect(onTextSelectionDrop).not.toHaveBeenCalled();
  });

  it("keeps the main sidebar top inset on the scroll container without a fixed empty header slot", () => {
    function EmptySlot() {
      return null;
    }

    const { container } = renderSidebar({
      ...defaultProps,
      headerSlot: <EmptySlot />,
    });

    const nav = container.querySelector("[data-sidebar-scroll]");
    expect(nav).toHaveClass("pt-20");
    expect(container.querySelector("aside")?.firstElementChild).toBe(nav);
  });

  it("applies collapsed width via style", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 0, collapsed: true });
    const aside = container.querySelector("aside");
    expect(aside).toHaveStyle({ width: "var(--sidebar-width)" });
  });

  it("renders link editor when a block is open", async () => {
    const onToggleLinkedTag = vi.fn();
    const onNavClick = vi.fn();
    renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag,
      onNavClick,
    });

    expect(screen.getByRole("link", { name: /Everything/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Everything/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connected" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const actions = screen.getAllByRole("button", { name: /Connect|Disconnect/ });
    const alphaAction = actions.find((button) => button.getAttribute("aria-label") === "Disconnect Alpha")!;
    const betaAction = actions.find((button) => button.getAttribute("aria-label") === "Connect Beta")!;

    await waitFor(() => {
      expect(screen.getByText("10")).toHaveClass("opacity-0");
      expect(alphaAction).toHaveClass("opacity-100");
    });
    expect(alphaAction).toHaveTextContent("Connected");
    expect(alphaAction).toHaveClass("w-[10ch]");
    expect(alphaAction).toHaveClass("absolute");
    expect(alphaAction).toHaveClass("right-0");
    expect(alphaAction.closest("a")).toBeNull();
    expect(screen.getByText("5")).not.toHaveClass("opacity-0");
    expect(betaAction).toHaveClass("opacity-0");
    expect(betaAction).toHaveClass("pointer-events-none");
    expect(alphaAction.querySelector(".text-destructive")).toHaveTextContent("Disconnect");

    fireEvent.click(alphaAction);
    expect(onToggleLinkedTag).toHaveBeenCalledWith("open-block", "alpha", true);
    expect(onNavClick).not.toHaveBeenCalled();
    onToggleLinkedTag.mockClear();

    fireEvent.click(screen.getByRole("link", { name: /Beta/ }));
    expect(onNavClick).toHaveBeenCalledOnce();
    expect(onToggleLinkedTag).not.toHaveBeenCalled();

    fireEvent.click(betaAction);
    expect(onToggleLinkedTag).toHaveBeenCalledWith("open-block", "beta", false);
  });

  it("removes link editor row actions immediately while detail chrome is closing", () => {
    renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
      detailChromeClosing: true,
    });

    expect(screen.queryByRole("button", { name: "Disconnect Alpha" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Beta" })).not.toBeInTheDocument();
    expect(screen.getByText("10")).not.toHaveClass("opacity-0");
    expect(screen.getByText("5")).not.toHaveClass("opacity-0");
  });

  it("keeps preview images mounted when switching to the open-card link editor", () => {
    const previews = new Map([
      ["alpha", [{ url: "asset://localhost/thumbs/alpha-a.jpg", text: false, hasThumb: true }]],
      ["beta", [{ url: "asset://localhost/thumbs/beta-a.jpg", text: false, hasThumb: true }]],
    ]);
    const props = {
      ...defaultProps,
      channelPreviews: previews,
    };
    const { container, rerender } = renderSidebar(props);
    const before = container.querySelector('img[src="asset://localhost/thumbs/alpha-a.jpg"]');

    rerender(sidebarTree({
      ...props,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    }));

    const after = container.querySelector('img[src="asset://localhost/thumbs/alpha-a.jpg"]');
    expect(after).toBe(before);
  });

  it("keeps sidebar thumbnail hover preview card disabled behind a feature flag", () => {
    const previews = new Map([
      ["alpha", [{
        url: "asset://localhost/thumbs/alpha-a.jpg",
        text: false,
        hasThumb: true,
        slug: "alpha-a",
      }]],
    ]);
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      channelPreviews: previews,
    });

    const thumbnail = container.querySelector("[data-sidebar-preview-thumbnail]");
    expect(thumbnail).toHaveAttribute("data-sidebar-preview-thumbnail", "placeholder");
    expect(thumbnail).not.toHaveClass("cursor-pointer");
    fireEvent.mouseEnter(thumbnail!);
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).not.toBeInTheDocument();
  });

  it("filters link editor to linked channels", () => {
    renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));

    expect(screen.getByText("Everything")).toBeInTheDocument();
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
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("detail-top-bar-enter");
    expect(
      container.querySelector("[data-sidebar-link-mode-bar] span[aria-hidden='true']"),
    ).toHaveClass("detail-top-bar-line-enter");
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
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("bg-accent/80");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("backdrop-blur-sm");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("backdrop-saturate-150");
    expect(container.querySelector("[data-sidebar-link-mode-pill]")).toHaveClass("detail-top-pill-enter");
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
