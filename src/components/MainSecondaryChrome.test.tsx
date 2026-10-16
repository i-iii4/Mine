import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getGraphPreferences, reloadGraphPreferences } from "@/lib/graphPreferences";
import { MainSecondaryTopBar } from "./MainSecondaryChrome";
import type { IndexedBlock, LightBlock, MainViewMode, RenameBlockError } from "@/types";

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
  detailBlock: LightBlock | null,
  viewMode: MainViewMode = "grid",
  onRenameFile: (block: LightBlock | IndexedBlock, newStem: string) => Promise<void> = vi.fn(),
  onCheckFileName: (block: LightBlock | IndexedBlock, newStem: string) => Promise<RenameBlockError | null> =
    vi.fn(() => Promise.resolve(null)),
) {
  return (
    <MainSecondaryTopBar
      detailBlock={detailBlock}
      detailEntered
      viewMode={viewMode}
      onViewModeChange={vi.fn()}
      vaultPath="/vault"
      tags={[]}
      onToggleTag={vi.fn()}
      onCreateAndAssign={vi.fn()}
      onRequestRename={vi.fn()}
      onRenameFile={onRenameFile}
      onCheckFileName={onCheckFileName}
      onRequestDelete={vi.fn()}
      onDetailClose={vi.fn()}
      detailMenuOpenRequestSequence={0}
    />
  );
}

function renderBar(...args: Parameters<typeof bar>) {
  return render(bar(...args));
}

describe("MainSecondaryTopBar", () => {
  it("shows the open card's name, menu and close control in the path", () => {
    renderBar(BLOCK);

    expect(document.querySelector("[data-secondary-detail-top-menu]")).toBeInTheDocument();
    // The path names the card by its file (05.10.2026).
    expect(screen.getByTitle("nogal-house")).toHaveTextContent("nogal-house");
  });

  // In the path the open card's name stands past the line the sidebar segment
  // draws between space and collection (11.10.2026).
  it("draws the path's line before an open card's name only", () => {
    const { rerender } = renderBar(null);
    const segment = document.querySelector("[data-main-secondary-top-bar-content-segment]") as HTMLElement;
    expect(segment).not.toHaveAttribute("data-path-card-line");
    expect(segment).not.toHaveClass("border-l");
    expect(segment).not.toHaveClass("ml-[var(--top-collection-pad-x)]");

    rerender(bar(BLOCK));
    expect(segment).toHaveAttribute("data-path-card-line", "");
    expect(segment).toHaveClass("ml-[var(--top-collection-pad-x)]", "border-l", "border-sidebar-border");
    const layer = document.querySelector("[data-secondary-detail-top-menu]") as HTMLElement;
    expect(segment.contains(layer)).toBe(true);
    expect(layer).toHaveClass("pl-[var(--top-collection-pad-x)]");
    expect(layer).not.toHaveClass("pl-0");
    expect(screen.getByTitle("nogal-house")).toHaveClass("px-2");
    // One line: the moving layer draws none of its own.
    expect(document.querySelectorAll(".border-sidebar-border")).toHaveLength(1);

    rerender(bar(null));
    expect(segment).not.toHaveAttribute("data-path-card-line");
    expect(segment).not.toHaveClass("border-l");
  });

  it("renames the card's file in place: leaving the field saves, Escape keeps the name", async () => {
    const onRenameFile = vi.fn<(block: LightBlock | IndexedBlock, newStem: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);

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
    const onCheckFileName = vi.fn((_block: LightBlock | IndexedBlock, stem: string) => Promise.resolve<RenameBlockError | null>(
      stem.includes("#")
        ? { kind: "invalid_filename", reason: "A name cannot contain \\ : # ^ | [ or ]." }
        : null,
    ));
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", vi.fn(), onCheckFileName);
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
    const onRenameFile = vi.fn<(block: LightBlock | IndexedBlock, newStem: string) => Promise<void>>()
      .mockRejectedValue({ kind: "name_taken", requested: "Cards/Taken" });
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);
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
    const onRenameFile = vi.fn<(block: LightBlock | IndexedBlock, newStem: string) => Promise<void>>()
      .mockRejectedValue({ kind: "name_taken", requested: "Cards/Taken" });
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);
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
    const onRenameFile = vi.fn<(block: LightBlock | IndexedBlock, newStem: string) => Promise<void>>();
    const { rerender } = renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);
    fireEvent.doubleClick(screen.getByTitle("Nogal House"));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename file" }), { target: { value: "Casa" } });

    rerender(bar({ ...BLOCK, slug: "Cards/Casa Blanca" }, "grid", onRenameFile));
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
    expect(screen.getByTitle("Casa Blanca")).toHaveTextContent("Casa Blanca");
    expect(onRenameFile).not.toHaveBeenCalled();
  });

  it("brings no collections switch with an open card", () => {
    // The All / Connected switch left every mode (03.10.2026).
    renderBar(BLOCK);
    expect(screen.queryByText("Collections:")).not.toBeInTheDocument();
  });
});

describe("Display options (SPEC_FEED_DISPLAY.md, Д1, Д4; SPEC_GRAPH_VIEW.md, «Панель графа»)", () => {
  afterEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
  });

  function pathPart(viewMode: MainViewMode) {
    return bar(null, viewMode);
  }

  for (const viewMode of ["grid", "graph"] as const) {
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
    // The graph's switches are not here; the trial «Sidebar columns» is in
    // both panels (PLAN 47.6).
    expect(screen.queryByRole("menuitemcheckbox", { name: "Wikilinks" })).not.toBeInTheDocument();
  });

  it("open the graph's panel in Graph, in place of the feed's, and its switches apply at once", async () => {
    const user = userEvent.setup();
    render(pathPart("graph"));
    await user.click(screen.getByRole("button", { name: "Display options" }));

    expect(screen.getByRole("menu")).toHaveAttribute("data-display-panel", "graph");
    expect(screen.getByRole("group", { name: "Links" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Sort" })).not.toBeInTheDocument();
    // The feed's choices are not here (the trial «Light canvas» is, PLAN 47.7).
    expect(screen.queryByRole("menuitemradio", { name: "Newest first" })).not.toBeInTheDocument();

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

