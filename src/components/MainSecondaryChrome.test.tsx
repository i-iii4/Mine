import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MainSecondaryTopBar } from "./MainSecondaryChrome";
import type { LightBlock, RenameBlockError } from "@/types";

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
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

describe("Display options (SPEC_FEED_DISPLAY.md, Д1, Д4)", () => {
  it("sit on the Mine button's axis: chrome actions own the right edge inset", () => {
    const { container } = renderBar("top", null, "grid");
    expect(screen.getByRole("button", { name: "Display options" })).toBeInTheDocument();
    const actions = container.querySelector("[data-feed-display]");
    expect(actions).toHaveAttribute("data-chrome-actions");
    expect(actions).toHaveClass("ml-auto", "mr-[var(--chrome-icon-edge-pad)]");
    const row = container.querySelector("[data-main-secondary-stats-right]");
    expect(row).toHaveClass("pl-[var(--main-secondary-pad-x)]");
    expect(row).not.toHaveClass("pr-[var(--main-secondary-pad-x)]");
  });

  it("are absent in Graph, where none of them applies", () => {
    const { container } = renderBar("top", null, "graph");
    expect(screen.queryByRole("button", { name: "Display options" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-main-secondary-stats-right]")).toHaveClass(
      "pl-[var(--main-secondary-pad-x)]",
      "pr-[var(--main-secondary-pad-x)]",
    );
  });
});

