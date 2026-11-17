import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import type { LightBlock, MenuSpec, TagCount } from "@/types";
import { GroupSelectionCommands } from "./GroupSelectionCommands";
import { GroupSelectionCardMenu } from "./GroupSelectionCardMenu";

function block(slug: string): LightBlock {
  return {
    id: 1,
    slug,
    card_kind: "article",
    block_type: "article",
    title: slug,
    url: null,
    media_file: null,
    thumbnail: null,
    saved_at: "2026-10-13T00:00:00Z",
    width: null,
    height: null,
    author: null,
    body: "",
    first_image: null,
    media_urls: null,
    media_dimensions: null,
    preview_manifest: null,
    collections: ["alpha"],
    feed_playback: null,
  } as LightBlock;
}

const selection = [block("one"), block("two")];
const tags: TagCount[] = [{ tag: "alpha", count: 2 }];

/** A membership command on its way, answered by the test. */
function pendingAnswer() {
  let answer!: (applied: boolean) => void;
  const onBatchSetTag = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  return { onBatchSetTag, answer: (applied: boolean) => answer(applied) };
}

/// SPEC_DEEP_AUDIT.md, Е6.1: the selection's Disconnect keeps the selection
/// until the answer. A Disconnect that was made clears it; one that was not
/// keeps it, so it can be tried again, and the tab's notice says why.
describe("the selection's Disconnect", () => {
  it.each([[true, 1], [false, 0]] as const)(
    "in the commands row clears the selection only after a Disconnect that was made (made: %s)",
    async (applied, clears) => {
      const { onBatchSetTag, answer } = pendingAnswer();
      const onClearSelection = vi.fn();
      render(
        <GroupSelectionCommands
          selectedBlocks={selection}
          tags={tags}
          currentTag="alpha"
          onLoadBlockTags={vi.fn(async () => new Map())}
          onBatchSetTag={onBatchSetTag}
          onCreateAndAssignBatch={vi.fn()}
          onRequestDeleteSelection={vi.fn()}
          onMergeSelectedBlocks={vi.fn()}
          onClearSelection={onClearSelection}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
      expect(onClearSelection).not.toHaveBeenCalled();

      await act(async () => answer(applied));

      expect(onClearSelection).toHaveBeenCalledTimes(clears);
    },
  );

  it.each([[true, 1], [false, 0]] as const)(
    "in the ⌘K menu clears the selection only after a Disconnect that was made (made: %s)",
    async (applied, clears) => {
      const { onBatchSetTag, answer } = pendingAnswer();
      const onClearSelection = vi.fn();
      render(
        <GroupSelectionCardMenu
          selectedBlocks={selection}
          tags={tags}
          currentTag="alpha"
          openRequestSequence={1}
          onLoadBlockTags={vi.fn(async () => new Map())}
          onBatchSetTag={onBatchSetTag}
          onCreateAndAssignBatch={vi.fn()}
          onRequestDeleteSelection={vi.fn()}
          onMergeSelectedBlocks={vi.fn()}
          onClearSelection={onClearSelection}
        />,
      );

      fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
      await waitFor(() => expect(onBatchSetTag).toHaveBeenCalledWith(["one", "two"], "alpha", false));
      expect(onClearSelection).not.toHaveBeenCalled();

      await act(async () => answer(applied));

      expect(onClearSelection).toHaveBeenCalledTimes(clears);
    },
  );
});

/// SPEC_MENU_WINDOW.md, Б2 and Б3: the selection's menus off a button go to
/// the menu panel when the menu mode is `window`.
describe("the selection's menus in the menu panel", () => {
  function opens() {
    return vi.mocked(invoke).mock.calls.filter(([command]) => command === "menu_panel_open")
      .map(([, args]) => (args as { request: { spec: MenuSpec; opener: unknown; by_key: boolean } }).request);
  }

  const props = {
    selectedBlocks: selection,
    tags,
    currentTag: "alpha",
    onLoadBlockTags: vi.fn(async () => new Map([["one", ["alpha"]], ["two", ["alpha"]]])),
    onBatchSetTag: vi.fn(async () => true),
    onCreateAndAssignBatch: vi.fn(),
    onRequestDeleteSelection: vi.fn(),
    onMergeSelectedBlocks: vi.fn(),
    onClearSelection: vi.fn(),
  };

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

  it("asks the panel for Connect's picker off the row's button, which looks open meanwhile", async () => {
    render(<GroupSelectionCommands {...props} />);
    const button = screen.getByRole("button", { name: "Connect" });
    fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
    expect(opens()).toHaveLength(1);
    expect(opens()[0]?.opener).toEqual({ kind: "plate" });
    // The picker is the whole menu: a list under a search field.
    expect(opens()[0]?.spec.role).toBe("search");
    expect(opens()[0]?.spec.entries.map((entry) => entry.kind)).toEqual(["widget"]);
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("open"));
    expect(screen.queryByPlaceholderText("Search collections...")).toBeNull();
  });

  it("asks the panel for the selection's menu on ⌘K, out of the card's corner", async () => {
    const view = render(<GroupSelectionCardMenu {...props} openRequestSequence={0} />);
    expect(opens()).toHaveLength(0);
    view.rerender(<GroupSelectionCardMenu {...props} openRequestSequence={1} />);
    await waitFor(() => expect(opens()).toHaveLength(1));
    expect(opens()[0]?.opener).toEqual({ kind: "plate" });
    expect(opens()[0]?.spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind))).toEqual(
      ["caption", "separator", "connect", "disconnect", "merge", "delete"],
    );
    expect(document.querySelector("[data-feed-grid-batch-menu]")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-feed-grid-batch-menu-trigger]")?.getAttribute("data-state")).toBe("open"));
    // The chord again takes the menu away.
    view.rerender(<GroupSelectionCardMenu {...props} openRequestSequence={2} />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "menu_panel_close")).toBe(true));
  });
});
