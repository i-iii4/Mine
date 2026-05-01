import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import type { TagCount } from "@/types";
import {
  clearActiveMineTextSelectionDragPayload,
  MINE_TEXT_SELECTION_DRAG_TYPE,
  setActiveMineTextSelectionDragPayload,
  type MineTextSelectionDragPayload,
} from "@/lib/textSelectionDrag";

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

function sidebarTree(props = defaultProps) {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <DndContext>
          <Sidebar {...props} />
        </DndContext>
      </TooltipProvider>
    </MemoryRouter>
  );
}

function renderSidebar(props = defaultProps) {
  return render(sidebarTree(props));
}

function createMockDataTransfer(
  payload?: MineTextSelectionDragPayload,
): DataTransfer {
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "all",
    dropEffect: "none",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [] as unknown as DOMStringList,
    clearData: vi.fn((type?: string) => {
      if (type) {
        store.delete(type);
      } else {
        store.clear();
      }
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ""),
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
      const types = Array.from(store.keys()) as unknown as DOMStringList;
      Object.assign(types, { contains: (item: string) => store.has(item) });
      (dataTransfer as { types: DOMStringList }).types = types;
    }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
  if (payload) {
    dataTransfer.setData(MINE_TEXT_SELECTION_DRAG_TYPE, JSON.stringify(payload));
  }
  return dataTransfer;
}

describe("Sidebar", () => {
  beforeEach(() => {
    clearActiveMineTextSelectionDragPayload();
  });

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

  it("keeps sidebar row action targets at row-control size", () => {
    const { container } = renderSidebar();

    container.querySelectorAll("[data-sidebar-tag-menu-trigger]").forEach((trigger) => {
      expect(trigger).toHaveClass("size-8");
    });
  });

  it("accepts native selected-text drops on tag rows", () => {
    const onTextSelectionDrop = vi.fn();
    renderSidebar({
      ...defaultProps,
      onTextSelectionDrop,
    });
    const alphaLink = screen.getByRole("link", { name: /Alpha/ });
    const alphaRow = alphaLink.parentElement!;
    const payload: MineTextSelectionDragPayload = {
      type: "text_selection",
      sourceSlug: "source-card",
      selectedText: "selected text",
      firstBlockStart: 0,
      firstBlockEnd: 25,
      sourceBodyHash: "body-hash",
      title: "selected text",
    };
    const dataTransfer = createMockDataTransfer(payload);

    fireEvent.dragOver(alphaRow, { dataTransfer });
    expect(alphaRow).toHaveClass("ring-2");

    fireEvent.drop(alphaRow, { dataTransfer });
    expect(onTextSelectionDrop).toHaveBeenCalledWith(payload, "alpha");
  });

  it("accepts selected-text drops when WebKit hides the custom MIME during dragover", () => {
    const onTextSelectionDrop = vi.fn();
    renderSidebar({
      ...defaultProps,
      onTextSelectionDrop,
    });
    const alphaLink = screen.getByRole("link", { name: /Alpha/ });
    const alphaRow = alphaLink.parentElement!;
    const payload: MineTextSelectionDragPayload = {
      type: "text_selection",
      sourceSlug: "source-card",
      selectedText: "selected text",
      firstBlockStart: 0,
      firstBlockEnd: 25,
      sourceBodyHash: "body-hash",
      title: "selected text",
    };
    setActiveMineTextSelectionDragPayload(payload);
    const dataTransfer = createMockDataTransfer();

    fireEvent.dragOver(alphaRow, { dataTransfer });
    expect(alphaRow).toHaveClass("ring-2");

    fireEvent.drop(alphaRow, { dataTransfer });
    expect(onTextSelectionDrop).toHaveBeenCalledWith(payload, "alpha");
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

    expect(screen.getByRole("link", { name: /Everything/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Everything/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connected" })).toBeInTheDocument();
    expect(screen.getByText("10")).toHaveClass("opacity-0");
    expect(screen.getByText("5")).not.toHaveClass("opacity-0");
    expect(screen.getByRole("checkbox", { name: /Remove from Alpha/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Remove from Alpha/ }).parentElement).toHaveClass("opacity-100");
    expect(screen.getByRole("checkbox", { name: /Remove from Alpha/ }).parentElement).toHaveClass("pointer-events-auto");
    expect(screen.getByRole("checkbox", { name: /Remove from Alpha/ }).parentElement?.parentElement).toHaveClass("h-8");
    expect(screen.getByRole("checkbox", { name: /Remove from Alpha/ }).parentElement?.parentElement).toHaveClass("w-8");
    expect(screen.getByRole("checkbox", { name: /Add to Beta/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Add to Beta/ }).parentElement).toHaveClass("opacity-0");
    expect(screen.getByRole("checkbox", { name: /Add to Beta/ }).parentElement).toHaveClass("pointer-events-none");

    fireEvent.click(screen.getByRole("checkbox", { name: /Remove from Alpha/ }).parentElement!);
    expect(onToggleLinkedTag).toHaveBeenCalledWith("open-block", "alpha", true);
    expect(onNavClick).not.toHaveBeenCalled();
    onToggleLinkedTag.mockClear();

    fireEvent.click(screen.getByRole("link", { name: /Beta/ }));
    expect(onNavClick).toHaveBeenCalledOnce();
    expect(onToggleLinkedTag).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Add to Beta/ }));
    expect(onToggleLinkedTag).toHaveBeenCalledWith("open-block", "beta", false);
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
