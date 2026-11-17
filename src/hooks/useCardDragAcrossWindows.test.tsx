import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardStack, LightBlock } from "@/types";
import { CARD_DRAG_VIEW_EVENT, useCardDragAcrossWindows, type CardDragAcrossInput } from "./useCardDragAcrossWindows";

const commands = vi.hoisted(() => ({
  beginCardDrag: vi.fn(async () => undefined),
  updateCardDrag: vi.fn(async () => undefined),
  endCardDrag: vi.fn(async () => undefined),
}));
vi.mock("@/lib/commands", () => commands);

type Handler = (event: { payload: { seq: number } }) => void;
const heard = vi.hoisted(() => new Map<string, Handler>());
vi.mock("@/lib/pageEvents", () => ({
  listenPage: (event: string, handler: Handler) => {
    heard.set(event, handler);
    return Promise.resolve(() => undefined);
  },
}));

const STACK: CardStack = {
  // Only carried on to the backend here, never drawn.
  blocks: [{ slug: "jacket" } as unknown as LightBlock],
  thumb_versions: [null],
  look: { vault_path: "/vault", thumbs_root_path: null, collection_order: [] },
};

function input(fields: Partial<CardDragAcrossInput> = {}): CardDragAcrossInput {
  return { drag: 1, title: "Jacket", views: [], slugs: ["jacket"], thumbnail: false, confirm: false, stack: STACK, ...fields };
}

function setup(initial: CardDragAcrossInput | null) {
  return renderHook((props: { drag: CardDragAcrossInput | null }) => useCardDragAcrossWindows({ enabled: true, drag: props.drag }), {
    initialProps: { drag: initial },
  });
}

const seqs = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((call) => call[0] as number);

beforeEach(() => {
  commands.beginCardDrag.mockClear();
  commands.updateCardDrag.mockClear();
  commands.endCardDrag.mockClear();
  heard.clear();
});

/// SPEC_OUTSIDE_WINDOW.md, ПК2, ПК8: the page owns the drag; the backend
/// follows it past the window.
describe("cards dragged past the window", () => {
  it("tells the backend what is dragged as it begins, and that it ended, each report numbered above the last", () => {
    const hook = setup(input());
    expect(commands.beginCardDrag).toHaveBeenCalledTimes(1);
    expect(commands.beginCardDrag.mock.calls[0]).toEqual([1, { title: "Jacket", views: [], slugs: ["jacket"], thumbnail: false, confirm: false, stack: STACK }]);
    expect(commands.updateCardDrag).not.toHaveBeenCalled();
    hook.rerender({ drag: null });
    expect(seqs(commands.endCardDrag)).toEqual([2]);
    hook.rerender({ drag: input({ drag: 2 }) });
    expect(seqs(commands.beginCardDrag)).toEqual([1, 3]);
    hook.unmount();
    expect(seqs(commands.endCardDrag)).toEqual([2, 4]);
  });

  it("tells the card's title and its look once they are read after the drag began", () => {
    const hook = setup(input({ title: "jacket.md", stack: null }));
    hook.rerender({ drag: input({ title: "Jacket", stack: null }) });
    expect(commands.updateCardDrag.mock.calls.at(-1)).toEqual([2, { title: "Jacket", stack: null }]);
    hook.rerender({ drag: input({ title: "Jacket", stack: STACK }) });
    expect(commands.updateCardDrag.mock.calls.at(-1)).toEqual([3, { title: "Jacket", stack: STACK }]);
    // Nothing new: nothing sent.
    hook.rerender({ drag: input({ title: "Jacket", stack: STACK }) });
    expect(commands.updateCardDrag).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("hides the page's card once the backend says it is drawn outside, for this drag only", async () => {
    const hook = setup(input());
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.shownOutside).toBe(false);
    act(() => heard.get(CARD_DRAG_VIEW_EVENT)?.({ payload: { seq: 1 } }));
    expect(hook.result.current.shownOutside).toBe(true);
    hook.rerender({ drag: null });
    expect(hook.result.current.shownOutside).toBe(false);
    hook.rerender({ drag: input({ drag: 2 }) });
    // A late word of the drag before says nothing of this one.
    act(() => heard.get(CARD_DRAG_VIEW_EVENT)?.({ payload: { seq: 1 } }));
    expect(hook.result.current.shownOutside).toBe(false);
    hook.unmount();
  });

  it("knows the button went up outside the page, where the backend takes the drop", () => {
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    const hook = setup(input());
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: -12 }));
    });
    expect(hook.result.current.releasedOutside()).toBe(true);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 300, clientY: 200 }));
    });
    expect(hook.result.current.releasedOutside()).toBe(false);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 900, clientY: 200 }));
    });
    expect(hook.result.current.releasedOutside()).toBe(true);
    hook.unmount();
    vi.unstubAllGlobals();
  });
});
