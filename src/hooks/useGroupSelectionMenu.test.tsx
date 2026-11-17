// The menu of a selection of cards for one of its entry points
// (SPEC_GROUP_SELECTION.md, «Точки входа»; SPEC_MENU_WINDOW.md, МО16, МО23):
// its description as it stands and the way its choices are carried out.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { menuSpecSize } from "@/lib/menuSpec";
import { lightBlock } from "@/test/blocks";
import type { MenuSpec } from "@/types";
import { useGroupSelectionMenu, type GroupSelectionMenuInput } from "./useGroupSelectionMenu";

const selection = [lightBlock({ slug: "one", collections: ["alpha"] }), lightBlock({ slug: "two", collections: ["alpha"] })];

function input(over: Partial<GroupSelectionMenuInput> = {}): GroupSelectionMenuInput {
  return {
    selectedBlocks: selection,
    tags: [{ tag: "alpha", count: 2 }, { tag: "beta", count: 0 }],
    currentTag: "alpha",
    onLoadBlockTags: vi.fn(async () => new Map([["one", ["alpha"]], ["two", ["alpha", "beta"]]])),
    onBatchSetTag: vi.fn(async () => true),
    onCreateAndAssignBatch: vi.fn(),
    onRequestDeleteSelection: vi.fn(),
    onMergeSelectedBlocks: vi.fn(),
    onClearSelection: vi.fn(),
    ...over,
  };
}

function rows(spec: MenuSpec): string[] {
  return spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind));
}

/** What the picker of `spec` ticks: the collections every card is in. */
function ticked(spec: MenuSpec): string[] | null {
  const holder = spec.entries.find((entry) => entry.kind === "submenu");
  const picker = holder?.kind === "submenu" ? holder.content.entries[0] : spec.entries[0];
  return picker?.kind === "widget" && picker.widget.kind === "batch_collection_picker" ? picker.widget.in_all : null;
}

describe("useGroupSelectionMenu", () => {
  it("describes the whole menu, or Connect's picker alone", () => {
    const whole = renderHook(() => useGroupSelectionMenu("menu", input()));
    expect(rows(whole.result.current.spec)).toEqual(["caption", "separator", "connect", "disconnect", "merge", "delete"]);
    const connect = renderHook(() => useGroupSelectionMenu("connect", input()));
    expect(connect.result.current.spec.role).toBe("search");
    expect(rows(connect.result.current.spec)).toEqual(["connect.picker"]);
    // The picker alone has nothing to grow by.
    expect(connect.result.current.largest).toBe(connect.result.current.spec);
  });

  it("reads the selection's collections once the menu is open, and ticks what every card is in", async () => {
    const props = input();
    const { result } = renderHook(() => useGroupSelectionMenu("menu", props));
    // Not read yet: nothing is ticked.
    expect(ticked(result.current.spec)).toEqual([]);
    expect(props.onLoadBlockTags).not.toHaveBeenCalled();
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(ticked(result.current.spec)).toEqual(["alpha"]));
    expect(props.onLoadBlockTags).toHaveBeenCalledWith(["one", "two"]);
  });

  it("says in a note why the collections could not be read, and counts the menu with the note from the start", async () => {
    const props = input({ onLoadBlockTags: vi.fn(async () => Promise.reject(new Error("The index is busy."))) });
    const { result } = renderHook(() => useGroupSelectionMenu("menu", props));
    const before = result.current;
    expect(before.error).toBeNull();
    // The frame of the menu panel is set once: by the menu with the note.
    expect(menuSpecSize(before.largest).size.height).toBe(menuSpecSize(before.spec).size.height + 9 + 28);
    act(() => result.current.setOpen(true));
    await waitFor(() => expect(result.current.error).toBe("The index is busy."));
    expect(result.current.spec.entries.at(-1)).toEqual({ kind: "note", text: "The index is busy.", tone: "error" });
    expect(menuSpecSize(result.current.spec).size).toEqual(menuSpecSize(before.largest).size);
  });

  it("clears the selection after a Disconnect that was made, and keeps it after one that was not", async () => {
    for (const [made, clears] of [[true, 1], [false, 0]] as const) {
      const props = input({ onBatchSetTag: vi.fn(async () => made) });
      const { result } = renderHook(() => useGroupSelectionMenu("menu", props));
      await act(async () => {
        await result.current.act({ kind: "run", id: "disconnect" });
      });
      await waitFor(() => expect(props.onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
      await waitFor(() => expect(props.onClearSelection).toHaveBeenCalledTimes(clears));
    }
  });

  it("asks the feed to merge and to delete, and does neither itself", async () => {
    const props = input();
    const { result } = renderHook(() => useGroupSelectionMenu("menu", props));
    await act(async () => {
      expect(await result.current.act({ kind: "run", id: "merge" })).toEqual({ kind: "done" });
      expect(await result.current.act({ kind: "run", id: "delete" })).toEqual({ kind: "done" });
      // An id that is no item of this menu does nothing.
      expect(await result.current.act({ kind: "run", id: "rename" })).toEqual({ kind: "done" });
    });
    expect(props.onMergeSelectedBlocks).toHaveBeenCalledTimes(1);
    expect(props.onRequestDeleteSelection).toHaveBeenCalledTimes(1);
    expect(props.onBatchSetTag).not.toHaveBeenCalled();
  });

  it("connects the whole selection for the picker and answers whether it was made", async () => {
    const props = input({ onBatchSetTag: vi.fn(async () => false) });
    const { result } = renderHook(() => useGroupSelectionMenu("connect", props));
    let answer: unknown;
    await act(async () => {
      answer = await result.current.act({
        kind: "widget",
        id: "connect.picker",
        action: { kind: "connect_cards", collection: "beta", connected: true },
      });
    });
    expect(props.onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "beta", true);
    expect(answer).toEqual({ kind: "membership", made: false });
  });

  it("creates a collection for the whole selection", async () => {
    const props = input();
    const { result } = renderHook(() => useGroupSelectionMenu("connect", props));
    await act(async () => {
      await result.current.act({ kind: "widget", id: "connect.picker", action: { kind: "create_collection", name: "gamma" } });
    });
    await waitFor(() => expect(props.onCreateAndAssignBatch).toHaveBeenCalledWith("gamma", ["one", "two"]));
  });
});
