import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useLayoutEffect } from "react";
import type { LightBlock } from "@/types";
import { CARD_PEEK_NUDGE_OFFSET_PX, getPeekHiddenSlug, peekNudgeTransform, registerPeekGraphSource } from "@/lib/cardPeek";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { setPeekWidth } from "@/lib/cardView";
import { CardPeek, CardPeekPlate, type CardPeekOpening, type CardPeekProps } from "./CardPeek";
import { useDetailFrame } from "./detailFrame";
import { TooltipProvider } from "./ui/tooltip";

const block = { slug: "Cards/One", id: 1 } as unknown as LightBlock;

function peek(props: Partial<CardPeekProps> & { block: LightBlock | null }) {
  const area = document.createElement("main");
  document.body.append(area);
  const areaRef = createRef<HTMLElement>();
  Object.assign(areaRef, { current: area });
  const onClose = vi.fn();
  const element = (next: Partial<CardPeekProps> & { block: LightBlock | null }) => (
    <CardPeek
      opening={null}
      exit="return"
      areaRef={areaRef}
      onClose={onClose}
      onReopen={vi.fn()}
      {...props}
      {...next}
    >
      {(shown) => <p data-testid="content">{shown.slug}</p>}
    </CardPeek>
  );
  const view = render(element(props));
  return { ...view, onClose, rerenderWith: (next: Partial<CardPeekProps> & { block: LightBlock | null }) => view.rerender(element(next)) };
}

const restored: CardPeekOpening = { sequence: 1, slug: block.slug, from: "elsewhere", restored: true };

/** Frames run by hand. What a frame shows is read right after its
 *  callbacks, before the page's other work (React's own renders included),
 *  which the browser runs only after it painted the frame. */
function handFrames() {
  let queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    id += 1;
    queue.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    queue.delete(handle);
  });
  let now = performance.now();
  return {
    /** Runs one frame and returns what it shows. */
    run<T>(read: () => T): T {
      // A frame's time never behind the clock the component reads itself.
      now = Math.max(now + 16.7, performance.now());
      const callbacks = [...queue.values()];
      queue = new Map();
      let shown: T | undefined;
      act(() => {
        for (const callback of callbacks) callback(now);
        shown = read();
      });
      return shown as T;
    },
  };
}

/// TRIAL (SPEC_CARD_PEEK.md): the open card's window.
describe("CardPeek", () => {
  it("draws nothing with no card", () => {
    const { container } = peek({ block: null });
    expect(container.querySelector("[data-card-peek]")).toBeNull();
  });

  it("stands a card opened with the tab in its window at once, the right part blurred round it (О6, О10)", () => {
    const { container, getByTestId } = peek({ block, opening: restored });
    expect(getByTestId("content")).toHaveTextContent(block.slug);
    const scrim = container.querySelector("[data-card-peek-scrim]");
    expect(scrim).toHaveClass("modal-scrim");
    const surface = container.querySelector("[data-card-peek-surface]");
    // At rest: one plain surface with its line, shadow and corner (О7), no
    // pieces and no layer.
    expect(surface).toHaveClass("border", "border-border", "shadow-lg", "bg-background");
    // The user's corner for this window (SPEC_CARD_PEEK.md, «Величины»).
    expect((surface as HTMLElement).style.borderRadius).toBe("4px");
    expect(surface).not.toHaveAttribute("data-moving");
    expect(container.querySelector("[data-peek-piece]")).toBeNull();
    expect((surface as HTMLElement).style.transform).toBe("");
    // Nothing to hide: the window did not grow out of a card.
    expect(getPeekHiddenSlug()).toBeNull();
  });

  it("stands a card opened with a key in its window at once, with its scrim, and fades it in place when it closes (О10, О11)", () => {
    const frames = handFrames();
    try {
      const view = peek({ block, opening: { sequence: 1, slug: block.slug, from: "keyboard", restored: false } });
      // In the frame of the key: no preparing, no fade, nothing moving.
      const scrim = view.container.querySelector<HTMLElement>("[data-card-peek-scrim]")!;
      const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
      expect(view.container.querySelector("[data-card-peek-preparing]")).toBeNull();
      expect(scrim.style.opacity).toBe("");
      expect(window.style.opacity).toBe("");
      expect(view.container.querySelector("[data-peek-piece]")).toBeNull();
      // Closed by its ×, it fades in place: the scrim and the window by the spring.
      view.rerenderWith({ block: null, opening: null });
      const opacities: string[] = [];
      for (let frame = 0; frame < 120 && view.container.querySelector("[data-card-peek]"); frame += 1) {
        opacities.push(frames.run(() => view.container.querySelector<HTMLElement>("[data-card-peek-window]")?.style.opacity ?? ""));
      }
      expect(opacities.some((opacity) => opacity !== "" && Number(opacity) > 0 && Number(opacity) < 1)).toBe(true);
      expect(view.container.querySelector("[data-peek-piece]")).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stands `M` off every edge of the right part (О3)", () => {
    const { container } = peek({ block, opening: restored });
    const window = container.querySelector<HTMLElement>("[data-card-peek-window]");
    expect(window?.style.inset).toBe("40px");
  });

  it("closes on a press of the blurred right part (О6)", () => {
    const { container, onClose } = peek({ block, opening: restored });
    fireEvent.click(container.querySelector("[data-card-peek-scrim]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is gone at once when a narrow window takes the card full page (О1)", () => {
    const view = peek({ block, opening: restored });
    view.rerenderWith({ block: null, opening: restored, exit: "none" });
    expect(view.container.querySelector("[data-card-peek]")).toBeNull();
  });

  it("leaves the page in the frame its closing lays down, never shown whole and blurred after it left (О11)", () => {
    const frames = handFrames();
    try {
      const view = peek({ block, opening: restored });
      view.rerenderWith({ block: null, opening: restored });
      const shown: (string | null)[] = [];
      for (let frame = 0; frame < 120 && shown.at(-1) !== null; frame += 1) {
        shown.push(frames.run(() => view.container.querySelector<HTMLElement>("[data-card-peek-scrim]")?.style.opacity ?? null));
      }
      // The scrim fades with the window, and the frame after its last one
      // has neither: no frame between them stands at full blur.
      const moving = shown.findIndex((opacity) => opacity !== "");
      expect(moving).toBeGreaterThanOrEqual(0);
      expect(shown.at(-1)).toBeNull();
      expect(shown.slice(moving, -1)).not.toContain("");
      expect(shown.at(-2)).toBe("0");
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe("its step back with the pointer resting on the scrim over it (О15)", () => {
    const stepped = peekNudgeTransform(1);

    function pointerAt(x: number, y: number, target: EventTarget, pointerType = "mouse", buttons = 0) {
      const event = new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y, buttons });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      act(() => {
        target.dispatchEvent(event);
      });
    }

    /** A slow pointer that comes to rest at `x, y` (С7.2): no dwell. */
    function restAt(x: number, y: number, target: EventTarget) {
      for (let step = 0; step < 6; step += 1) {
        pointerAt(x + step, y, target);
        act(() => {
          vi.advanceTimersByTime(16);
        });
      }
      act(() => {
        vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs);
      });
    }

    function steppedPeek() {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const observers: ResizeObserverCallback[] = [];
      vi.stubGlobal("ResizeObserver", class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      });
      const frames = handFrames();
      const view = peek({ block, opening: restored });
      // The right part `peek` made last.
      const area = [...document.querySelectorAll("main")].at(-1)!;
      const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
      const box = (left: number, top: number, width: number, height: number) => ({
        left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}),
      }) as DOMRect;
      const areaRect = vi.spyOn(area, "getBoundingClientRect").mockReturnValue(box(0, 0, 1000, 800));
      /** The right part moved to `left` under a still pointer. */
      const moveArea = (left: number) => {
        areaRect.mockReturnValue(box(left, 0, 1000 - left, 800));
        act(() => {
          for (const callback of observers) callback([], {} as ResizeObserver);
        });
      };
      vi.spyOn(window, "getBoundingClientRect").mockReturnValue(box(40, 40, 920, 720));
      const scrim = view.container.querySelector<HTMLElement>("[data-card-peek-scrim]")!;
      const surface = view.container.querySelector<HTMLElement>("[data-card-peek-surface]")!;
      const nudge = view.container.querySelector<HTMLElement>("[data-card-peek-nudge]")!;
      const hint = view.container.querySelector<HTMLElement>("[data-card-peek-hint]")!;
      const settle = () => {
        for (let frame = 0; frame < 60; frame += 1) frames.run(() => null);
      };
      return { view, scrim, surface, nudge, hint, settle, moveArea };
    }

    const cleanUp = () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    };

    it("steps the window back and shows the hint once the pointer is slow there, the scrim whole, and comes back off it", () => {
      try {
        const { scrim, surface, nudge, hint, settle } = steppedPeek();
        expect(hint).toHaveTextContent("ESC to close card");
        expect(hint).not.toHaveAttribute("data-shown");
        restAt(500, 20, scrim);
        expect(hint).toHaveAttribute("data-shown");
        settle();
        expect(nudge.style.transform).toBe(stepped);
        // The blur stays whole.
        expect(scrim.style.opacity).toBe("");
        // Rested, no layer of its own.
        expect(nudge.style.willChange).toBe("");
        // Onto the window: back at once, the scrim whole, the hint gone.
        pointerAt(500, 400, surface);
        expect(hint).not.toHaveAttribute("data-shown");
        settle();
        expect(nudge.style.transform).toBe("");
        expect(scrim.style.opacity).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("does not answer a pointer crossing the scrim on its way", () => {
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        for (let step = 0; step < 8; step += 1) {
          pointerAt(10 + step * 40, 20, scrim);
          act(() => {
            vi.advanceTimersByTime(16);
          });
        }
        settle();
        expect(hint).not.toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("bounds the band by the window's place: a pointer just over the window stays stepped", () => {
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        // Just over the window's top; the step moves the window away from it.
        restAt(500, 39, scrim);
        settle();
        expect(hint).toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe(stepped);
      } finally {
        cleanUp();
      }
    });

    it("gives no step on the scrim's sides or under the window, and a press there still closes", () => {
      try {
        const { view, scrim, nudge, hint, settle } = steppedPeek();
        restAt(20, 400, scrim);
        restAt(980, 400, scrim);
        restAt(500, 790, scrim);
        settle();
        expect(hint).not.toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
        act(() => {
          scrim.click();
        });
        expect(view.onClose).toHaveBeenCalledTimes(1);
      } finally {
        cleanUp();
      }
    });

    it("does not answer a touch, which has no pointer resting on the scrim", () => {
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        pointerAt(500, 20, scrim, "touch");
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        settle();
        expect(hint).not.toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("shows the hint alone with reduced motion (О13)", () => {
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true }) as unknown as MediaQueryList));
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        restAt(500, 20, scrim);
        settle();
        expect(hint).toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("stands the hint in the free band over the stepped window, across the right part", () => {
      try {
        const { hint } = steppedPeek();
        // M and the step down, and half the scale's share of the window's
        // height (the right part less M on either side).
        expect(CARD_PEEK_NUDGE_OFFSET_PX).toBeCloseTo(6.667, 3);
        expect(hint.style.height).toBe("calc(46.667px + 0.004167 * (100% - 80px))");
        expect(hint).toHaveClass("inset-x-0", "top-0", "justify-center", "items-center");
      } finally {
        cleanUp();
      }
    });

    it("turns no step on for a pointer heading down to the window, and steps once it stops", () => {
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        // Slowly down toward the header's buttons, never still: no step.
        for (let y = 4; y < 36; y += 2) {
          pointerAt(500, y, scrim);
          expect(hint).not.toHaveAttribute("data-shown");
          act(() => {
            vi.advanceTimersByTime(16);
          });
        }
        settle();
        expect(nudge.style.transform).toBe("");
        // Still on the band for the speed's window: stopped, the step comes.
        act(() => {
          vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs);
        });
        expect(hint).toHaveAttribute("data-shown");
      } finally {
        cleanUp();
      }
    });

    it("holds a step it turned on while the pointer stays on the band, any way and however fast it goes", () => {
      try {
        const { scrim, surface, nudge, hint, settle } = steppedPeek();
        restAt(500, 10, scrim);
        settle();
        expect(nudge.style.transform).toBe(stepped);
        const path: [number, number, number][] = [
          // Down, then a jitter down and up, then fast along and back, with pauses.
          [500, 14, 16], [500, 18, 16], [500, 22, 16], [501, 21, 16], [502, 24, 16], [503, 22, 16],
          [900, 24, 16], [100, 30, 16], [100, 30, 400], [120, 34, 16], [118, 31, 16], [500, 36, 300],
        ];
        for (const [x, y, wait] of path) {
          pointerAt(x, y, scrim);
          expect(hint).toHaveAttribute("data-shown");
          act(() => {
            vi.advanceTimersByTime(wait);
          });
          expect(hint).toHaveAttribute("data-shown");
        }
        settle();
        expect(nudge.style.transform).toBe(stepped);
        // Off the band, onto the window: the step goes; back on the band
        // heading down, none comes until the pointer stops.
        pointerAt(500, 400, surface);
        expect(hint).not.toHaveAttribute("data-shown");
        pointerAt(500, 20, scrim);
        pointerAt(500, 26, scrim);
        expect(hint).not.toHaveAttribute("data-shown");
      } finally {
        cleanUp();
      }
    });

    it("does not close on a press inside the window's own place, where the step shows the scrim", () => {
      try {
        const { view, scrim } = steppedPeek();
        fireEvent.click(scrim, { clientX: 500, clientY: 43, detail: 1 });
        expect(view.onClose).not.toHaveBeenCalled();
        fireEvent.click(scrim, { clientX: 500, clientY: 20, detail: 1 });
        expect(view.onClose).toHaveBeenCalledTimes(1);
      } finally {
        cleanUp();
      }
    });

    it("gives no step while a press is held down", () => {
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        for (let step = 0; step < 6; step += 1) {
          pointerAt(500 + step, 20, scrim, "mouse", 1);
          act(() => {
            vi.advanceTimersByTime(16);
          });
        }
        act(() => {
          vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs);
        });
        settle();
        expect(hint).not.toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("gives no step while a menu is open, and steps back to its place when one opens", async () => {
      try {
        const { scrim, nudge, hint, settle } = steppedPeek();
        restAt(500, 20, scrim);
        settle();
        expect(nudge.style.transform).toBe(stepped);
        await act(async () => {
          document.documentElement.setAttribute("data-menu-open", "");
        });
        settle();
        expect(hint).not.toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
        await act(async () => {
          document.documentElement.removeAttribute("data-menu-open");
        });
        expect(hint).toHaveAttribute("data-shown");
      } finally {
        document.documentElement.removeAttribute("data-menu-open");
        cleanUp();
      }
    });

    it("keeps the step when the app's window loses the focus: only leaving the page ends it", () => {
      try {
        const { scrim, nudge, settle } = steppedPeek();
        restAt(500, 20, scrim);
        settle();
        act(() => {
          globalThis.dispatchEvent(new Event("blur"));
        });
        settle();
        expect(nudge.style.transform).toBe(stepped);
        act(() => {
          document.documentElement.dispatchEvent(new Event("pointerleave"));
        });
        settle();
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("drops the step when the right part moves from under a still pointer, until it moves again", () => {
      try {
        const { scrim, nudge, hint, settle, moveArea } = steppedPeek();
        restAt(100, 20, scrim);
        settle();
        expect(nudge.style.transform).toBe(stepped);
        // A wider sidebar: the right part now starts right of the pointer.
        moveArea(300);
        expect(hint).not.toHaveAttribute("data-shown");
        settle();
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("gives no step to a pointer already on the band when the window opens, until it moves (С7.5)", () => {
      try {
        const { hint, nudge, settle } = steppedPeek();
        settle();
        expect(hint).not.toHaveAttribute("data-shown");
        expect(nudge.style.transform).toBe("");
      } finally {
        cleanUp();
      }
    });

    it("lands on its card from where the stepped window stands when it closes, the scrim led by the closing alone", () => {
      try {
        const { view, scrim, nudge, settle } = steppedPeek();
        restAt(500, 20, scrim);
        settle();
        view.rerenderWith({ block: null, opening: restored });
        // The closing carries the step in its own share: none by its end.
        const handed: { transform: string; scrim: string }[] = [];
        for (let frame = 0; frame < 120 && view.container.querySelector("[data-card-peek]"); frame += 1) {
          handed.push({ transform: nudge.style.transform, scrim: scrim.style.opacity });
          settle();
        }
        expect(handed[0]?.transform).toBe(stepped);
        // Whole until the closing leads it.
        expect(handed[0]?.scrim).toBe("");
        expect(view.container.querySelector("[data-card-peek]")).toBeNull();
      } finally {
        cleanUp();
      }
    });
  });

  describe("closing with no place for its card (О11)", () => {
    function grownFromCard() {
      const frames = handFrames();
      const card = { rect: { x: 100, y: 100, width: 200, height: 150 }, radius: 8, fill: "#fff", media: null };
      let shown = true;
      const unregister = registerPeekGraphSource(() => (shown ? card : null));
      // The right part, 1000 × 800, measured from the opening on.
      const areaBox = { left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      const measure = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return this.tagName === "MAIN" ? areaBox : measure.call(this);
      });
      const view = peek({ block, opening: { sequence: 1, slug: block.slug, from: "card", restored: false } });
      const run = (count: number) => {
        for (let frame = 0; frame < count; frame += 1) frames.run(() => null);
      };
      return { view, run, unregister, hideCard: () => { shown = false; } };
    }

    it("leaves as a dialog does when the card is gone from the screen as the closing starts", () => {
      const { view, run, unregister, hideCard } = grownFromCard();
      try {
        run(80);
        // Another place: the card is no longer on screen.
        hideCard();
        view.rerenderWith({ block: null, opening: null });
        run(4);
        const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
        const scrim = view.container.querySelector<HTMLElement>("[data-card-peek-scrim]")!;
        expect(window).toHaveClass("animate-out", "fade-out-0", "zoom-out-95", "duration-200");
        expect(scrim).toHaveClass("animate-out", "fade-out-0");
        expect(view.container.querySelector("[data-peek-piece]")).toBeNull();
        // The exit's end (jsdom has no AnimationEvent: React hears the
        // prefixed name there).
        fireEvent.animationEnd(window);
        fireEvent(window, new Event("webkitAnimationEnd", { bubbles: true }));
        expect(view.container.querySelector("[data-card-peek]")).toBeNull();
      } finally {
        unregister();
        vi.restoreAllMocks();
      }
    });

    it("shrinks into the card when the closing finds it on screen", () => {
      const { view, run, unregister } = grownFromCard();
      try {
        run(80);
        view.rerenderWith({ block: null, opening: null });
        run(4);
        const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
        expect(window).not.toHaveClass("animate-out");
        expect(view.container.querySelector("[data-peek-piece]")).not.toBeNull();
        // Shrinking into the card: the window's corner is the card's at its end.
        expect(getPeekHiddenSlug()).toBe(block.slug);
      } finally {
        unregister();
        vi.restoreAllMocks();
      }
    });

    it("shows the card under the window a frame before the window leaves", () => {
      const { view, run, unregister } = grownFromCard();
      try {
        run(80);
        view.rerenderWith({ block: null, opening: null });
        const seen: { hidden: boolean; window: boolean }[] = [];
        for (let frame = 0; frame < 120; frame += 1) {
          run(1);
          seen.push({ hidden: getPeekHiddenSlug() === block.slug, window: view.container.querySelector("[data-card-peek-window]") !== null });
          if (!seen.at(-1)!.window) break;
        }
        const shown = seen.findIndex((state) => !state.hidden);
        expect(shown).toBeGreaterThan(0);
        // The card back under the window for one frame, then the window gone.
        expect(seen[shown]).toEqual({ hidden: false, window: true });
        expect(seen[shown + 1]).toEqual({ hidden: false, window: false });
      } finally {
        unregister();
        vi.restoreAllMocks();
      }
    });
  });

  describe("double clicks (О11)", () => {
    it("does not close on the second press of a double click, the one that opened the window", () => {
      const view = peek({ block, opening: restored });
      const scrim = view.container.querySelector<HTMLElement>("[data-card-peek-scrim]")!;
      fireEvent.click(scrim, { detail: 2 });
      expect(view.onClose).not.toHaveBeenCalled();
      fireEvent.click(scrim, { detail: 1 });
      expect(view.onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps the second press of the double click that closed the window from the feed, a single press passes", () => {
      const frames = handFrames();
      const card = document.createElement("button");
      const opened = vi.fn();
      card.addEventListener("click", opened);
      document.body.append(card);
      try {
        const view = peek({ block, opening: restored });
        view.rerenderWith({ block: null, opening: restored });
        frames.run(() => null);
        fireEvent.click(card, { detail: 2 });
        expect(opened).not.toHaveBeenCalled();
        fireEvent.click(card, { detail: 1 });
        expect(opened).toHaveBeenCalledTimes(1);
      } finally {
        card.remove();
        vi.restoreAllMocks();
      }
    });
  });

  describe("Escape (О11)", () => {
    const key = (type: "keydown" | "keyup") => act(() => {
      window.dispatchEvent(new KeyboardEvent(type, { key: "Escape", bubbles: true }));
    });

    it("closes the window at once from rest: gone in the frame of the key, no movement", () => {
      const view = peek({ block, opening: restored });
      key("keydown");
      // The page closes the card on the key (Detail.tsx).
      view.rerenderWith({ block: null, opening: restored });
      expect(view.container.querySelector("[data-card-peek]")).toBeNull();
      key("keyup");
    });

    it("closes at once a window already closing, mid-movement", () => {
      const frames = handFrames();
      try {
        const view = peek({ block, opening: restored });
        view.rerenderWith({ block: null, opening: restored });
        for (let frame = 0; frame < 8; frame += 1) frames.run(() => null);
        expect(view.container.querySelector("[data-peek-piece]")).not.toBeNull();
        key("keydown");
        expect(view.container.querySelector("[data-card-peek]")).toBeNull();
        key("keyup");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("closes at once a window still growing, the page told to close", () => {
      const frames = handFrames();
      try {
        const view = peek({ block, opening: { ...restored, restored: false } });
        let growing = false;
        for (let frame = 0; frame < 40 && !growing; frame += 1) {
          growing = frames.run(() => view.container.querySelector("[data-peek-piece]") !== null
            && (view.container.querySelector<HTMLElement>("[data-card-peek-scrim]")?.style.opacity ?? "") !== "0");
        }
        expect(growing).toBe(true);
        key("keydown");
        expect(view.onClose).toHaveBeenCalledTimes(1);
        view.rerenderWith({ block: null, opening: { ...restored, restored: false } });
        expect(view.container.querySelector("[data-card-peek]")).toBeNull();
        key("keyup");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("leaves other closings their movement once the key is let go", () => {
      const frames = handFrames();
      try {
        const view = peek({ block, opening: restored });
        key("keydown");
        key("keyup");
        view.rerenderWith({ block: null, opening: restored });
        frames.run(() => null);
        expect(view.container.querySelector("[data-card-peek]")).not.toBeNull();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it("takes its layers apart last, frames after the frame's pieces go, once it opened (О12)", () => {
    const frames = handFrames();
    try {
      const view = peek({ block, opening: { ...restored, restored: false } });
      const shown: { pieces: boolean; layer: string }[] = [];
      for (let frame = 0; frame < 120; frame += 1) {
        shown.push(frames.run(() => ({
          pieces: view.container.querySelector("[data-peek-piece]") !== null,
          layer: view.container.querySelector<HTMLElement>("[data-card-peek-surface]")?.style.willChange ?? "",
        })));
        if (shown.length > 2 && !shown.at(-1)!.pieces && shown.at(-1)!.layer === "" && shown.some((state) => state.layer !== "")) break;
      }
      const piecesGone = shown.findIndex((state, frame) => shown[frame - 1]?.pieces === true && !state.pieces);
      const layersGone = shown.findIndex((state, frame) => Boolean(shown[frame - 1]?.layer) && state.layer === "");
      expect(piecesGone).toBeGreaterThan(0);
      expect(layersGone).toBeGreaterThan(piecesGone);
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe("its width for the card's layout (О3, О8)", () => {
    /** A card that tells its window a content `width` wide, its inset 32 px,
     *  and shows the layout the window gives it. */
    function TellingCard({ width }: { width: number }) {
      const frame = useDetailFrame();
      useLayoutEffect(() => {
        frame?.report(width, 32);
      }, [frame, width]);
      return <p data-testid="layout">{frame?.layout ?? "none"}</p>;
    }

    /** The window over a right part `areaWidth` wide, with resize
     *  notifications run by hand. */
    function framedPeek(areaWidth: number) {
      const observers: ResizeObserverCallback[] = [];
      vi.stubGlobal("ResizeObserver", class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      });
      const area = document.createElement("main");
      document.body.append(area);
      let width = areaWidth;
      Object.defineProperty(area, "offsetWidth", { configurable: true, get: () => width });
      const areaRef = createRef<HTMLElement>();
      Object.assign(areaRef, { current: area });
      const view = render(
        <CardPeek block={block} opening={restored} exit="return" areaRef={areaRef} onClose={vi.fn()} onReopen={vi.fn()}>
          {() => <TellingCard width={400} />}
        </CardPeek>,
      );
      const resize = async (next: number) => {
        width = next;
        await act(async () => {
          for (const callback of observers) callback([], {} as ResizeObserver);
        });
      };
      return { ...view, resize };
    }

    it("puts the panel beside the content while the place holds it, and narrows to the content once it does not", async () => {
      try {
        // 1440 less M on either side holds 4 × 32 + 400 + 321 + 2.
        const view = framedPeek(1440);
        await view.resize(1440);
        expect(view.getByTestId("layout")).toHaveTextContent("rail");
        const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
        expect(window.style.maxWidth).toBe("calc(1001px + 4 * var(--card-content-pad) + 2px)");
        await view.resize(900);
        expect(view.getByTestId("layout")).toHaveTextContent("stacked");
        expect(window.style.maxWidth).toBe("calc(402px + 2 * var(--card-content-pad))");
        // Back where the place holds the panel: the narrowed window widens.
        await view.resize(1000);
        expect(view.getByTestId("layout")).toHaveTextContent("rail");
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("moves its edges to the new width by the spring once it shows, then rests with no pieces (О12)", async () => {
      const frames = handFrames();
      // The window's laid-out width, as CSS gives it with a 32 px inset.
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        if (!this.hasAttribute("data-card-peek-window")) return 0;
        return this.style.maxWidth.startsWith("calc(402px") ? 466 : 1131;
      });
      try {
        const view = framedPeek(1440);
        await view.resize(1440);
        // Told for the first time: the window stands at its width at once.
        expect(view.container.querySelector("[data-peek-piece]")).toBeNull();
        await view.resize(900);
        expect(view.container.querySelector("[data-card-peek-surface]")).toHaveAttribute("data-moving");
        expect(view.container.querySelector("[data-peek-piece]")).not.toBeNull();
        let rested = false;
        for (let frame = 0; frame < 120 && !rested; frame += 1) {
          rested = frames.run(() => view.container.querySelector("[data-peek-piece]") === null
            && view.container.querySelector<HTMLElement>("[data-card-peek-surface]")?.style.willChange === "");
        }
        expect(rested).toBe(true);
        expect(view.getByTestId("layout")).toHaveTextContent("stacked");
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("stands `M` off every edge with «Peek width» Fill, the place deciding the card's layout (О3)", async () => {
      setPeekWidth("fill");
      try {
        const view = framedPeek(1440);
        await view.resize(1440);
        const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
        expect(window.style.maxWidth).toBe("none");
        expect(window.style.inset).toBe("40px");
        expect(view.getByTestId("layout")).toHaveTextContent("rail");
        // No room for the panel beside a 400 px content: under it, and the
        // window still fills the place.
        await view.resize(900);
        expect(view.getByTestId("layout")).toHaveTextContent("stacked");
        expect(window.style.maxWidth).toBe("none");
      } finally {
        setPeekWidth("fit");
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("goes to the new width by the spring when «Peek width» changes while it is open (О3, О12)", async () => {
      const frames = handFrames();
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        if (!this.hasAttribute("data-card-peek-window")) return 0;
        return this.style.maxWidth === "none" ? 1360 : 1131;
      });
      try {
        const view = framedPeek(1440);
        await view.resize(1440);
        expect(view.container.querySelector("[data-peek-piece]")).toBeNull();
        await act(async () => {
          setPeekWidth("fill");
        });
        const window = view.container.querySelector<HTMLElement>("[data-card-peek-window]")!;
        expect(window.style.maxWidth).toBe("none");
        expect(view.container.querySelector("[data-card-peek-surface]")).toHaveAttribute("data-moving");
        let rested = false;
        for (let frame = 0; frame < 120 && !rested; frame += 1) {
          rested = frames.run(() => view.container.querySelector("[data-peek-piece]") === null);
        }
        expect(rested).toBe(true);
      } finally {
        setPeekWidth("fit");
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });

    it("stands at the new width at once with reduced motion (О13)", async () => {
      const matchMedia = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList);
      vi.stubGlobal("matchMedia", matchMedia);
      try {
        const view = framedPeek(1440);
        await view.resize(1440);
        await view.resize(900);
        expect(view.getByTestId("layout")).toHaveTextContent("stacked");
        expect(view.container.querySelector("[data-peek-piece]")).toBeNull();
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });
  });

  it("changes the card in place when another opens from it (О2)", () => {
    const view = peek({ block, opening: restored });
    const other = { slug: "Cards/Two", id: 2 } as unknown as LightBlock;
    view.rerenderWith({ block: other, opening: restored });
    expect(view.getByTestId("content")).toHaveTextContent("Cards/Two");
    expect(view.container.querySelector("[data-card-peek-surface]")).not.toHaveAttribute("data-moving");
  });
});

/// TRIAL (SPEC_CARD_PEEK.md, О9): the window's plate.
describe("CardPeekPlate", () => {
  function plate(sequence: number, onExpand = vi.fn(), onClose = vi.fn()) {
    return (
      <TooltipProvider>
        <CardPeekPlate
          block={block}
          vaultPath="/v"
          tags={[]}
          onToggleTag={vi.fn()}
          onCreateAndAssign={vi.fn()}
          onRequestRename={vi.fn()}
          onRequestDelete={vi.fn()}
          onRenameFile={vi.fn(async () => {})}
          onCheckFileName={vi.fn(async () => null)}
          onExpand={onExpand}
          onClose={onClose}
          menuOpenRequestSequence={sequence}
        />
      </TooltipProvider>
    );
  }

  it("holds full page first, then the file's name, the menu and the close", () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    render(plate(0, onExpand, onClose));
    const buttons = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(buttons[0]).toBe("Open as full page");
    expect(buttons.at(-1)).toBe("Close");
    expect(screen.getByText("One")).toHaveAttribute("data-secondary-detail-card-name");
    fireEvent.click(screen.getByRole("button", { name: "Open as full page" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens its menu on ⌘K pressed while the window is open, not on one pressed before", async () => {
    const view = render(plate(4));
    expect(screen.queryByRole("menu")).toBeNull();
    view.rerender(plate(5));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
  });
});
