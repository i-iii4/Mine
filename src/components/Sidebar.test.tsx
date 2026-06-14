import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import type { IndexedBlock, TagCount } from "@/types";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
} from "@/lib/hoverPreviewTiming";

const dndContextState = vi.hoisted(() => ({
  over: null as { id: string } | null,
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDndContext: () => ({
      ...actual.useDndContext(),
      over: dndContextState.over,
    }),
  };
});

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

function previewBlock(slug: string, overrides: Partial<IndexedBlock> = {}): IndexedBlock {
  return {
    id: 101,
    slug,
    card_kind: "media",
    block_type: "image",
    title: null,
    content_heading: null,
    display_title: null,
    fallback_label: slug,
    description: null,
    url: null,
    media_file: `${slug}.jpg`,
    thumbnail: null,
    saved_at: "2026-01-01T00:00:00Z",
    source: null,
    width: 1200,
    height: 800,
    author: null,
    body: "",
    preview_text: null,
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    feed_playback: null,
    thumb_format: "jpeg",
    thumb_mtime: 0,
    related_notes: [],
    body_hash: null,
    origin: null,
    index_warning: null,
    tags: [],
    ...overrides,
  };
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dndContextState.over = null;
  });
  afterEach(() => vi.useRealTimers());

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
    expect(links[1]).toHaveTextContent("alpha");
    expect(links[2]).toHaveTextContent("beta");
  });

  it("hides Everything when sidebar search does not match it", () => {
    renderSidebar({ ...defaultProps, searchQuery: "alp" });

    expect(screen.queryByRole("link", { name: /Everything/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /beta/ })).not.toBeInTheDocument();
  });

  it("keeps Everything visible when sidebar search matches it", () => {
    renderSidebar({ ...defaultProps, searchQuery: "every" });

    expect(screen.getByRole("link", { name: /Everything/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /alpha/ })).not.toBeInTheDocument();
  });

  it("renders the new-channel row outside the guided channel grid", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 600 });

    const button = screen.getByRole("button", { name: "Create New Collection" });
    const row = button.closest("[data-sidebar-new-channel-row]") as HTMLElement;
    expect(row).toHaveAttribute("data-sidebar-new-channel-row", "");
    expect(row).toHaveAttribute("data-sidebar-row", "");
    expect(row).toHaveAttribute("data-sidebar-row-key", "create-channel");
    expect(row.closest("[data-sidebar-rows]")).toBeNull();
    expect(row).not.toHaveAttribute("data-sidebar-row-surface");
    expect(container.querySelector("[data-sidebar-rows]")).toBeInTheDocument();
    const label = within(row).getByText("Create New Collection");
    expect(label).toHaveAttribute("data-sidebar-row-text", "");
    expect(label).not.toHaveAttribute("data-sidebar-title-fade-width");
    expect(label).not.toHaveClass("max-w-[150px]");
    expect(label).toHaveClass("shrink-0");
    expect(label.nextElementSibling).toHaveAttribute("data-sidebar-create-channel-plus", "");
    expect(label.nextElementSibling).toHaveClass("ml-2");
    expect(row.querySelector("[data-sidebar-empty-preview-rail]")).not.toBeInTheDocument();
  });

  it("starts and submits new-channel creation inline", () => {
    const onSetCreatingChannel = vi.fn();
    const onCreateChannel = vi.fn();
    const { container, rerender } = renderSidebar({
      ...defaultProps,
      width: 600,
      onSetCreatingChannel,
      onCreateChannel,
    });

    fireEvent.click(screen.getByRole("button", { name: "Create New Collection" }));
    expect(onSetCreatingChannel).toHaveBeenCalledWith(true);

    rerender(sidebarTree({
      ...defaultProps,
      width: 600,
      isCreatingChannel: true,
      onSetCreatingChannel,
      onCreateChannel,
    }));

    const input = screen.getByRole("textbox", { name: "Имя нового канала" });
    const createRow = input.closest("[data-sidebar-new-channel-row]");
    expect(input.closest("[data-sidebar-new-channel-row]")).toHaveAttribute(
      "data-sidebar-row-editing",
      "true",
    );
    expect(createRow).toHaveAttribute("data-sidebar-row-surface", "");
    expect(createRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(createRow?.querySelector("[data-sidebar-editable-row-full-width]")).toBeInTheDocument();
    expect(createRow?.querySelector("[data-sidebar-preview-rail]")).not.toBeInTheDocument();
    expect(createRow?.querySelector("[data-sidebar-empty-preview-rail]")).not.toBeInTheDocument();
    const createAction = within(createRow as HTMLElement).getByRole("button", {
      name: /Create\s+Enter/,
    });
    expect(createAction).toHaveAttribute("data-sidebar-inline-submit-action", "");
    expect(createAction).toHaveClass("bg-component-fill");
    expect(createAction).toHaveClass("hover:outline-component-fill-hover");
    expect(createAction).toHaveTextContent("Create");
    expect(within(createAction).getByText("Enter")).toHaveAttribute(
      "data-sidebar-inline-submit-shortcut",
      "",
    );
    expect(container.querySelector('[data-sidebar-row-key="tag:beta"]')).toHaveAttribute(
      "data-sidebar-row-seam-accent",
      "true",
    );
    expect(input).toHaveAttribute("data-sidebar-inline-channel-editor", "");
    expect(input).toHaveClass("border-0");
    expect(input).toHaveClass("bg-transparent");
    expect(input).toHaveClass("p-0");

    fireEvent.change(input, { target: { value: "Archive" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateChannel).toHaveBeenCalledWith("Archive");
    expect(onSetCreatingChannel).toHaveBeenCalledWith(false);
  });

  it("submits new-channel creation from the right-edge Create action", () => {
    const onSetCreatingChannel = vi.fn();
    const onCreateChannel = vi.fn();
    renderSidebar({
      ...defaultProps,
      width: 600,
      isCreatingChannel: true,
      onSetCreatingChannel,
      onCreateChannel,
    });

    const input = screen.getByRole("textbox", { name: "Имя нового канала" });
    const row = input.closest("[data-sidebar-new-channel-row]") as HTMLElement;
    const createAction = within(row).getByRole("button", { name: /Create\s+Enter/ });

    fireEvent.change(input, { target: { value: "Research" } });
    fireEvent.click(createAction);

    expect(onCreateChannel).toHaveBeenCalledWith("Research");
    expect(onSetCreatingChannel).toHaveBeenCalledWith(false);
  });

  it("renames a channel with an inline editor without replacing row geometry", () => {
    const onRenameTag = vi.fn();
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      onRenameTag,
    });

    fireEvent.doubleClick(screen.getByRole("link", { name: /alpha/ }));

    const row = container.querySelector('[data-sidebar-row-key="tag:alpha"]') as HTMLElement;
    expect(row).toHaveAttribute("data-sidebar-row-surface", "");
    expect(row).toHaveAttribute("data-sidebar-row-editing", "true");
    expect(row).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(container.querySelector('[data-sidebar-row-key="all"]')).toHaveAttribute(
      "data-sidebar-row-seam-accent",
      "true",
    );
    expect(row.querySelector("[data-sidebar-editable-row-full-width]")).toBeInTheDocument();
    expect(row.querySelector("[data-sidebar-preview-rail]")).not.toBeInTheDocument();
    expect(row.querySelector("[data-sidebar-row-text]")).not.toBeInTheDocument();

    const input = within(row).getByRole("textbox", { name: "Переименовать alpha" });
    expect(input).toHaveAttribute("data-sidebar-inline-channel-editor", "");
    expect(input).toHaveClass("border-0");
    expect(input).toHaveClass("bg-transparent");
    expect(input).toHaveClass("p-0");

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRenameTag).toHaveBeenCalledWith("alpha", "Renamed");
  });

  it("uses the row hover seam when card content is dragged over Create New Collection", () => {
    dndContextState.over = { id: "create-channel" };
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      isDropDragging: true,
    });

    const createRow = container.querySelector("[data-sidebar-new-channel-row]") as HTMLElement;
    expect(createRow).toHaveAttribute("data-sidebar-row-key", "create-channel");
    expect(createRow).toHaveAttribute("data-sidebar-row-focused", "true");
    expect(container.querySelector('[data-sidebar-row-key="tag:beta"]')).toHaveAttribute(
      "data-sidebar-row-seam-accent",
      "true",
    );
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

  it("keeps rows muted by default while selected and focused rows use the bright sidebar state", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 600 }, ["/channel/alpha"]);

    const everythingLink = screen.getByRole("link", { name: /Everything/ });
    const everythingRow = container.querySelector('[data-sidebar-row-key="all"]')!;
    expect(everythingLink).not.toHaveClass("bg-sidebar-accent");
    expect(everythingLink).not.toHaveClass("text-sidebar-accent-foreground");
    expect(everythingLink).not.toHaveClass("hover:bg-accent");
    expect(everythingLink).not.toHaveClass("hover:bg-sidebar-accent");
    expect(everythingRow).toHaveAttribute("data-sidebar-row-surface", "");
    expect(everythingLink).toHaveClass("text-muted-foreground");
    expect(screen.getByText("17")).toHaveClass("text-muted-foreground");

    const alphaLink = screen.getByRole("link", { name: /alpha/ });
    expect(alphaLink).not.toHaveClass("bg-sidebar-accent");
    expect(alphaLink).not.toHaveClass("text-sidebar-accent-foreground");
    expect(alphaLink).not.toHaveClass("hover:bg-accent");
    expect(alphaLink).not.toHaveClass("hover:bg-sidebar-accent");
    expect(alphaLink).toHaveClass("text-muted-foreground");
    expect(screen.getByText("10")).toHaveClass("text-muted-foreground");

    const betaLink = screen.getByRole("link", { name: /beta/ });
    expect(betaLink).not.toHaveClass("hover:bg-accent");
    expect(betaLink).not.toHaveClass("hover:bg-sidebar-accent");
    expect(betaLink).toHaveClass("text-muted-foreground");
    expect(screen.getByText("5")).toHaveClass("text-muted-foreground");

    const nav = container.querySelector("[data-sidebar-scroll]")!;
    const allRow = everythingRow;
    const alphaRow = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
    const betaRow = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;
    expect(alphaRow).toHaveAttribute("data-sidebar-row-surface", "");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-active", "true");
    expect(allRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");

    fireEvent.pointerMove(alphaRow);
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(allRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-focused");

    fireEvent.pointerMove(betaRow);
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(nav).toHaveAttribute("data-sidebar-row-switching", "true");
    expect(allRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(betaRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");
    expect(betaRow).toHaveAttribute("data-sidebar-row-focused", "true");

    fireEvent.pointerLeave(nav);
    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(nav).not.toHaveAttribute("data-sidebar-row-switching");
    expect(allRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
  });

  it("holds keyboard channel focus mode until one second after the last switch", () => {
    vi.useFakeTimers();
    const props = { ...defaultProps, width: 600 };
    const { container, rerender } = renderSidebar({
      ...props,
      keyboardNavigationFocus: { rowKey: "tag:alpha", sequence: 1 },
    }, ["/channel/alpha"]);

    const nav = container.querySelector("[data-sidebar-scroll]")!;
    const alphaRow = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
    const betaRow = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");

    act(() => vi.advanceTimersByTime(900));
    rerender(sidebarTree({
      ...props,
      keyboardNavigationFocus: { rowKey: "tag:beta", sequence: 2 },
    }, ["/channel/beta"]));

    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(nav).toHaveAttribute("data-sidebar-row-switching", "true");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");
    expect(betaRow).toHaveAttribute("data-sidebar-row-focused", "true");

    act(() => vi.advanceTimersByTime(999));
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");

    act(() => vi.advanceTimersByTime(1));
    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-focused");
  });

  it("keeps sidebar search keyboard focus persistent until App clears it", () => {
    vi.useFakeTimers();
    const props = { ...defaultProps, width: 600 };
    const { container, rerender } = renderSidebar({
      ...props,
      keyboardNavigationFocus: { rowKey: "tag:alpha", sequence: 1 },
      keyboardNavigationFocusPersistent: true,
    }, ["/"]);

    const nav = container.querySelector("[data-sidebar-scroll]")!;
    const alphaRow = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;

    expect(alphaRow).toHaveAttribute("id", "sidebar-row-tag%3Aalpha");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");

    act(() => vi.advanceTimersByTime(2000));
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");

    rerender(sidebarTree({
      ...props,
      keyboardNavigationFocus: null,
      keyboardNavigationFocusPersistent: false,
    }, ["/"]));

    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");
  });

  it("uses the normal row hover state for card drag-over targets", () => {
    dndContextState.over = { id: "tag:alpha" };
    const { container } = renderSidebar({ ...defaultProps, width: 600, isDropDragging: true });

    const nav = container.querySelector("[data-sidebar-scroll]")!;
    const allRow = container.querySelector('[data-sidebar-row-key="all"]')!;
    const alphaRow = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
    const betaRow = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;

    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");
    expect(allRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-focused");
    expect(alphaRow).not.toHaveClass("ring-2");
    expect(alphaRow).not.toHaveClass("ring-ring");
    expect(alphaRow).not.toHaveClass("ring-inset");
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
    const alphaLink = screen.getByRole("link", { name: /alpha/ });
    const alphaRow = alphaLink.parentElement!;

    fireEvent.dragOver(alphaRow);
    expect(alphaRow).not.toHaveClass("ring-2");

    fireEvent.drop(alphaRow);
    expect(onTextSelectionDrop).not.toHaveBeenCalled();
  });

  it("keeps the main sidebar inset on the scroll container without a fixed empty header slot", () => {
    function EmptySlot() {
      return null;
    }

    const { container } = renderSidebar({
      ...defaultProps,
      headerSlot: <EmptySlot />,
    });

    const nav = container.querySelector("[data-sidebar-scroll]");
    expect(nav).toHaveClass("pt-8");
    expect(nav).toHaveClass("pb-8");
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
    const { container } = renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag,
      onNavClick,
    });

    expect(screen.getByRole("link", { name: /Everything/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Everything/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Connected" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(container.querySelector("[data-sidebar-scroll]")).toHaveAttribute(
      "data-sidebar-link-editor-mode",
      "true",
    );
    expect(container.querySelector('[data-sidebar-row-key="tag:alpha"]')).toHaveAttribute(
      "data-sidebar-row-linked",
      "true",
    );
    expect(container.querySelector('[data-sidebar-row-key="tag:alpha"]')).not.toHaveAttribute(
      "data-sidebar-row-seam-accent",
    );
    expect(container.querySelector('[data-sidebar-row-key="tag:beta"]')).not.toHaveAttribute(
      "data-sidebar-row-linked",
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const actions = screen.getAllByRole("button", { name: /Connect|Disconnect/ });
    const alphaAction = actions.find((button) => button.getAttribute("aria-label") === "Disconnect alpha")!;
    const betaAction = actions.find((button) => button.getAttribute("aria-label") === "Connect beta")!;

    await waitFor(() => {
      expect(screen.getByText("10")).toHaveClass("opacity-0");
      expect(alphaAction).toHaveClass("opacity-100");
    });
    expect(alphaAction).toHaveTextContent("Connected");
    expect(alphaAction).toHaveClass("w-[10ch]");
    expect(alphaAction).toHaveClass("absolute");
    expect(alphaAction).toHaveClass("right-[var(--sidebar-row-pad-x)]");
    expect(alphaAction.closest("a")).toBeNull();
    expect(screen.getByText("5")).not.toHaveClass("opacity-0");
    expect(betaAction).toHaveClass("opacity-0");
    expect(betaAction).toHaveClass("pointer-events-none");
    expect(alphaAction.querySelector(".text-detach")).toHaveTextContent("Disconnect");

    fireEvent.click(alphaAction);
    expect(onToggleLinkedTag).toHaveBeenCalledWith("open-block", "alpha", true);
    expect(onNavClick).not.toHaveBeenCalled();
    onToggleLinkedTag.mockClear();

    fireEvent.click(screen.getByRole("link", { name: /beta/ }));
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

    expect(screen.queryByRole("button", { name: "Disconnect alpha" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect beta" })).not.toBeInTheDocument();
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

  it("does not render empty preview tiles for items without thumb metadata", () => {
    const previews = new Map([
      ["alpha", [
        {
          url: "asset://localhost/thumbs/missing.jpg",
          text: false,
          hasThumb: false,
          slug: "missing",
        },
        {
          url: "asset://localhost/thumbs/ready.jpg",
          text: false,
          hasThumb: true,
          slug: "ready",
        },
      ]],
    ]);

    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      channelPreviews: previews,
    });

    expect(container.querySelector('img[src="asset://localhost/thumbs/missing.jpg"]')).toBeNull();
    expect(container.querySelector('img[src="asset://localhost/thumbs/ready.jpg"]')).toBeInTheDocument();
    expect(container.querySelectorAll("[data-sidebar-preview-thumbnail]")).toHaveLength(1);
  });

  it("shows a non-interactive sidebar preview only while the thumbnail is hovered", async () => {
    vi.useFakeTimers();
    const compositeManifest = JSON.stringify({
      kind: "composite",
      primary_preview_path: "alpha-a.jpg",
      width: 1,
      height: 1,
      tiles: [
        {
          source_path: "alpha-a-img1.jpg",
          preview_path: null,
          width: 900,
          height: 1200,
          is_video: false,
          is_video_poster: false,
        },
        {
          source_path: "alpha-a-img2.jpg",
          preview_path: null,
          width: 900,
          height: 1200,
          is_video: false,
          is_video_poster: false,
        },
        {
          source_path: "alpha-a-img3.jpg",
          preview_path: null,
          width: 900,
          height: 1200,
          is_video: false,
          is_video_poster: false,
        },
      ],
      overflow_count: 0,
    });

    vi.mocked(invoke)
      .mockResolvedValueOnce(previewBlock("alpha-a", {
        card_kind: "article",
        block_type: "article",
        media_file: null,
        width: null,
        height: null,
        body: "Alpha text\n\n![[alpha-a-img1.jpg]]\n\n![[alpha-a-img2.jpg]]\n\n![[alpha-a-img3.jpg]]",
        preview_text: "Alpha preview text",
        first_image: "alpha-a-img1.jpg",
        media_urls: JSON.stringify(["alpha-a-img1.jpg", "alpha-a-img2.jpg", "alpha-a-img3.jpg"]),
        preview_manifest: compositeManifest,
        thumb_mtime: 123,
      }))
      .mockResolvedValueOnce(previewBlock("alpha-b"))
      .mockResolvedValueOnce(previewBlock("alpha-a"));
    const previews = new Map([
      ["alpha", [
        {
          url: "asset://localhost/thumbs/alpha-a.jpg",
          text: false,
          hasThumb: true,
          slug: "alpha-a",
        },
        {
          url: "asset://localhost/thumbs/alpha-b.jpg",
          text: false,
          hasThumb: true,
          slug: "alpha-b",
        },
      ]],
    ]);
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      vaultPath: "/vault",
      thumbsRootPath: "/vault/.arena/cache/thumbs",
      channelPreviews: previews,
    });

    const thumbnails = container.querySelectorAll('[data-sidebar-preview-thumbnail="trigger"]');
    const firstThumbnail = thumbnails[0];
    const secondThumbnail = thumbnails[1];
    expect(firstThumbnail).toHaveAttribute("data-sidebar-preview-thumbnail", "trigger");
    expect(firstThumbnail).toHaveClass("cursor-pointer");

    fireEvent.pointerEnter(firstThumbnail!);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    const hoverPreview = container.querySelector("[data-sidebar-thumbnail-hover-preview]");
    expect(hoverPreview).toBeInTheDocument();
    expect(hoverPreview).toHaveClass("pointer-events-none");
    expect(hoverPreview!.querySelector("button")).toBeNull();
    const hoverImages = hoverPreview!.querySelectorAll("img");
    expect(hoverImages).toHaveLength(1);
    expect(hoverImages[0]).toHaveAttribute(
      "src",
      "asset://localhost//vault/.arena/cache/thumbs/alpha-a.jpg?m=123",
    );
    expect(container.querySelector("[data-sidebar-thumbnail-hover-bridge]")).not.toBeInTheDocument();
    fireEvent.pointerLeave(container.querySelector("[data-sidebar-scroll]")!);
    expect(container.querySelector("[data-sidebar-scroll]")).toHaveAttribute(
      "data-sidebar-row-focus-mode",
      "true",
    );
    expect(container.querySelector('[data-sidebar-row-key="tag:alpha"]')).toHaveAttribute(
      "data-sidebar-row-focused",
      "true",
    );
    expect(firstThumbnail).toHaveAttribute("data-sidebar-preview-active", "true");
    expect(invoke).toHaveBeenCalledWith("get_block", { slug: "alpha-a" });

    fireEvent.pointerLeave(firstThumbnail!);
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).not.toBeInTheDocument();
    expect(firstThumbnail).not.toHaveAttribute("data-sidebar-preview-active");

    fireEvent.pointerEnter(secondThumbnail!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).toBeInTheDocument();
    expect(secondThumbnail).toHaveAttribute("data-sidebar-preview-active", "true");
    expect(invoke).toHaveBeenCalledWith("get_block", { slug: "alpha-b" });

    fireEvent.pointerLeave(secondThumbnail!);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_WARM_WINDOW_MS + 1);
      await Promise.resolve();
    });

    fireEvent.pointerEnter(firstThumbnail!);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).toBeInTheDocument();
    expect(firstThumbnail).toHaveAttribute("data-sidebar-preview-active", "true");
  });

  it("renders continuous sidebar guidelines and keeps the protected action area in row mode", () => {
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

    const row = container.querySelector('[data-sidebar-row-key="tag:alpha"]') as HTMLDivElement;
    const rows = container.querySelector("[data-sidebar-rows]") as HTMLDivElement;
    const title = row.querySelector("[data-sidebar-row-text]") as HTMLSpanElement;
    const rail = row.querySelector("[data-sidebar-preview-rail]") as HTMLDivElement;
    const strip = container.querySelector("[data-sidebar-thumbnail-strip]") as HTMLDivElement;
    const leftDivider = rows.querySelector('[data-sidebar-guideline="left"]') as HTMLSpanElement;
    const rightDivider = rows.querySelector('[data-sidebar-guideline="right"]') as HTMLSpanElement;

    expect(leftDivider).toHaveClass("bg-sidebar-border");
    expect(leftDivider).toHaveStyle({ left: "150px" });
    expect(title).toHaveAttribute("data-sidebar-title-fade-width", "24");
    expect(title).toHaveAttribute("data-sidebar-title-protected-width", "4");
    expect(title).toHaveClass("min-w-[100px]");
    expect(title).toHaveClass("max-w-[150px]");
    expect(title).toHaveClass("flex-1");
    expect(title).not.toHaveClass("truncate");
    expect(rail).toHaveStyle({ paddingLeft: "4px" });
    expect(rightDivider).toHaveClass("bg-sidebar-border");
    expect(rightDivider).toHaveStyle({ right: "88px" });
    expect(strip).toHaveAttribute("data-sidebar-preview-fade-width", "24");
    expect(strip).toHaveAttribute("data-sidebar-preview-protected-width", "92");
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
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.queryByText("beta")).not.toBeInTheDocument();
  });

  it("keeps link-editor chrome out of sidebar layout flow", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    });

    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("h-8");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("absolute");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("top-0");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("gap-2");
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toHaveClass("detail-top-bar-enter");
    expect(
      container.querySelector("[data-sidebar-link-mode-bar] span[aria-hidden='true']"),
    ).toHaveClass("detail-top-bar-line-enter");
    expect(screen.getByText("Collections:")).toHaveClass("text-muted-foreground");
    expect(screen.getByRole("button", { name: "Connected" })).toHaveClass("text-muted-foreground");
    expect(container.querySelector("[data-sidebar-scroll]")).toHaveClass("pt-8");
  });

  it("keeps link-editor chrome entered when switching the active detail block", async () => {
    const props = {
      ...defaultProps,
      linkedBlockSlug: "first-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    };

    const { container, rerender } = renderSidebar(props);

    const bar = container.querySelector("[data-sidebar-link-mode-bar]");
    expect(bar).not.toBeNull();
    await waitFor(() => {
      expect(bar).toHaveAttribute("data-entered", "true");
    });

    rerender(sidebarTree({
      ...props,
      linkedBlockSlug: "second-block",
      linkedTags: ["beta"],
    }));

    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toBe(bar);
    expect(bar).toHaveAttribute("data-entered", "true");
  });

});
