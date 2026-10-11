import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getGraphPreferences, reloadGraphPreferences } from "@/lib/graphPreferences";
import { MainSecondaryTopBar } from "./MainSecondaryChrome";
import type { LightBlock, MainViewMode, RenameBlockError } from "@/types";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const BLOCK: LightBlock = {
  id: 1,
  slug: "nogal-house",
  block_type: "article",
  card_kind: "article",
  title: null,
  content_heading: null,
  display_title: "Nogal House",
  fallback_label: "nogal-house",
  url: null,
  media_file: null,
  thumbnail: null,
  saved_at: "2026-08-17T01:41:02Z",
  width: 2000,
  height: 1333,
  author: "@kotecinho",
  body: "",
  preview_text: null,
  first_image: null,
  media_urls: JSON.stringify(["a.jpg", "b.jpg", "c.jpg"]),
  media_dimensions: null,
  preview_manifest: null,
  collections: [],
  feed_playback: null,
  search_match: null,
};

function bar(
  placement: "top" | "bottom",
  detailBlock: LightBlock | null,
  viewMode: "grid" | "graph" = "grid",
  onRenameFile: (block: LightBlock, newStem: string) => Promise<void> = vi.fn(),
  onCheckFileName: (block: LightBlock, newStem: string) => Promise<RenameBlockError | null> =
    vi.fn(() => Promise.resolve(null)),
) {
  return (
    <MainSecondaryTopBar
      sidebarCollapsed={false}
      sidebarResizing={false}
      stats={null}
      detailBlock={detailBlock}
      detailEntered
      viewMode={viewMode}
      onViewModeChange={vi.fn()}
      vaultPath="/vault"
      tags={[]}
      currentTag={null}
      onToggleTag={vi.fn()}
      onCreateAndAssign={vi.fn()}
      onRequestRename={vi.fn()}
      onRenameFile={onRenameFile}
      onCheckFileName={onCheckFileName}
      onRequestDelete={vi.fn()}
      onDetailClose={vi.fn()}
      detailMenuOpenRequestSequence={0}
      placement={placement}
    />
  );
}

function renderBar(...args: Parameters<typeof bar>) {
  return render(bar(...args));
}

describe("MainSecondaryTopBar placement", () => {
  it("closes with a border below and the window background at the top", () => {
    renderBar("top", null);

    const bar = document.querySelector("[data-main-secondary-top-bar]");
    expect(bar).toHaveClass("chrome-row", "bg-chrome");
    expect(bar).toHaveAttribute("data-chrome-separator", "bottom");
    expect(bar).not.toHaveClass("border-t");
    expect(bar).not.toHaveClass("border-b");
    expect(bar).toHaveAttribute("data-main-secondary-placement", "top");
  });

  it("takes the button bar's surface and a border above at the foot", () => {
    renderBar("bottom", null);

    const bar = document.querySelector("[data-main-secondary-top-bar]");
    // The seam always faces the content: below the row when it sits on top,
    // above it when it sits at the foot.
    expect(bar).toHaveClass("chrome-row", "bg-accent");
    expect(bar).toHaveAttribute("data-chrome-separator", "top");
    expect(bar).not.toHaveClass("border-t");
    expect(bar).not.toHaveClass("border-b");
  });

  it("names the open note instead of repeating its title at the foot", () => {
    renderBar("bottom", BLOCK);

    const meta = document.querySelector("[data-main-secondary-note-meta]");
    expect(meta).toBeInTheDocument();
    // The type taxonomy is gone (decision 044): no "article"/"image" atom.
    expect(meta).not.toHaveTextContent("article");
    expect(meta).toHaveTextContent("2000×1333");
    expect(meta).toHaveTextContent("3 media");
    expect(meta).toHaveTextContent("@kotecinho");
    // Title, card menu and close control belong to the top toolbar here, and
    // must not be drawn twice.
    expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeNull();
  });

  it("keeps the title, menu and close control at the top", () => {
    renderBar("top", BLOCK);

    expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeInTheDocument();
    // The path names the card by its file (05.10.2026).
    expect(screen.getByTitle("nogal-house")).toHaveTextContent("nogal-house");
    expect(document.querySelector("[data-main-secondary-note-meta]")).toBeNull();
  });

  // In the path the open card's name stands past the line the sidebar segment
  // draws between space and collection (11.10.2026).
  for (const sidebarCollapsed of [false, true]) {
    it(`draws the path's line before an open card's name only, sidebar ${sidebarCollapsed ? "collapsed" : "open"}`, () => {
      const pathPart = (detailBlock: LightBlock | null) => (
        <MainSecondaryTopBar
          part="content"
          placement="top"
          sidebarCollapsed={sidebarCollapsed}
          sidebarResizing={false}
          stats={null}
          detailBlock={detailBlock}
          detailEntered
          viewMode="grid"
          onViewModeChange={vi.fn()}
          vaultPath="/vault"
          tags={[]}
          currentTag={null}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRenameFile={vi.fn()}
          onCheckFileName={vi.fn(() => Promise.resolve(null))}
          onRequestDelete={vi.fn()}
          onDetailClose={vi.fn()}
          detailMenuOpenRequestSequence={0}
        />
      );
      const { rerender } = render(pathPart(null));
      const segment = document.querySelector("[data-main-secondary-top-bar-content-segment]") as HTMLElement;
      expect(segment).not.toHaveAttribute("data-path-card-line");
      expect(segment).not.toHaveClass("border-l");
      expect(segment).not.toHaveClass("ml-[var(--top-collection-pad-x)]");

      rerender(pathPart(BLOCK));
      expect(segment).toHaveAttribute("data-path-card-line", "");
      expect(segment).toHaveClass("ml-[var(--top-collection-pad-x)]", "border-l", "border-sidebar-border");
      const layer = document.querySelector("[data-secondary-detail-top-menu]") as HTMLElement;
      expect(segment.contains(layer)).toBe(true);
      expect(layer).toHaveClass("pl-[var(--top-collection-pad-x)]");
      expect(layer).not.toHaveClass("pl-0");
      expect(screen.getByTitle("nogal-house")).toHaveClass("px-2");
      // One line: the moving layer draws none of its own.
      expect(document.querySelectorAll(".border-sidebar-border")).toHaveLength(1);

      rerender(pathPart(null));
      expect(segment).not.toHaveAttribute("data-path-card-line");
      expect(segment).not.toHaveClass("border-l");
    });
  }

  // One surface, one way (DESIGN_SYSTEM.md, «Растворение кромок»,
  // 11.10.2026): the open card's name in the path dissolves as the space's
  // and the collection's do; its plate, menu and close control stay whole.
  it("dissolves the open card's name in the path only when it does not fit", () => {
    const long = "Cards/A card name far too long for the path of the top row";
    const longName = "A card name far too long for the path of the top row";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === longName ? 500 : 0;
    });
    try {
      const pathPart = (detailBlock: LightBlock) => (
        <MainSecondaryTopBar
          part="content"
          placement="top"
          sidebarCollapsed={false}
          sidebarResizing={false}
          stats={null}
          detailBlock={detailBlock}
          detailEntered
          viewMode="grid"
          onViewModeChange={vi.fn()}
          vaultPath="/vault"
          tags={[]}
          currentTag={null}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRenameFile={vi.fn()}
          onCheckFileName={vi.fn(() => Promise.resolve(null))}
          onRequestDelete={vi.fn()}
          onDetailClose={vi.fn()}
          detailMenuOpenRequestSequence={0}
        />
      );
      const { rerender } = render(pathPart(BLOCK));
      const shortText = within(screen.getByTitle("nogal-house")).getByText("nogal-house");
      expect(shortText).toHaveAttribute("data-fade-text");
      expect(shortText).not.toHaveAttribute("data-overflow");

      rerender(pathPart({ ...BLOCK, slug: long }));
      // The whole name in the hover hint, on the plate that lights.
      const plate = screen.getByTitle(longName);
      expect(plate).toHaveAttribute("data-secondary-detail-card-name");
      expect(plate).toHaveClass("hover:state-active", "px-2");
      expect(plate).not.toHaveAttribute("data-fade-text");
      const text = within(plate).getByText(longName);
      expect(text).toHaveAttribute("data-overflow", "true");
      expect(text).not.toHaveClass("truncate");
      expect(plate.querySelectorAll("[data-fade-text]")).toHaveLength(1);
      // The card's menu and close control are not under the mask.
      const layer = document.querySelector("[data-secondary-detail-top-menu]") as HTMLElement;
      for (const button of within(layer).getAllByRole("button")) {
        expect(button.closest("[data-fade-text]")).toBeNull();
        expect(button.querySelector("[data-fade-text]")).toBeNull();
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("renames the card's file in place: leaving the field saves, Escape keeps the name", async () => {
    const onRenameFile = vi.fn<(block: LightBlock, newStem: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    renderBar("top", { ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);

    const name = screen.getByTitle("Nogal House");
    expect(name).toHaveTextContent("Nogal House");
    fireEvent.doubleClick(name);
    const input = screen.getByRole("textbox", { name: "Rename file" });
    expect(input).toHaveValue("Nogal House");
    expect(input).toHaveFocus();
    // No Save button: leaving the field is the save (05.10.2026).
    expect(screen.queryByText("Save")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
    expect(onRenameFile).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByTitle("Nogal House"));
    const field = screen.getByRole("textbox", { name: "Rename file" });
    fireEvent.change(field, { target: { value: "Casa Nogal" } });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(onRenameFile).toHaveBeenCalledTimes(1);
    expect(onRenameFile).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "Cards/Nogal House" }), "Casa Nogal");
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
  });

  it("says under the name why a typed name would be refused", async () => {
    const onCheckFileName = vi.fn((_block: LightBlock, stem: string) => Promise.resolve<RenameBlockError | null>(
      stem.includes("#")
        ? { kind: "invalid_filename", reason: "A name cannot contain \\ : # ^ | [ or ]." }
        : null,
    ));
    renderBar("top", { ...BLOCK, slug: "Cards/Nogal House" }, "grid", vi.fn(), onCheckFileName);
    fireEvent.doubleClick(screen.getByTitle("Nogal House"));
    const field = screen.getByRole("textbox", { name: "Rename file" });

    await act(async () => {
      fireEvent.change(field, { target: { value: "Nogal #1" } });
    });
    expect(onCheckFileName).toHaveBeenLastCalledWith(expect.anything(), "Nogal #1");
    expect(await screen.findAllByText("A name cannot contain \\ : # ^ | [ or ].")).not.toHaveLength(0);
    expect(field).toHaveAttribute("aria-invalid", "true");

    await act(async () => {
      fireEvent.change(field, { target: { value: "Nogal 1" } });
    });
    expect(field).toHaveAttribute("aria-invalid", "false");
  });

  it("keeps the field, the cursor and the typed name when Enter is refused", async () => {
    const onRenameFile = vi.fn<(block: LightBlock, newStem: string) => Promise<void>>()
      .mockRejectedValue({ kind: "name_taken", requested: "Cards/Taken" });
    renderBar("top", { ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);
    fireEvent.doubleClick(screen.getByTitle("Nogal House"));
    const field = screen.getByRole("textbox", { name: "Rename file" });
    fireEvent.change(field, { target: { value: "Taken" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(field).toHaveAttribute("data-name-refused");
    expect(field).toHaveAttribute("readonly");

    await waitFor(() => expect(field).not.toHaveAttribute("data-name-refused"));
    expect(screen.getByRole("textbox", { name: "Rename file" })).toBe(field);
    expect(field).toHaveValue("Taken");
    expect(field).toHaveFocus();
    expect(field).not.toHaveAttribute("readonly");
    expect(screen.getAllByText('A file named "Cards/Taken.md" already exists.')).not.toHaveLength(0);
  });

  it("returns the old name when a refused name is left, its reason staying a moment", async () => {
    const onRenameFile = vi.fn<(block: LightBlock, newStem: string) => Promise<void>>()
      .mockRejectedValue({ kind: "name_taken", requested: "Cards/Taken" });
    renderBar("top", { ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);
    fireEvent.doubleClick(screen.getByTitle("Nogal House"));
    const field = screen.getByRole("textbox", { name: "Rename file" });
    fireEvent.change(field, { target: { value: "Taken" } });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(onRenameFile).toHaveBeenCalledTimes(1);
    expect(field).toHaveAttribute("data-name-refused");

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull());
    expect(screen.getByTitle("Nogal House")).toHaveTextContent("Nogal House");
    expect(screen.getAllByText('A file named "Cards/Taken.md" already exists.')).not.toHaveLength(0);
  });

  it("ends the edit when another card takes the path, saving nothing", () => {
    const onRenameFile = vi.fn<(block: LightBlock, newStem: string) => Promise<void>>();
    const { rerender } = renderBar("top", { ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);
    fireEvent.doubleClick(screen.getByTitle("Nogal House"));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename file" }), { target: { value: "Casa" } });

    rerender(bar("top", { ...BLOCK, slug: "Cards/Casa Blanca" }, "grid", onRenameFile));
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
    expect(screen.getByTitle("Casa Blanca")).toHaveTextContent("Casa Blanca");
    expect(onRenameFile).not.toHaveBeenCalled();
  });

  it("brings no collections switch with an open card, in either placement", () => {
    // The All / Connected switch left every mode (03.10.2026).
    const { unmount } = renderBar("bottom", BLOCK);
    expect(screen.queryByText("Collections:")).not.toBeInTheDocument();
    unmount();

    renderBar("top", BLOCK);
    expect(screen.queryByText("Collections:")).not.toBeInTheDocument();
  });
});

describe("Display options (SPEC_FEED_DISPLAY.md, Д1, Д4; SPEC_GRAPH_VIEW.md, «Панель графа»)", () => {
  afterEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
  });

  function pathPart(viewMode: MainViewMode) {
    return (
      <MainSecondaryTopBar
        part="content"
        placement="top"
        sidebarCollapsed={false}
        sidebarResizing={false}
        stats={null}
        detailBlock={null}
        detailEntered
        viewMode={viewMode}
        onViewModeChange={vi.fn()}
        vaultPath="/vault"
        tags={[]}
        currentTag={null}
        onToggleTag={vi.fn()}
        onCreateAndAssign={vi.fn()}
        onRequestRename={vi.fn()}
        onRenameFile={vi.fn()}
        onCheckFileName={vi.fn(() => Promise.resolve(null))}
        onRequestDelete={vi.fn()}
        onDetailClose={vi.fn()}
        detailMenuOpenRequestSequence={0}
      />
    );
  }

  for (const viewMode of ["grid", "graph"] as const) {
    it(`sit on the Mine button's axis in ${viewMode}: chrome actions own the right edge inset`, () => {
      const { container } = renderBar("top", null, viewMode);
      expect(screen.getByRole("button", { name: "Display options" })).toBeInTheDocument();
      const actions = container.querySelector("[data-display-actions]");
      expect(actions).toHaveAttribute("data-chrome-actions");
      expect(actions).toHaveClass("ml-auto", "mr-[var(--chrome-edge-pad)]");
      const row = container.querySelector("[data-main-secondary-stats-right]");
      expect(row).toHaveClass("pl-[var(--main-secondary-pad-x)]");
      expect(row).not.toHaveClass("pr-[var(--main-secondary-pad-x)]");
    });

    it(`stand right of Grid | Graph in the path's row in ${viewMode}`, () => {
      render(pathPart(viewMode));
      const actions = document.querySelector("[data-main-view-mode-switcher]") as HTMLElement;
      const trigger = within(actions).getByRole("button", { name: "Display options" });
      expect(actions.lastElementChild).toBe(trigger);
      expect(within(actions).getByRole("tab", { name: "Graph" })).toBeInTheDocument();
    });
  }

  it("open the feed's panel in Grid, never the graph's", async () => {
    const user = userEvent.setup();
    render(pathPart("grid"));
    await user.click(screen.getByRole("button", { name: "Display options" }));

    expect(screen.getByRole("menu")).toHaveAttribute("data-display-panel", "feed");
    expect(screen.getByRole("group", { name: "Sort" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Links" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
  });

  it("open the graph's panel in Graph, in place of the feed's, and its switches apply at once", async () => {
    const user = userEvent.setup();
    render(pathPart("graph"));
    await user.click(screen.getByRole("button", { name: "Display options" }));

    expect(screen.getByRole("menu")).toHaveAttribute("data-display-panel", "graph");
    expect(screen.getByRole("group", { name: "Links" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Sort" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Related notes" }));
    expect(getGraphPreferences()).toEqual({ include_wikilinks: true, include_related_notes: false });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("close an open panel when the view switches", async () => {
    const user = userEvent.setup();
    const { rerender } = render(pathPart("graph"));
    await user.click(screen.getByRole("button", { name: "Display options" }));
    expect(screen.getByRole("menu")).toHaveAttribute("data-display-panel", "graph");

    rerender(pathPart("grid"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

