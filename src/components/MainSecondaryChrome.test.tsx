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
  onDetailCollapse?: () => void,
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
      onDetailCollapse={onDetailCollapse}
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

  // The open card's name never stands with the place's name in the row, so
  // no line stands before it, with a card or without (DESIGN_SYSTEM.md, «Одно
  // название в ряду»; user's decision of 11.11.2026).
  it("draws no line before an open card's name, which takes the half on the place's padding", () => {
    const { rerender } = renderBar(null);
    const segment = document.querySelector("[data-main-secondary-top-bar-content-segment]") as HTMLElement;
    const lineFree = () => {
      expect(segment).not.toHaveAttribute("data-path-card-line");
      expect(segment).not.toHaveClass("border-l");
      expect(segment).not.toHaveClass("ml-[var(--top-collection-pad-x)]");
      expect(document.querySelectorAll(".border-sidebar-border")).toHaveLength(0);
    };
    lineFree();

    rerender(bar(BLOCK));
    lineFree();
    // The name's layer spans the half, its pill on the outer padding the
    // place's name keeps from the window's edge or the segment's line, the
    // name ending in an ellipsis, ⋯ and × at the end.
    const layer = document.querySelector("[data-secondary-detail-top-menu]") as HTMLElement;
    expect(segment.contains(layer)).toBe(true);
    expect(layer).toHaveClass("absolute", "inset-0", "pl-[var(--top-collection-pad-x)]");
    expect(layer).not.toHaveClass("pl-0");
    expect(screen.getByTitle("nogal-house")).toHaveClass("px-2", "truncate", "min-w-0");
    expect(within(layer).getByRole("button", { name: "Close" })).toBeInTheDocument();

    rerender(bar(null));
    lineFree();
  });

  it("renames the card's file in place: leaving the field saves, Escape keeps the name", async () => {
    const onRenameFile = vi.fn<(block: LightBlock | IndexedBlock, newStem: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);

    const name = screen.getByTitle("Nogal House");
    expect(name).toHaveTextContent("Nogal House");
    fireEvent.click(name);
    const input = screen.getByRole("textbox", { name: "Rename file" });
    expect(input).toHaveValue("Nogal House");
    expect(input).toHaveFocus();
    // No Save button: leaving the field is the save (05.10.2026).
    expect(screen.queryByText("Save")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
    expect(onRenameFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Nogal House"));
    const field = screen.getByRole("textbox", { name: "Rename file" });
    fireEvent.change(field, { target: { value: "Casa Nogal" } });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(onRenameFile).toHaveBeenCalledTimes(1);
    expect(onRenameFile).toHaveBeenLastCalledWith(expect.objectContaining({ slug: "Cards/Nogal House" }), "Casa Nogal");
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
  });

  // The card's name opens by a single click and shows no hover plate: under
  // the pointer only its text brightens, with a text cursor (16.10.2026).
  it("opens the name's field with a single click, the name under the pointer brighter with a text cursor and no plate", () => {
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" });

    const name = screen.getByTitle("Nogal House");
    expect(name).toHaveClass("cursor-text", "text-muted-foreground", "hover:text-foreground");
    expect(name).not.toHaveClass("hover:state-active");
    expect(name.className).not.toMatch(/state-active/);

    fireEvent.click(name);
    const field = screen.getByRole("textbox", { name: "Rename file" });
    expect(field).toHaveValue("Nogal House");
    expect(field).toHaveFocus();
    expect(field).toHaveProperty("selectionStart", "Nogal House".length);
    expect(field).toHaveProperty("selectionEnd", "Nogal House".length);
    // The field keeps its look: the plate shows its extent.
    expect(field).toHaveClass("state-active");
  });

  // The rename field follows its text up to the card's commands, as the name
  // at rest does (user's decision of 01.11.2026): the name's box shrinks in
  // the layer's row, the commands do not.
  it("caps the name's field by the room up to the card's commands", () => {
    const { container } = renderBar({ ...BLOCK, slug: "Cards/Nogal House" });
    fireEvent.click(screen.getByTitle("Nogal House"));
    const field = screen.getByRole("textbox", { name: "Rename file" });
    const anchor = container.querySelector("[data-secondary-detail-card-name-anchor]")!;
    expect(anchor).toContainElement(field);
    expect(anchor).toHaveClass("min-w-0");
    const layer = container.querySelector("[data-secondary-detail-top-menu]")!;
    expect(layer).toHaveClass("flex", "min-w-0");
    expect(anchor.parentElement).toBe(layer);
    const actions = layer.querySelector(":scope > [data-chrome-actions]")!;
    expect(actions).toHaveClass("shrink-0", "ml-auto");
    expect(anchor.nextElementSibling).toBe(actions);
  });

  it("does nothing more on the rest of a double click than open the field", () => {
    const onRenameFile = vi.fn<(block: LightBlock | IndexedBlock, newStem: string) => Promise<void>>();
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", onRenameFile);

    const name = screen.getByTitle("Nogal House");
    fireEvent.mouseDown(name, { detail: 1 });
    fireEvent.mouseUp(name, { detail: 1 });
    fireEvent.click(name, { detail: 1 });
    const field = screen.getByRole("textbox", { name: "Rename file" });

    // The second and third presses land on the new field: they select no
    // word and no line there, the cursor stays at the end of the name.
    expect(fireEvent.mouseDown(field, { detail: 2 })).toBe(false);
    fireEvent.mouseUp(field, { detail: 2 });
    fireEvent.click(field, { detail: 2 });
    fireEvent.doubleClick(field, { detail: 2 });
    expect(fireEvent.mouseDown(field, { detail: 3 })).toBe(false);
    expect(screen.getByRole("textbox", { name: "Rename file" })).toBe(field);
    expect(field).toHaveValue("Nogal House");
    expect(field).toHaveFocus();
    expect(field).toHaveProperty("selectionStart", "Nogal House".length);
    expect(field).toHaveProperty("selectionEnd", "Nogal House".length);
    expect(onRenameFile).not.toHaveBeenCalled();

    // A double click of its own in the open field selects as in any field.
    expect(fireEvent.mouseDown(field, { detail: 1 })).toBe(true);
    expect(fireEvent.mouseDown(field, { detail: 2 })).toBe(true);
  });

  it("says under the name why a typed name would be refused", async () => {
    const onCheckFileName = vi.fn((_block: LightBlock | IndexedBlock, stem: string) => Promise.resolve<RenameBlockError | null>(
      stem.includes("#")
        ? { kind: "invalid_filename", reason: "A name cannot contain \\ : # ^ | [ or ]." }
        : null,
    ));
    renderBar({ ...BLOCK, slug: "Cards/Nogal House" }, "grid", vi.fn(), onCheckFileName);
    fireEvent.click(screen.getByTitle("Nogal House"));
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
    fireEvent.click(screen.getByTitle("Nogal House"));
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
    fireEvent.click(screen.getByTitle("Nogal House"));
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
    fireEvent.click(screen.getByTitle("Nogal House"));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename file" }), { target: { value: "Casa" } });

    rerender(bar({ ...BLOCK, slug: "Cards/Casa Blanca" }, "grid", onRenameFile));
    expect(screen.queryByRole("textbox", { name: "Rename file" })).toBeNull();
    expect(screen.getByTitle("Casa Blanca")).toHaveTextContent("Casa Blanca");
    expect(onRenameFile).not.toHaveBeenCalled();
  });

  // SPEC_CARD_PEEK.md, О9, О16 (user's decision of 30.10.2026).
  it("holds the way back to the card's window between the menu and the close, only when offered", () => {
    const onDetailCollapse = vi.fn();
    const { rerender } = renderBar(BLOCK, "grid", vi.fn(), vi.fn(() => Promise.resolve(null)), onDetailCollapse);
    const menu = document.querySelector<HTMLElement>("[data-secondary-detail-top-menu]")!;
    const group = menu.querySelector<HTMLElement>("[data-chrome-actions]")!;
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Card actions", "Collapse to window", "Close"]);
    const actions = within(group).getByRole("button", { name: "Card actions" });
    const collapse = within(group).getByRole("button", { name: "Collapse to window" });
    const close = within(group).getByRole("button", { name: "Close" });
    expect(collapse.getAttribute("data-variant")).toBe(close.getAttribute("data-variant"));
    expect(collapse.getAttribute("data-size")).toBe(close.getAttribute("data-size"));
    expect(collapse.getAttribute("data-size")).toBe(actions.getAttribute("data-size"));
    fireEvent.click(collapse);
    expect(onDetailCollapse).toHaveBeenCalledTimes(1);
    // Not offered (Full page, or a right part too narrow for the window): absent.
    rerender(bar(BLOCK));
    expect(screen.queryByRole("button", { name: "Collapse to window" })).toBeNull();
    expect(within(group).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Card actions", "Close"]);
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

