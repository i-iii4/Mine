import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar, SidebarTagRowDragPreview } from "./Sidebar";
import type { IndexedBlock, TagCount } from "@/types";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
} from "@/lib/hoverPreviewTiming";
import { SIDEBAR_ROW_HOVER_SEAM_ENABLED } from "@/lib/featureFlags";
import { SIDEBAR_PREVIEW_SLOTS } from "@/lib/appLayout";
import { isCardLitByCollection, resetCollectionHover, setCollectionMemberships, setHoveredCard, setSelectedCards } from "@/lib/collectionHover";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { NAME_REFUSAL_NOTICE_MS, NAME_REFUSED_SHAKE_MS } from "@/hooks/useNameEdit";

/** What the command layer throws for a refused name (`invoke`, commands.ts). */
function refusedName(message: string): Error {
  return Object.assign(new Error(message), { cause: { kind: "name_refused", message } });
}

/** The reason under a name being typed, when one shows. */
function nameNotice(): Element | null {
  return document.querySelector("[data-sidebar-name-notice]");
}

/** Lets the refusal of a save arrive, timers held still. */
async function settleSave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Fake timers that also drive the hover-intent clock (performance.now). */
const INTENT_TIMERS = {
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
} as const;

/** A pointer step to `x` over `element`, `ms` after the previous one. */
function pointerTo(element: Element, x: number, ms = 20) {
  act(() => { vi.advanceTimersByTime(ms); });
  fireEvent.pointerMove(element, { clientX: x, clientY: 10 });
}

/** Let a resting pointer's speed settle to zero. */
function rest(ms = HOVER_INTENT.velocityWindowMs + 10) {
  act(() => { vi.advanceTimersByTime(ms); });
}

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
    collections: [],
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

  it("shows no new-channel row at rest: the command lives in the row above the list", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 600 });

    expect(screen.queryByRole("button", { name: "New Collection" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-sidebar-new-channel-row]")).toBeNull();
    expect(container.querySelector('[data-sidebar-row-key="create-channel"]')).toBeNull();
  });

  it("renders the new-channel row at the top of the list, under Everything, while a card is dragged", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 600, isDropDragging: true });

    const button = screen.getByRole("button", { name: "New Collection" });
    const row = button.closest("[data-sidebar-new-channel-row]") as HTMLElement;
    expect(row).toHaveAttribute("data-sidebar-new-channel-row", "");
    expect(row).toHaveAttribute("data-sidebar-row", "");
    expect(row).toHaveAttribute("data-sidebar-row-key", "create-channel");
    expect(row.closest("[data-sidebar-rows]")).not.toBeNull();
    // The list parts for it (global.css, data-sidebar-row-part).
    expect(row.closest("[data-sidebar-row-part]")).not.toBeNull();
    const keys = Array.from(container.querySelectorAll("[data-sidebar-row-key]"))
      .map((node) => node.getAttribute("data-sidebar-row-key"));
    expect(keys.slice(0, 3)).toEqual(["all", "create-channel", "tag:alpha"]);
    expect(container.querySelector("[data-sidebar-rows]")).toBeInTheDocument();
    // A row of the table like the others (07.10.2026): its own seam, the name
    // in the name column under the column's fade, an empty previews' cell and
    // the count's cell, the plus where a count stands.
    expect(row).toHaveAttribute("data-sidebar-row-surface");
    const label = within(row).getByText("New Collection");
    expect(label).toHaveAttribute("data-sidebar-row-text", "");
    expect(label).toHaveClass("w-[var(--sidebar-name-col)]", "shrink-0", "overflow-hidden");
    expect(label).toHaveAttribute("data-sidebar-title-fade-width");
    expect(row.querySelector("[data-sidebar-preview-rail]")).not.toBeNull();
    expect(row.querySelector("[data-sidebar-preview-rail]")?.childElementCount).toBe(0);
    expect(row.querySelector("[data-sidebar-meta-cell]")).not.toBeNull();
    const plus = row.querySelector("[data-sidebar-create-channel-plus]");
    expect(plus?.parentElement).toHaveClass("absolute", "right-[var(--sidebar-row-pad-x)]", "w-8");
  });

  it("starts the new name with the filter typed before the plus", () => {
    renderSidebar({
      ...defaultProps,
      width: 600,
      isCreatingChannel: true,
      searchQuery: "  Arch ",
    });

    expect(screen.getByRole("textbox", { name: "Имя нового канала" })).toHaveValue("Arch");
  });

  it("names a new channel inline once creation starts", async () => {
    const onSetCreatingChannel = vi.fn();
    const onCreateChannel = vi.fn();
    // Creation starts from the row above the list or ⇧⌘N; the list only
    // takes the name.
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      isCreatingChannel: true,
      onSetCreatingChannel,
      onCreateChannel,
    });

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
    const createAction = within(createRow as HTMLElement).getByRole("button", { name: "Create" });
    expect(createAction).toHaveAttribute("data-sidebar-inline-submit-action", "");
    expect(createAction).toHaveAttribute("aria-keyshortcuts", "Enter");
    // The Connect plaque's body: filled with depth, no hover.
    expect(createAction).toHaveClass("button-depth", "bg-depth-fill");
    expect(createAction).not.toHaveClass("hover:outline-component-fill-hover");
    expect(createAction).toHaveTextContent("Create");
    // Placed in the right zone like a row's Connect button.
    expect(createAction).toHaveClass("absolute");
    expect(createRow?.querySelector("[data-sidebar-editable-row-guideline]")).toBeInTheDocument();
    // The key's label from the one key table the bottom bar uses.
    expect(within(createAction).getByText("↵")).toHaveAttribute(
      "data-sidebar-inline-submit-shortcut",
      "",
    );
    // Under Everything: the row above it shares the seam.
    expect(container.querySelector('[data-sidebar-row-key="all"]')).toHaveAttribute(
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
    // The row closes once the collection is made (05.10.2026).
    await waitFor(() => expect(onSetCreatingChannel).toHaveBeenCalledWith(false));
  });

  it("submits new-channel creation from the right-edge Create action", async () => {
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
    const createAction = within(row).getByRole("button", { name: "Create" });

    fireEvent.change(input, { target: { value: "Research" } });
    fireEvent.click(createAction);

    expect(onCreateChannel).toHaveBeenCalledWith("Research");
    await waitFor(() => expect(onSetCreatingChannel).toHaveBeenCalledWith(false));
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

  // A collection's name is edited as the card's name in the path is
  // (05.10.2026): the reason under the field, a shake on a refused save.
  describe("a collection name refused", () => {
    const reason = "A collection named \"beta\" already exists.";

    function startRenaming(props: Partial<typeof defaultProps> & Record<string, unknown>) {
      renderSidebar({ ...defaultProps, width: 600, ...props });
      fireEvent.doubleClick(screen.getByRole("link", { name: /alpha/ }));
      return screen.getByRole("textbox", { name: "Переименовать alpha" });
    }

    it("says why while the name is typed", async () => {
      const onCheckCollectionName = vi.fn(async (_oldTag: string | null, name: string) => (
        name === "beta" ? reason : null
      ));
      const input = startRenaming({ onCheckCollectionName });

      fireEvent.change(input, { target: { value: "beta" } });

      await waitFor(() => expect(nameNotice()).toHaveTextContent(reason));
      expect(onCheckCollectionName).toHaveBeenLastCalledWith("alpha", "beta");
      expect(input).toHaveAttribute("aria-invalid", "true");

      fireEvent.change(input, { target: { value: "gamma" } });

      await waitFor(() => expect(nameNotice()).not.toBeInTheDocument());
      expect(input).toHaveAttribute("aria-invalid", "false");
    });

    it("keeps the field, the cursor and the typed name after a refused Enter", async () => {
      const onRenameTag = vi.fn(async () => {
        throw refusedName(reason);
      });
      const input = startRenaming({ onRenameTag });
      vi.useFakeTimers();

      fireEvent.change(input, { target: { value: "beta" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settleSave();

      expect(onRenameTag).toHaveBeenCalledWith("alpha", "beta");
      expect(input).toHaveAttribute("data-name-refused", "");
      expect(input).toHaveAttribute("readonly");
      expect(nameNotice()).toHaveTextContent(reason);

      act(() => {
        vi.advanceTimersByTime(NAME_REFUSED_SHAKE_MS);
      });

      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("beta");
      expect(input).toHaveFocus();
      expect(input).not.toHaveAttribute("data-name-refused");
      expect(input).not.toHaveAttribute("readonly");
      expect(nameNotice()).toHaveTextContent(reason);
    });

    it("tries again from the Save button and closes once the name is taken", async () => {
      const onRenameTag = vi.fn()
        .mockRejectedValueOnce(refusedName(reason))
        .mockResolvedValueOnce(undefined);
      const input = startRenaming({ onRenameTag });
      vi.useFakeTimers();

      fireEvent.change(input, { target: { value: "beta" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await settleSave();
      act(() => {
        vi.advanceTimersByTime(NAME_REFUSED_SHAKE_MS);
      });
      expect(input).toHaveFocus();

      fireEvent.change(input, { target: { value: "delta" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settleSave();

      expect(onRenameTag).toHaveBeenLastCalledWith("alpha", "delta");
      expect(screen.queryByRole("textbox", { name: "Переименовать alpha" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /alpha/ })).toBeInTheDocument();
      expect(nameNotice()).not.toBeInTheDocument();
    });

    it("returns the old name when the field is left, the reason staying a moment", async () => {
      const onRenameTag = vi.fn(async () => {
        throw refusedName(reason);
      });
      const input = startRenaming({ onRenameTag });
      vi.useFakeTimers();

      fireEvent.change(input, { target: { value: "beta" } });
      fireEvent.blur(input);
      await settleSave();

      expect(input).toHaveAttribute("data-name-refused", "");

      act(() => {
        vi.advanceTimersByTime(NAME_REFUSED_SHAKE_MS);
      });

      expect(screen.queryByRole("textbox", { name: "Переименовать alpha" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /alpha/ })).toBeInTheDocument();
      expect(nameNotice()).toHaveTextContent(reason);

      act(() => {
        vi.advanceTimersByTime(NAME_REFUSAL_NOTICE_MS);
      });

      expect(nameNotice()).not.toBeInTheDocument();
    });

    it("shows a failure without a reason in plain words", async () => {
      const error = new Error("index is locked");
      const onRenameTag = vi.fn(async () => {
        throw error;
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const input = startRenaming({ onRenameTag });

      fireEvent.change(input, { target: { value: "beta" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(nameNotice()).toHaveTextContent("Could not rename the collection."));
      expect(logged).toHaveBeenCalledWith("Could not rename the collection.", error);
      logged.mockRestore();
    });

    it("keeps a new collection's field after a refused Enter and closes the row when it is left", async () => {
      const onSetCreatingChannel = vi.fn();
      const onCreateChannel = vi.fn(async () => {
        throw refusedName(reason);
      });
      const props = {
        ...defaultProps,
        width: 600,
        isCreatingChannel: true,
        onSetCreatingChannel,
        onCreateChannel,
      };
      const { rerender } = renderSidebar(props);
      const input = screen.getByRole("textbox", { name: "Имя нового канала" });
      vi.useFakeTimers();

      fireEvent.change(input, { target: { value: "beta" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settleSave();
      act(() => {
        vi.advanceTimersByTime(NAME_REFUSED_SHAKE_MS);
      });

      expect(onCreateChannel).toHaveBeenCalledWith("beta");
      expect(input).toHaveValue("beta");
      expect(input).toHaveFocus();
      expect(onSetCreatingChannel).not.toHaveBeenCalled();

      fireEvent.blur(input);
      await settleSave();
      act(() => {
        vi.advanceTimersByTime(NAME_REFUSED_SHAKE_MS);
      });

      // The row is cancelled; its reason stays a moment where it stood.
      expect(onSetCreatingChannel).toHaveBeenCalledWith(false);
      rerender(sidebarTree({ ...props, isCreatingChannel: false }));
      expect(screen.queryByRole("textbox", { name: "Имя нового канала" })).not.toBeInTheDocument();
      expect(document.querySelector("[data-sidebar-name-notice-anchor]")).toBeInTheDocument();
      expect(nameNotice()).toHaveTextContent(reason);

      act(() => {
        vi.advanceTimersByTime(NAME_REFUSAL_NOTICE_MS);
      });

      expect(nameNotice()).not.toBeInTheDocument();
    });
  });

  it("uses the row hover seam when card content is dragged over the New Collection row", () => {
    dndContextState.over = { id: "create-channel" };
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      isDropDragging: true,
    });

    const createRow = container.querySelector("[data-sidebar-new-channel-row]") as HTMLElement;
    expect(createRow).toHaveAttribute("data-sidebar-row-key", "create-channel");
    expect(createRow).toHaveAttribute("data-sidebar-row-focused", "true");
    // The row stands under Everything, which shares its seam.
    expect(container.querySelector('[data-sidebar-row-key="all"]')).toHaveAttribute(
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
    vi.useFakeTimers(INTENT_TIMERS);
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
    expect(nav).toHaveAttribute(
      "data-sidebar-row-hover-seam",
      SIDEBAR_ROW_HOVER_SEAM_ENABLED ? "true" : "false",
    );
    expect(alphaRow).toHaveAttribute("data-sidebar-row-surface", "");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-active", "true");
    expect(allRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    expect(alphaRow).not.toHaveAttribute("data-sidebar-row-focused");

    // A slow pointer lights the row under it (SPEC_CARD_STATES.md, С7.10).
    pointerTo(alphaRow, 10);
    rest();
    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(allRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-seam-accent");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");
    expect(betaRow).not.toHaveAttribute("data-sidebar-row-focused");

    pointerTo(betaRow, 11);
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
    // A dragged card shows the create row at the top, between Everything and
    // the first collection: it is the row above alpha now.
    const createRow = container.querySelector('[data-sidebar-row-key="create-channel"]')!;
    const alphaRow = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
    const betaRow = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;

    expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
    expect(alphaRow).toHaveAttribute("data-sidebar-row-focused", "true");
    expect(createRow).toHaveAttribute("data-sidebar-row-seam-accent", "true");
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
    expect(nav).toHaveClass("pt-[var(--sidebar-nav-pad-top)]");
    expect(nav).toHaveClass("pb-8");

    // The inset belongs to the scroll container, and nothing above it may claim
    // vertical space. The nav sits inside a positioning wrapper — the fade band
    // has to be a sibling of the scrollport rather than a child of it — so the
    // check is that the wrapper is layout-transparent and holds no other
    // space-taking element before the nav.
    const wrapper = container.querySelector("aside")?.firstElementChild;
    expect(wrapper).toContainElement(nav as HTMLElement);
    expect(wrapper).toHaveClass("flex-1");
    expect(wrapper).toHaveClass("min-h-0");
    expect(wrapper?.firstElementChild).toBe(nav);
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
    // All states fill the same cell minus two equal 8px fields.
    expect(alphaAction).toHaveStyle({ width: "calc(var(--sidebar-zone) - 16px)" });
    expect(betaAction).toHaveStyle({ width: "calc(var(--sidebar-zone) - 16px)", right: "8px" });
    expect(alphaAction).toHaveClass("absolute");
    expect(alphaAction).toHaveStyle({
      right: "8px",
    });
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

  it("opens the shared card menu from a thumbnail context click", async () => {
    const onOpenCardMenu = vi.fn();
    vi.mocked(invoke).mockResolvedValue(previewBlock("alpha-a"));
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
      onOpenCardMenu,
    });

    const thumbnail = container.querySelector(
      '[data-sidebar-preview-thumbnail="trigger"]',
    ) as HTMLElement;
    fireEvent.contextMenu(thumbnail, { clientX: 144, clientY: 188 });

    await waitFor(() => {
      expect(onOpenCardMenu).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "alpha-a" }),
        { x: 144, y: 188 },
      );
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the channel context menu on non-thumbnail row context clicks", async () => {
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
      onOpenCardMenu: vi.fn(),
    });

    const row = container.querySelector('[data-sidebar-row-key="tag:alpha"]') as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 32, clientY: 48 });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("closes a frozen thumbnail hover preview when the card menu closes away from the thumbnail", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue(previewBlock("alpha-a"));
    const previews = new Map([
      ["alpha", [{
        url: "asset://localhost/thumbs/alpha-a.jpg",
        text: false,
        hasThumb: true,
        slug: "alpha-a",
      }]],
    ]);
    const props = {
      ...defaultProps,
      width: 600,
      vaultPath: "/vault",
      thumbsRootPath: "/vault/.mine/cache/thumbs",
      channelPreviews: previews,
      hoverPreviewFrozen: false,
    };
    const { container, rerender } = renderSidebar(props);

    const thumbnail = container.querySelector(
      '[data-sidebar-preview-thumbnail="trigger"]',
    ) as HTMLElement;
    Object.defineProperty(thumbnail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 100,
        y: 100,
        left: 100,
        top: 100,
        right: 132,
        bottom: 132,
        width: 32,
        height: 32,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerEnter(thumbnail, { clientX: 110, clientY: 110 });
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).toBeInTheDocument();

    rerender(sidebarTree({ ...props, hoverPreviewFrozen: true }));
    fireEvent.pointerLeave(thumbnail, { clientX: 500, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 500 });
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).toBeInTheDocument();

    await act(async () => {
      rerender(sidebarTree({ ...props, hoverPreviewFrozen: false }));
      await Promise.resolve();
    });

    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).not.toBeInTheDocument();
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
          preview_path: "alpha-a.preview-1.jpg",
          width: 900,
          height: 1200,
          is_video: false,
          is_video_poster: false,
        },
        {
          source_path: "alpha-a-img2.jpg",
          preview_path: "alpha-a.preview-2.jpg",
          width: 900,
          height: 1200,
          is_video: false,
          is_video_poster: false,
        },
        {
          source_path: "alpha-a-img3.jpg",
          preview_path: "alpha-a.preview-3.jpg",
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
        tags: ["alpha"],
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
      thumbsRootPath: "/vault/.mine/cache/thumbs",
      channelPreviews: previews,
    });

    const thumbnails = container.querySelectorAll('[data-sidebar-preview-thumbnail="trigger"]');
    const firstThumbnail = thumbnails[0];
    const secondThumbnail = thumbnails[1];
    expect(firstThumbnail).toHaveAttribute("data-sidebar-preview-thumbnail", "trigger");

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
    // The feed's own card unfolded (SPEC_CARD_STATES.md, С10): the post's
    // whole gallery and its text, no lift, with its collections as text at
    // the bottom.
    expect(hoverPreview!.querySelector("[data-card-preview]")).toHaveAttribute("data-card-preview-unfolded");
    expect(hoverPreview!.querySelector("[data-card-preview]")).not.toHaveAttribute("data-card-lift-pinned");
    const hoverImages = hoverPreview!.querySelectorAll("[data-card-media-tile] img");
    expect(Array.from(hoverImages, (image) => image.getAttribute("src"))).toEqual([
      "asset://localhost//vault/.mine/cache/thumbs/alpha-a.preview-1.jpg",
      "asset://localhost//vault/.mine/cache/thumbs/alpha-a.preview-2.jpg",
      "asset://localhost//vault/.mine/cache/thumbs/alpha-a.preview-3.jpg",
    ]);
    expect(hoverPreview).toHaveTextContent("Alpha preview text");
    expect(hoverPreview!.querySelector("[data-card-preview-collections]")).toHaveTextContent("alpha");
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

  it("does not open the sidebar hover preview while a drag is in flight", async () => {
    vi.useFakeTimers();
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
      vaultPath: "/vault",
      thumbsRootPath: "/vault/.mine/cache/thumbs",
      channelPreviews: previews,
      isDropDragging: true,
    });

    const firstThumbnail = container.querySelector(
      '[data-sidebar-preview-thumbnail="trigger"]',
    );
    expect(firstThumbnail).not.toBeNull();

    fireEvent.pointerEnter(firstThumbnail!);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector("[data-sidebar-thumbnail-hover-preview]"),
    ).not.toBeInTheDocument();
    expect(firstThumbnail).not.toHaveAttribute("data-sidebar-preview-active");
    expect(invoke).not.toHaveBeenCalledWith("get_block", { slug: "alpha-a" });
  });

  it("closes an already-open sidebar hover preview when a drag begins", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue(previewBlock("alpha-a"));
    const previews = new Map([
      ["alpha", [{
        url: "asset://localhost/thumbs/alpha-a.jpg",
        text: false,
        hasThumb: true,
        slug: "alpha-a",
      }]],
    ]);
    const baseProps = {
      ...defaultProps,
      width: 600,
      vaultPath: "/vault",
      thumbsRootPath: "/vault/.mine/cache/thumbs",
      channelPreviews: previews,
      isDropDragging: false,
    };
    const { container, rerender } = renderSidebar(baseProps);

    const firstThumbnail = container.querySelector(
      '[data-sidebar-preview-thumbnail="trigger"]',
    );
    fireEvent.pointerEnter(firstThumbnail!);
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector("[data-sidebar-thumbnail-hover-preview]"),
    ).toBeInTheDocument();

    await act(async () => {
      rerender(sidebarTree({ ...baseProps, isDropDragging: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector("[data-sidebar-thumbnail-hover-preview]"),
    ).not.toBeInTheDocument();
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
    expect(leftDivider).toHaveStyle({ left: "calc(var(--sidebar-row-pad-x) + var(--sidebar-name-col))" });
    expect(title).toHaveAttribute("data-sidebar-title-fade-width", "24");
    expect(title).toHaveAttribute("data-sidebar-title-protected-width", "4");
    expect(title).toHaveClass("w-[var(--sidebar-name-col)]");
    expect(title).toHaveClass("shrink-0");
    expect(title).not.toHaveClass("truncate");
    // Four clear pixels after the guideline, which owns the pixel before them.
    expect(rail).toHaveStyle({ paddingLeft: "5px" });
    expect(rightDivider).toHaveClass("bg-sidebar-border");
    // The column that holds the Connect button follows the row's own inset:
    // the button is placed from it, and a guideline measured from the panel
    // edge alone let the button cross into the next column wherever that inset
    // is not zero — which is every alt design.
    // The cell is the button plus an equal field of 8 on either side, which
    // matches the 8 above and below it inside a 40px row.
    // The right guideline stands on the zone boundary, not on the button's
    // own field: zones are what the eye compares, and the button lives inside
    // the meta zone with its fields around it.
    expect(rightDivider).toHaveStyle({ right: "var(--sidebar-zone)" });
    expect(strip).toHaveAttribute("data-sidebar-preview-fade-width", "24");
    // The previews' cell is its own (07.10.2026): the next cell, with the
    // right guideline's pixel, stands in the row's flow, so the previews'
    // cell ends on the guideline. The air before it is the theme's: none in
    // the light theme, where the cell's edge cuts the previews, 4px in the
    // dark one (global.css). Nothing of the next cell's width enters the mask.
    const meta = row.querySelector("[data-sidebar-meta-cell]") as HTMLSpanElement;
    expect(rail.nextElementSibling).toBe(meta);
    expect(meta).toHaveClass("w-[calc(var(--sidebar-zone)+1px)]", "shrink-0");
    expect(rail.style.paddingRight).toBe("var(--preview-edge-gap, 4px)");
    // The dissolve is published for the theme to apply (only the dark one
    // does): the strip carries no mask of its own, and nothing is drawn over
    // the previews' edge.
    const mask = strip.style.getPropertyValue("--sidebar-preview-mask");
    expect(mask).toMatch(/^linear-gradient\(to right, /);
    expect(mask).not.toContain("--sidebar-zone");
    expect(strip.style.maskImage).toBe("");
    expect(rail.childElementCount).toBe(1);
  });

  it("lists every collection for an open card, with no filter bar (07.10.2026)", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    });

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connected" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-sidebar-link-mode-bar]")).toBeNull();
  });

  it("leaves collection rows fully rendered so drag-and-drop can measure them", () => {
    const { container } = renderSidebar();

    // `content-visibility: auto` reports `contain-intrinsic-size` instead of the
    // real box for rows the browser skipped, and dnd-kit sorts against those
    // numbers — the rows then land where the measurement said, not where they
    // are drawn. A list of collections is small enough not to need the trade.
    for (const key of ["tag:alpha", "tag:beta"]) {
      const row = container.querySelector(`[data-sidebar-row-key="${key}"]`) as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.style.contentVisibility).toBe("");
      expect(row.style.containIntrinsicSize).toBe("");
    }
  });

  it("marks the scrollport and refuses hover previews while a collection is being reordered", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue(previewBlock("alpha-a"));
    const previews = new Map([
      ["alpha", [{
        url: "asset://localhost/thumbs/alpha-a.jpg",
        text: false,
        hasThumb: true,
        slug: "alpha-a",
      }]],
    ]);
    const props = {
      ...defaultProps,
      width: 600,
      vaultPath: "/vault",
      thumbsRootPath: "/vault/.mine/cache/thumbs",
      channelPreviews: previews,
      isTagDragging: true,
    };
    const { container } = renderSidebar(props);

    // The flag CSS keys off: rows go inert and the closed hand shows.
    expect(container.querySelector("[data-sidebar-scroll]")).toHaveAttribute(
      "data-sidebar-tag-dragging",
      "true",
    );

    const thumbnail = container.querySelector(
      '[data-sidebar-preview-thumbnail="trigger"]',
    ) as HTMLElement;
    fireEvent.pointerEnter(thumbnail, { clientX: 110, clientY: 110 });
    await act(async () => {
      vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 1);
      await Promise.resolve();
    });

    // Pointer-enter still fires during a drag; the preview must not open.
    expect(container.querySelector("[data-sidebar-thumbnail-hover-preview]")).not.toBeInTheDocument();
  });

  it("carries the row's media into the drag preview without its behaviour", () => {
    const cards = [
      { slug: "a", url: "/thumbs/a.jpg", text: false, hasThumb: true },
      { slug: "b", url: "/thumbs/b.jpg", text: false, hasThumb: true },
    ];
    const { container } = render(
      <SidebarTagRowDragPreview label="Красивый веб" count={31} cards={cards} />,
    );

    const preview = container.querySelector("[data-sidebar-tag-drag-preview]") as HTMLElement;
    expect(preview).toHaveTextContent("Красивый веб");
    expect(preview).toHaveTextContent("31");
    // The picked-up row is the row, media included: the copy renders the real
    // thumbnail strip, one thumbnail per preview card.
    expect(preview.querySelectorAll("[data-sidebar-preview-thumbnail]")).toHaveLength(2);
    // …but none of the row's behaviour: no links, no buttons, no hover
    // triggers. A copy inside the DragOverlay can never be interacted with.
    expect(preview.querySelector("a")).toBeNull();
    expect(preview.querySelector("button")).toBeNull();
    expect(preview.querySelector('[data-sidebar-preview-thumbnail="trigger"]')).toBeNull();
  });

});

describe("sidebar thumbnail placeholders while previews load", () => {
  const stripOf = (container: HTMLElement, rowKey: string) =>
    container.querySelector(
      `[data-sidebar-row-key="${rowKey}"] [data-sidebar-thumbnail-strip]`,
    ) as HTMLElement;
  const placeholdersIn = (container: HTMLElement, rowKey: string) =>
    stripOf(container, rowKey).querySelectorAll("[data-sidebar-preview-placeholder]");
  const tilesIn = (container: HTMLElement, rowKey: string) =>
    stripOf(container, rowKey).querySelectorAll("[data-sidebar-preview-thumbnail]");
  const thumb = (slug: string, text = false) => ({
    slug,
    url: `asset://localhost/thumbs/${slug}.jpg`,
    text,
    hasThumb: true,
  });

  it("fills each slot with a placeholder, one per card up to what the strip holds", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      orderedTags: [tag("alpha", 3), tag("crowded", SIDEBAR_PREVIEW_SLOTS + 15)],
      totalBlocks: 17,
    });

    expect(stripOf(container, "tag:alpha")).toHaveAttribute("data-sidebar-previews", "pending");
    expect(placeholdersIn(container, "tag:alpha")).toHaveLength(3);
    expect(placeholdersIn(container, "tag:crowded")).toHaveLength(SIDEBAR_PREVIEW_SLOTS);
    expect(placeholdersIn(container, "all")).toHaveLength(17);
    expect(tilesIn(container, "tag:alpha")).toHaveLength(0);
  });

  it("draws no placeholder for a collection with no cards", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      orderedTags: [tag("empty", 0)],
      totalBlocks: 0,
    });

    expect(placeholdersIn(container, "tag:empty")).toHaveLength(0);
    expect(placeholdersIn(container, "all")).toHaveLength(0);
  });

  it("draws no placeholder once the read has answered, even with no thumbnails", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      orderedTags: [tag("alpha", 4)],
      channelPreviews: new Map([["alpha", []]]),
    });

    expect(stripOf(container, "tag:alpha")).toHaveAttribute("data-sidebar-previews", "ready");
    expect(placeholdersIn(container, "tag:alpha")).toHaveLength(0);
  });

  it("gives way to the real thumbnails in the same boxes without resizing the strip", () => {
    const props = { ...defaultProps, orderedTags: [tag("alpha", 2)] };
    const { container, rerender } = renderSidebar(props);
    const strip = stripOf(container, "tag:alpha");
    const stripClass = strip.className;
    const stripStyle = strip.getAttribute("style");
    const placeholders = Array.from(placeholdersIn(container, "tag:alpha"));
    expect(placeholders).toHaveLength(2);
    const placeholderClasses = Array.from(placeholders[0]?.classList ?? []);
    expect(placeholderClasses).toEqual(expect.arrayContaining(["size-8", "shrink-0", "bg-accent"]));

    rerender(sidebarTree({
      ...props,
      channelPreviews: new Map([["alpha", [thumb("alpha-a"), thumb("alpha-b", true)]]]),
    }));

    // The strip is the same element with the same box and fade: only its
    // children change, so the row around it cannot move.
    expect(stripOf(container, "tag:alpha")).toBe(strip);
    expect(strip.className).toBe(stripClass);
    expect(strip.getAttribute("style")).toBe(stripStyle);
    expect(strip).toHaveAttribute("data-sidebar-previews", "ready");
    expect(placeholdersIn(container, "tag:alpha")).toHaveLength(0);
    const tiles = Array.from(tilesIn(container, "tag:alpha"));
    expect(tiles).toHaveLength(placeholders.length);
    // One tile class for both: the same size, no rounding, same fill.
    for (const tile of tiles) {
      expect(tile).toHaveClass(...placeholderClasses);
      expect(tile.className).not.toMatch(/\brounded/);
    }
  });

  it("keeps a thumbnail that is still decoding looking like its placeholder", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      orderedTags: [tag("alpha", 1)],
      channelPreviews: new Map([["alpha", [thumb("alpha-text", true)]]]),
    });
    const tile = tilesIn(container, "tag:alpha")[0] as HTMLElement;
    const textFill = tile.querySelector("[data-micro-preview-state]") as HTMLElement;
    const image = tile.querySelector("img") as HTMLImageElement;

    // Until the picture is in, only the placeholder fill shows: the text
    // card's own fill would read as a blank tile.
    expect(tile).toHaveClass("bg-accent");
    expect(textFill).toHaveAttribute("data-micro-preview-state", "loading");
    expect(textFill).not.toHaveClass("bg-card");

    fireEvent.load(image);

    expect(textFill).toHaveAttribute("data-micro-preview-state", "loaded");
    expect(textFill).toHaveClass("bg-card");
  });

  describe("while the space's previews are being built", () => {
    /// The strip's children in order: what each slot holds.
    const slotsIn = (container: HTMLElement, rowKey: string) =>
      Array.from(stripOf(container, rowKey).children).map((child) =>
        child.hasAttribute("data-sidebar-preview-placeholder") ? "placeholder" : "thumbnail",
      );

    it("puts the real thumbnails first and fills the rest of the cards' slots with placeholders", () => {
      const { container } = renderSidebar({
        ...defaultProps,
        orderedTags: [tag("alpha", 5)],
        totalBlocks: 5,
        channelPreviews: new Map([
          ["alpha", [thumb("alpha-a"), thumb("alpha-b")]],
          ["__all__", []],
        ]),
        previewsPending: true,
      });

      expect(stripOf(container, "tag:alpha")).toHaveAttribute("data-sidebar-previews", "ready");
      expect(slotsIn(container, "tag:alpha")).toEqual([
        "thumbnail", "thumbnail", "placeholder", "placeholder", "placeholder",
      ]);
      // The read answered with nothing yet: every card's slot is a placeholder.
      expect(placeholdersIn(container, "all")).toHaveLength(5);
    });

    it("draws no more slots than the strip holds", () => {
      const { container } = renderSidebar({
        ...defaultProps,
        orderedTags: [tag("crowded", SIDEBAR_PREVIEW_SLOTS + 15)],
        channelPreviews: new Map([["crowded", [thumb("c-1"), thumb("c-2"), thumb("c-3")]]]),
        previewsPending: true,
      });

      expect(tilesIn(container, "tag:crowded")).toHaveLength(3);
      expect(placeholdersIn(container, "tag:crowded")).toHaveLength(SIDEBAR_PREVIEW_SLOTS - 3);
      expect(slotsIn(container, "tag:crowded")).toHaveLength(SIDEBAR_PREVIEW_SLOTS);
    });

    it("draws no placeholder for a row whose thumbnails are all in", () => {
      const { container } = renderSidebar({
        ...defaultProps,
        orderedTags: [tag("alpha", 2)],
        channelPreviews: new Map([["alpha", [thumb("alpha-a"), thumb("alpha-b")]]]),
        previewsPending: true,
      });

      expect(placeholdersIn(container, "tag:alpha")).toHaveLength(0);
      expect(tilesIn(container, "tag:alpha")).toHaveLength(2);
    });

    it("hands each arriving thumbnail the next slot: same strip, same number of slots", () => {
      const props = { ...defaultProps, orderedTags: [tag("alpha", 3)], previewsPending: true };
      const { container, rerender } = renderSidebar({
        ...props,
        channelPreviews: new Map([["alpha", [thumb("alpha-a")]]]),
      });
      const strip = stripOf(container, "tag:alpha");
      const stripClass = strip.className;
      const stripStyle = strip.getAttribute("style");
      expect(slotsIn(container, "tag:alpha")).toEqual(["thumbnail", "placeholder", "placeholder"]);

      rerender(sidebarTree({
        ...props,
        channelPreviews: new Map([["alpha", [thumb("alpha-a"), thumb("alpha-b")]]]),
      }));

      expect(stripOf(container, "tag:alpha")).toBe(strip);
      expect(strip.className).toBe(stripClass);
      expect(strip.getAttribute("style")).toBe(stripStyle);
      expect(slotsIn(container, "tag:alpha")).toEqual(["thumbnail", "thumbnail", "placeholder"]);
      const placeholderClasses = Array.from(placeholdersIn(container, "tag:alpha")[0]?.classList ?? []);
      for (const tile of Array.from(tilesIn(container, "tag:alpha"))) {
        expect(tile).toHaveClass(...placeholderClasses);
      }
    });

    it("shows only the thumbnails that exist once the pass is over", () => {
      const props = {
        ...defaultProps,
        orderedTags: [tag("alpha", 5)],
        channelPreviews: new Map([["alpha", [thumb("alpha-a"), thumb("alpha-b")]]]),
      };
      const { container, rerender } = renderSidebar({ ...props, previewsPending: true });
      expect(placeholdersIn(container, "tag:alpha")).toHaveLength(3);

      rerender(sidebarTree({ ...props, previewsPending: false }));
      expect(placeholdersIn(container, "tag:alpha")).toHaveLength(0);
      expect(tilesIn(container, "tag:alpha")).toHaveLength(2);

      rerender(sidebarTree(props));
      expect(placeholdersIn(container, "tag:alpha")).toHaveLength(0);
    });

    it("keeps the row's placeholders in the copy a reorder lifts", () => {
      const { container } = render(
        <SidebarTagRowDragPreview label="alpha" count={4} cards={[thumb("alpha-a")]} previewsPending />,
      );
      const strip = container.querySelector("[data-sidebar-thumbnail-strip]") as HTMLElement;
      expect(strip.querySelectorAll("[data-sidebar-preview-thumbnail]")).toHaveLength(1);
      expect(strip.querySelectorAll("[data-sidebar-preview-placeholder]")).toHaveLength(3);
    });
  });
});

describe("sidebar and the card under the pointer (SPEC_CARD_STATES.md)", () => {
  beforeEach(() => {
    resetCollectionHover();
    setCollectionMemberships([{ block_id: 7, tag: "alpha" }]);
  });
  afterEach(() => resetCollectionHover());

  /** The row's pill while it shows; it stays mounted and fades otherwise (С7.6). */
  const pillIn = (container: HTMLElement, rowKey: string) =>
    container.querySelector(`[data-sidebar-row-key="${rowKey}"] [data-sidebar-row-connected-pill][data-state="on"]`);

  it("shows reference Connected pills instead of counts for the hovered card's collections and Everything", () => {
    const { container } = renderSidebar({ ...defaultProps, width: 600 });
    expect(pillIn(container, "all")).toBeNull();
    act(() => setHoveredCard(7));
    expect(pillIn(container, "all")).toHaveTextContent("Connected");
    expect(pillIn(container, "tag:alpha")).toHaveTextContent("Connected");
    expect(pillIn(container, "tag:beta")).toBeNull();
    expect(screen.getByText("10")).toHaveClass("opacity-0");
    expect(screen.getByText("5")).toHaveClass("opacity-100");
    const pill = pillIn(container, "tag:alpha")!;
    expect(pill.tagName).toBe("SPAN");
    // The bottom bar's reference key (SPEC_CARD_STATES.md, С4): transparent
    // body, the 1px unpressable frame from the surface under it, mono
    // regular, the secondary step, since the link it reports is real.
    expect(pill).toHaveClass("pointer-events-none", "bg-transparent", "outline-1", "outline-inert-frame", "font-mono", "font-normal", "text-muted-foreground");
    expect(pill).not.toHaveClass("text-tertiary-foreground");
    expect(pill).not.toHaveClass("font-semibold");
    expect(pill).not.toHaveClass("text-foreground");
    act(() => setHoveredCard(null));
    expect(pillIn(container, "tag:alpha")).toBeNull();
    expect(screen.getByText("10")).toHaveClass("opacity-100");
  });

  it("marks Everything as connected in an expanded card, without a button", () => {
    const { container } = renderSidebar({
      ...defaultProps,
      width: 600,
      linkedBlockSlug: "open-block",
      linkedTags: ["alpha"],
      onToggleLinkedTag: vi.fn(),
    });
    expect(pillIn(container, "all")).toHaveTextContent("Connected");
    expect(container.querySelector('[data-sidebar-row-key="all"] button')).toBeNull();
    // Other collections keep their own active buttons.
    expect(screen.getByRole("button", { name: "Disconnect alpha" })).toBeInTheDocument();
    expect(pillIn(container, "tag:alpha")).toBeNull();
  });

  describe("a row the pointer attends to (С3, С7.10)", () => {
    beforeEach(() => {
      vi.useFakeTimers(INTENT_TIMERS);
      setCollectionMemberships([{ block_id: 7, tag: "alpha" }, { block_id: 7, tag: "beta" }]);
    });

    it("lights a collection's cards once the pointer rests on its row, anywhere on it", () => {
      const { container } = renderSidebar({ ...defaultProps, width: 600 });
      const nav = container.querySelector("[data-sidebar-scroll]")!;
      const row = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
      pointerTo(row, 10);
      rest();
      // What the click reaches shows at once under a slow pointer (С7.10)...
      expect(row).toHaveAttribute("data-sidebar-row-intent", "true");
      // ...the lit feed waits for the dwell.
      expect(isCardLitByCollection(7)).toBe(false);
      rest(HOVER_INTENT.dwellMs);
      expect(isCardLitByCollection(7)).toBe(true);
      // Moving slowly onto another part of the row does not leave it.
      pointerTo(row.querySelector("a")!, 12);
      expect(isCardLitByCollection(7)).toBe(true);
      fireEvent.pointerLeave(nav);
      rest(HOVER_INTENT.leaveGraceMs + 10);
      expect(isCardLitByCollection(7)).toBe(false);
      expect(row).not.toHaveAttribute("data-sidebar-row-intent");
    });

    it("lights nothing in the feed for the collection that is open", () => {
      const { container } = renderSidebar({ ...defaultProps, width: 600 }, ["/channel/alpha"]);
      const alpha = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
      const beta = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;
      pointerTo(alpha, 10);
      rest(HOVER_INTENT.velocityWindowMs + HOVER_INTENT.dwellMs + 20);
      expect(isCardLitByCollection(7)).toBe(false);
      // Its row still answers the pointer itself.
      expect(alpha).toHaveAttribute("data-sidebar-row-intent", "true");
      pointerTo(beta, 12);
      expect(isCardLitByCollection(7)).toBe(true);
    });

    it("lights nothing in the feed for Everything", () => {
      const { container } = renderSidebar({ ...defaultProps, width: 600 });
      const everything = container.querySelector('[data-sidebar-row-key="all"]')!;
      pointerTo(everything, 10);
      rest(HOVER_INTENT.velocityWindowMs + HOVER_INTENT.dwellMs + 20);
      expect(isCardLitByCollection(7)).toBe(false);
    });

    it("once warm, a neighbour reached slowly takes over with no dark frame", () => {
      const { container } = renderSidebar({ ...defaultProps, width: 600 });
      const alpha = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
      const beta = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;
      pointerTo(alpha, 10);
      rest(HOVER_INTENT.velocityWindowMs + HOVER_INTENT.dwellMs + 20);
      pointerTo(beta, 12);
      expect(isCardLitByCollection(7)).toBe(true);
      expect(beta).toHaveAttribute("data-sidebar-row-intent", "true");
      expect(alpha).not.toHaveAttribute("data-sidebar-row-intent");
    });

    it("a fast sweep lights each row it crosses at once, but no card (02.10.2026)", () => {
      const { container } = renderSidebar({
        ...defaultProps,
        width: 600,
        linkedBlockSlug: "open-block",
        linkedTags: [],
        onToggleLinkedTag: vi.fn(),
      });
      const nav = container.querySelector("[data-sidebar-scroll]")!;
      const rows = ["all", "tag:alpha", "tag:beta"].map((key) => container.querySelector(`[data-sidebar-row-key="${key}"]`)!);
      pointerTo(rows[0]!, 0, 10);
      for (let index = 1; index <= 30; index += 1) {
        const row = rows[index % 3]!;
        pointerTo(row, index * 12, 8);
        // The row's own name, count and button answer at once.
        expect(nav).toHaveAttribute("data-sidebar-row-focus-mode", "true");
        // Collection rows carry the button; Everything has none to show.
        if (row.getAttribute("data-sidebar-row-key") !== "all") {
          expect(row).toHaveAttribute("data-sidebar-row-intent", "true");
        }
        // What the row lights elsewhere still waits for attention (С7.1).
        expect(isCardLitByCollection(7)).toBe(false);
      }
    });

    it("stays silent while the list scrolls under a still pointer", () => {
      const { container } = renderSidebar({ ...defaultProps, width: 600 });
      const nav = container.querySelector("[data-sidebar-scroll]")!;
      const alpha = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
      const beta = container.querySelector('[data-sidebar-row-key="tag:beta"]')!;
      pointerTo(alpha, 10);
      rest(HOVER_INTENT.velocityWindowMs + HOVER_INTENT.dwellMs + 20);
      expect(isCardLitByCollection(7)).toBe(true);
      fireEvent.scroll(nav);
      expect(isCardLitByCollection(7)).toBe(false);
      // WebKit repeats the still pointer's point over the row now under it.
      fireEvent.pointerMove(beta, { clientX: 10, clientY: 10 });
      rest(2000);
      expect(isCardLitByCollection(7)).toBe(false);
      expect(nav).not.toHaveAttribute("data-sidebar-row-focus-mode");
    });
  });
});

describe("sidebar and the feed selection (SPEC_CARD_STATES.md, С6)", () => {
  const selectionProps = {
    ...defaultProps,
    width: 600,
    orderedTags: [tag("alpha", 10), tag("beta", 5), tag("gamma", 3)],
  };

  beforeEach(() => {
    resetCollectionHover();
    // Cards 1 and 2 are selected: both in alpha, one in beta, none in gamma.
    setCollectionMemberships([
      { block_id: 1, tag: "alpha" },
      { block_id: 2, tag: "alpha" },
      { block_id: 2, tag: "beta" },
      { block_id: 3, tag: "gamma" },
    ]);
  });
  afterEach(() => {
    resetCollectionHover();
    vi.useRealTimers();
  });

  const rowIn = (container: HTMLElement, rowKey: string) =>
    container.querySelector(`[data-sidebar-row-key="${rowKey}"]`)!;

  it("shows the selection's membership as active buttons: all, part, none", () => {
    const { container } = renderSidebar({ ...selectionProps, onBatchSetTag: vi.fn() });
    expect(container.querySelector("[data-sidebar-link-action]")).toBeNull();
    act(() => setSelectedCards([{ id: 1, slug: "one" }, { id: 2, slug: "two" }]));

    const alpha = screen.getByRole("button", { name: "Disconnect alpha" });
    expect(alpha).toHaveTextContent("Connected");
    expect(alpha).toHaveClass("opacity-100", "button-depth", "bg-depth-fill");

    const beta = screen.getByRole("button", { name: "Connect beta" });
    expect(beta).toHaveClass("opacity-100");
    expect(beta.querySelector("[data-sidebar-link-partial]")).toHaveTextContent(/^1\/2$/);
    expect(screen.getByText("5")).toHaveClass("opacity-0");

    const gamma = screen.getByRole("button", { name: "Connect gamma" });
    expect(gamma).toHaveClass("opacity-0", "group-data-[sidebar-row-intent=true]:opacity-100");
    expect(screen.getByText("3")).toHaveClass("opacity-100");

    // Everything holds every card: a reference pill, not a button.
    expect(rowIn(container, "all").querySelector('[data-sidebar-row-connected-pill][data-state="on"]')).toHaveTextContent("Connected");
    expect(rowIn(container, "all").querySelector("button")).toBeNull();
  });

  it("connects the whole selection, then disconnects it, updating the buttons at once", () => {
    vi.useFakeTimers();
    const onBatchSetTag = vi.fn();
    renderSidebar({ ...selectionProps, onBatchSetTag });
    act(() => setSelectedCards([{ id: 1, slug: "one" }, { id: 2, slug: "two" }]));

    fireEvent.click(screen.getByRole("button", { name: "Connect beta" }));
    // The row answers before the files change.
    expect(screen.getByRole("button", { name: "Disconnect beta" })).toHaveTextContent("Connected");
    act(() => { vi.runAllTimers(); });
    expect(onBatchSetTag).toHaveBeenLastCalledWith(["one", "two"], "beta", true);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect beta" }));
    expect(screen.getByRole("button", { name: "Connect beta" })).toHaveClass("opacity-0");
    act(() => { vi.runAllTimers(); });
    expect(onBatchSetTag).toHaveBeenLastCalledWith(["one", "two"], "beta", false);
  });

  it("ignores the hovered card while cards are selected", () => {
    const { container } = renderSidebar({ ...selectionProps, onBatchSetTag: vi.fn() });
    act(() => {
      setSelectedCards([{ id: 1, slug: "one" }]);
      setHoveredCard(3);
    });
    expect(rowIn(container, "tag:gamma").querySelector('[data-sidebar-row-connected-pill][data-state="on"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Connect gamma" })).toHaveClass("opacity-0");
  });

  it("keeps the rows reorderable while the selection edits them", () => {
    const { container } = renderSidebar({ ...selectionProps, onBatchSetTag: vi.fn() });
    act(() => setSelectedCards([{ id: 1, slug: "one" }]));
    expect(rowIn(container, "tag:alpha")).toHaveAttribute("aria-roledescription", "sortable");
  });

  it("belongs to the expanded card when one is open", () => {
    renderSidebar({
      ...selectionProps,
      onBatchSetTag: vi.fn(),
      linkedBlockSlug: "open-block",
      linkedTags: ["gamma"],
      onToggleLinkedTag: vi.fn(),
    });
    act(() => setSelectedCards([{ id: 1, slug: "one" }, { id: 2, slug: "two" }]));
    expect(screen.getByRole("button", { name: "Disconnect gamma" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect alpha" })).toBeInTheDocument();
  });

  it("returns to counts when the selection ends", () => {
    renderSidebar({ ...selectionProps, onBatchSetTag: vi.fn() });
    act(() => setSelectedCards([{ id: 1, slug: "one" }]));
    expect(screen.getByRole("button", { name: "Disconnect alpha" })).toBeInTheDocument();
    act(() => setSelectedCards([]));
    expect(screen.queryByRole("button", { name: "Disconnect alpha" })).toBeNull();
    expect(screen.getByText("10")).toHaveClass("opacity-100");
  });
});
