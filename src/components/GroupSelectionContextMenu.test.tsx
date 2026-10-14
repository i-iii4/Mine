import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { lightBlock } from "@/test/blocks";
import { GroupSelectionContextMenu } from "./GroupSelectionContextMenu";

const selection = [lightBlock({ slug: "one", collections: ["alpha"] }), lightBlock({ slug: "two", collections: ["alpha"] })];

function openMenu(onBatchSetTag: () => Promise<boolean>, onClearSelection: () => void) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>selection</ContextMenuTrigger>
      <GroupSelectionContextMenu
        selectedBlocks={selection}
        tags={[{ tag: "alpha", count: 2 }]}
        currentTag="alpha"
        onLoadBlockTags={vi.fn(async () => new Map())}
        onBatchSetTag={onBatchSetTag}
        onCreateAndAssignBatch={vi.fn()}
        onRequestDeleteSelected={vi.fn()}
        onMergeSelectedBlocks={vi.fn()}
        onClearSelection={onClearSelection}
      />
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("selection"));
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
