import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TAB_BAR_HEIGHT_PX } from "@/tabbar/constants";
import { useCardDragToTabBar } from "./useCardDragToTabBar";

const commands = vi.hoisted(() => ({
  reportCardDrag: vi.fn(async () => undefined),
  dropCardsOnTabBar: vi.fn(async () => undefined),
}));
vi.mock("@/lib/commands", () => commands);

function pointer(type: "pointermove" | "pointerup", clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, clientY }));
  });
}

const overBar = -TAB_BAR_HEIGHT_PX / 2;

/** Every report, as (seq, hover). */
const reports = () => commands.reportCardDrag.mock.calls.map((call) => call as unknown[]);

beforeEach(() => {
  commands.reportCardDrag.mockClear();
  commands.dropCardsOnTabBar.mockClear();
});

/// SPEC_TABS.md, В86: the page tells its window's bar where the held cards
/// are over it.
describe("cards dragged over the tab bar", () => {
  function setup(enabled = true) {
    return renderHook((props: { dragging: boolean; title: string }) =>
      useCardDragToTabBar({ enabled, ...props }), { initialProps: { dragging: true, title: "Jacket" } });
  }

  it("reports the pointer over the bar and leaving it, each report numbered above the last", () => {
    setup();
    pointer("pointermove", 300, 200);
    expect(commands.reportCardDrag).not.toHaveBeenCalled();

    pointer("pointermove", 300, overBar);
    pointer("pointermove", 300, overBar);
    pointer("pointermove", 420, overBar);
    pointer("pointermove", 420, 50);
    expect(reports()).toEqual([
      [1, { x: 300, title: "Jacket" }],
      [2, { x: 420, title: "Jacket" }],
      [3, null],
    ]);
  });

  it("names the room again when the held card is read after the drag began", () => {
    const view = setup();
    pointer("pointermove", 300, overBar);
    view.rerender({ dragging: true, title: "Wool jacket" });
    expect(commands.reportCardDrag).toHaveBeenLastCalledWith(2, { x: 300, title: "Wool jacket" });
  });

  it("closes the room when the drag ends without a drop on the bar: Escape, a drop elsewhere", () => {
    const view = setup();
    pointer("pointermove", 300, overBar);
    view.rerender({ dragging: false, title: "Jacket" });
    expect(commands.reportCardDrag).toHaveBeenLastCalledWith(2, null);
    expect(commands.dropCardsOnTabBar).not.toHaveBeenCalled();
  });

  it("hands the release point over the bar to the drop and leaves the room for it", () => {
    const view = setup();
    pointer("pointermove", 300, overBar);
    pointer("pointerup", 310, overBar);
    let x: number | null = null;
    act(() => {
      x = view.result.current.takeDrop();
    });
    expect(x).toBe(310);
    view.rerender({ dragging: false, title: "Jacket" });
    // No report closes the room: the drop lands in it.
    expect(commands.reportCardDrag).toHaveBeenCalledTimes(2);

    const drop = { x: 310, title: "Jacket", views: [] };
    view.result.current.dropOnBar(drop);
    expect(commands.dropCardsOnTabBar).toHaveBeenCalledWith(3, drop);
  });

  it("takes no drop off the bar, and closes the room when asked", () => {
    const view = setup();
    pointer("pointermove", 300, 200);
    expect(view.result.current.takeDrop()).toBeNull();
    view.result.current.leaveBar();
    expect(commands.reportCardDrag).toHaveBeenLastCalledWith(1, null);
  });

  it("stays silent outside a tab page", () => {
    setup(false);
    pointer("pointermove", 300, overBar);
    expect(commands.reportCardDrag).not.toHaveBeenCalled();
  });
});
