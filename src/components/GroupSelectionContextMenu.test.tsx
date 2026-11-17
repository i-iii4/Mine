import { StrictMode, createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { lightBlock } from "@/test/blocks";
import type { MenuPanelToSource, MenuSpec } from "@/types";
import { GroupSelectionPointMenuHost, type GroupSelectionPointMenuHandle } from "./GroupSelectionContextMenu";

const selection = [lightBlock({ slug: "one", collections: ["alpha"] }), lightBlock({ slug: "two", collections: ["alpha"] })];

/** The selection's menu on the page, opened at a point as a right click
 *  opens it with the menu mode Web. */
function openMenu(onBatchSetTag: () => Promise<boolean>, onClearSelection: () => void) {
  const handle = createRef<GroupSelectionPointMenuHandle>();
  render(
    <GroupSelectionPointMenuHost
      handleRef={handle}
      selectedBlocks={selection}
      tags={[{ tag: "alpha", count: 2 }]}
      currentTag="alpha"
      onLoadBlockTags={vi.fn(async () => new Map())}
      onBatchSetTag={onBatchSetTag}
      onCreateAndAssignBatch={vi.fn()}
      onRequestDeleteSelection={vi.fn()}
      onMergeSelectedBlocks={vi.fn()}
      onClearSelection={onClearSelection}
    />,
  );
  act(() => handle.current?.open({ x: 120, y: 80 }));
}

/// SPEC_DEEP_AUDIT.md, Е6.1: the right-click menu's Disconnect keeps the
/// selection until the answer, and clears it only after a Disconnect that
/// was made.
describe("the selection's right-click Disconnect", () => {
  it.each([[true, 1], [false, 0]] as const)("clears the selection only after it was made (made: %s)", async (applied, clears) => {
    let answer!: (made: boolean) => void;
    const onBatchSetTag = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const onClearSelection = vi.fn();
    openMenu(onBatchSetTag, onClearSelection);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
    expect(onClearSelection).not.toHaveBeenCalled();

    await act(async () => answer(applied));
    expect(onClearSelection).toHaveBeenCalledTimes(clears);
  });

  it("counts the selection in the menu's first row", async () => {
    openMenu(vi.fn(async () => true), vi.fn());
    expect(await screen.findByText("2 elements")).toBeInTheDocument();
  });
});

/// SPEC_MENU_WINDOW.md, Б1: the selection's right click menu in the menu
/// panel, and at the same point on the page when the panel cannot take it.
describe("the selection's right click menu in the menu panel", () => {
  function invokes(name: string) {
    return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
  }

  function toSource(menu: number, seq: number, body: MenuPanelToSource) {
    act(() => {
      const payload = { menu, seq, body };
      window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
    });
  }

  function renderHost(handlers: { onBatchSetTag?: () => Promise<boolean>; onClearSelection?: () => void; onMerge?: () => void } = {}) {
    const handle = createRef<GroupSelectionPointMenuHandle>();
    const view = render(
      <StrictMode>
        <GroupSelectionPointMenuHost
          handleRef={handle}
          selectedBlocks={selection}
          tags={[{ tag: "alpha", count: 2 }, { tag: "beta", count: 0 }]}
          currentTag="alpha"
          onLoadBlockTags={vi.fn(async () => new Map([["one", ["alpha"]], ["two", ["alpha"]]]))}
          onBatchSetTag={handlers.onBatchSetTag ?? vi.fn(async () => true)}
          onCreateAndAssignBatch={vi.fn()}
          onRequestDeleteSelection={vi.fn()}
          onMergeSelectedBlocks={handlers.onMerge ?? vi.fn()}
          onClearSelection={handlers.onClearSelection ?? vi.fn()}
        />
      </StrictMode>,
    );
    return { handle, ...view };
  }

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
    resetMenuPanelSourceForTests(true);
  });

  afterEach(() => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    resetMenuPanelSourceForTests();
  });

  it("asks the panel at the point of the click with the selection's menu, nothing on the page", async () => {
    const { handle } = renderHost();
    // Mounted with no menu: StrictMode's trial run of the mount closed nothing.
    expect(invokes("menu_panel_close")).toEqual([]);
    act(() => handle.current?.open({ x: 300, y: 200 }));
    const [args] = invokes("menu_panel_open") as [{ request: { anchor: unknown; opener: unknown; spec: MenuSpec; size: { height: number } } }];
    expect(args.request.anchor).toEqual({ x: 300, y: 200, width: 0, height: 0 });
    expect(args.request.opener).toEqual({ kind: "point" });
    expect(args.request.spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind))).toEqual(
      ["caption", "separator", "connect", "disconnect", "merge", "delete"],
    );
    // The frame holds the menu with the note of a failed read too: the
    // caption 28, the separator 9, four rows of 32, then 9 and 28 more.
    expect(args.request.size.height).toBe(10 + 28 + 9 + 4 * 32 + 9 + 28);
    expect(screen.queryByText("2 elements")).toBeNull();
  });

  it("sends the panel the selection's collections once they are read", async () => {
    const { handle } = renderHost();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    await waitFor(() => expect(invokes("menu_panel_update")).not.toEqual([]));
    const update = invokes("menu_panel_update").at(-1) as { spec: MenuSpec };
    const connect = update.spec.entries.find((entry) => entry.kind === "submenu");
    const picker = connect?.kind === "submenu" ? connect.content.entries[0] : undefined;
    // Both cards are in alpha: it is ticked.
    expect(picker?.kind === "widget" && picker.widget.kind === "batch_collection_picker" && picker.widget.in_all).toEqual(["alpha"]);
  });

  it("carries out the panel's choices with the selection's handlers", async () => {
    const onBatchSetTag = vi.fn(async () => true);
    const onClearSelection = vi.fn();
    const onMerge = vi.fn();
    const { handle } = renderHost({ onBatchSetTag, onClearSelection, onMerge });
    act(() => handle.current?.open({ x: 300, y: 200 }));
    await waitFor(() => expect(invokes("menu_panel_open")).toHaveLength(1));
    // The picker connects the whole selection, and is answered.
    toSource(1, 1, {
      kind: "action",
      request: 1,
      action: { kind: "widget", id: "connect.picker", action: { kind: "connect_cards", collection: "beta", connected: true } },
    });
    await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "beta", true));
    await waitFor(() => expect(invokes("menu_panel_answer")).toEqual([{ menu: 1, request: 1, answer: { kind: "membership", made: true } }]));
    // Disconnect clears the selection once it was made.
    toSource(1, 2, { kind: "action", request: 2, action: { kind: "run", id: "disconnect" } });
    await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
    await waitFor(() => expect(onClearSelection).toHaveBeenCalledTimes(1));
    toSource(1, 3, { kind: "action", request: 3, action: { kind: "run", id: "merge" } });
    await waitFor(() => expect(onMerge).toHaveBeenCalledTimes(1));
  });

  it("opens on the page at the point when the panel refuses it, its corner on the point", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "app_inactive" });
    const { handle } = renderHost();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    expect(await screen.findByText("2 elements")).toBeInTheDocument();
    const surface = document.querySelector("[data-feed-grid-selection-context-menu]");
    expect([surface?.getAttribute("data-side"), surface?.getAttribute("data-align")]).toEqual(["right", "start"]);
    expect(screen.getByRole("menuitem", { name: "Merge" })).toBeInTheDocument();
  });
});
