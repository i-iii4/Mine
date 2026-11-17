import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_INTENT } from "./hoverIntent";
import {
  HOVER_PREVIEW_WINDOW_SETTLE_MS,
  HoverPreviewPresenter,
  hoverPreviewClampLeft,
  hoverPreviewClampTop,
  type HoverPreviewDropReason,
  type HoverPreviewPlace,
  type HoverPreviewStageHost,
  type HoverPreviewTarget,
  type HoverPreviewWindowPaint,
} from "./hoverPreviewPresenter";

const FRAME_MS = 16;

interface Target extends HoverPreviewTarget {
  place: HoverPreviewPlace | null;
}

/** The window alone, driven as the pointer's part drives it (SPEC_OUTSIDE_WINDOW.md, НО6). */
function setup(options: { area?: { left: number; top: number; right: number; bottom: number } } = {}) {
  const wanted = { key: null as string | null };
  const events: string[] = [];
  const dropped: HoverPreviewDropReason[] = [];
  const paints: HoverPreviewWindowPaint[] = [];
  const presenter = new HoverPreviewPresenter<Target, { slug: string }>({
    place: (target) => target.place,
    area: options.area ? () => options.area! : undefined,
  });
  const host: HoverPreviewStageHost<Target> = {
    stillWanted: (key) => wanted.key === key,
    onSettled: (target) => events.push(`settled:${target.key}`),
    onHidden: () => events.push("hidden"),
    onDropped: (reason) => dropped.push(reason),
    onTargetGone: () => events.push("gone"),
  };
  presenter.setHost(host);
  presenter.setPainter((paint) => paints.push(paint));
  const target = (key: string, place: HoverPreviewPlace | null): Target => ({ key, slug: key, place });
  /** Offers `target`'s card and says it is ready with `height`. */
  const bring = (next: Target, height = 200) => {
    wanted.key = next.key;
    presenter.offer(next, { slug: next.slug });
    const pending = presenter.getView()?.layers.find((layer) => layer.role === "pending");
    presenter.prepared(pending!.id, { height, mediaHeight: 0, radius: 0 });
  };
  const advance = (ms: number) => vi.advanceTimersByTime(ms);
  const last = () => paints[paints.length - 1]!;
  const shown = () => ({ left: last().left + last().translateX, top: last().laidTop + last().translateY });
  return { presenter, wanted, events, dropped, paints, target, bring, advance, last, shown };
}

describe("the hover preview window on its own (SPEC_OUTSIDE_WINDOW.md, НО6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 1400);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows an offered card at its place once it is ready, fading in, and tells it settled", () => {
    const context = setup();
    context.bring(context.target("a", { left: 300, top: 100 }));
    expect(context.presenter.phase()).toBe("open");
    expect(context.presenter.shownKey()).toBe("a");
    expect(context.events).toEqual(["settled:a"]);
    expect(context.shown()).toEqual({ left: 300, top: 100 });
    expect(context.last().opacity).toBe(0);
    context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);
    expect(context.last().opacity).toBe(1);
    context.presenter.dispose();
  });

  it("drops a ready card the pointer has left, and one whose target has no place", () => {
    const context = setup();
    context.presenter.offer(context.target("a", { left: 300, top: 100 }), { slug: "a" });
    context.wanted.key = "b";
    const pending = context.presenter.getView()!.layers[0]!;
    context.presenter.prepared(pending.id, { height: 200, mediaHeight: 0, radius: 0 });
    expect(context.presenter.phase()).toBe("closed");
    expect(context.presenter.getView()).toBeNull();
    context.bring(context.target("b", null));
    expect(context.dropped).toEqual(["left", "unplaced-closed"]);
    context.bring(context.target("c", { left: 300, top: 100 }));
    context.bring(context.target("d", null));
    expect(context.dropped).toEqual(["left", "unplaced-closed", "unplaced-open"]);
    expect(context.presenter.shownKey()).toBe("c");
    context.presenter.dispose();
  });

  it("springs to the next card's place and comes back round from a fade to its own", () => {
    const context = setup();
    context.bring(context.target("a", { left: 300, top: 100 }));
    context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);
    context.bring(context.target("b", { left: 300, top: 400 }));
    context.advance(FRAME_MS * 4);
    expect(context.shown().top).toBeGreaterThan(100);
    expect(context.shown().top).toBeLessThan(400);
    context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS);
    expect(context.shown()).toEqual({ left: 300, top: 400 });

    context.presenter.fadeOut();
    expect(context.presenter.phase()).toBe("leaving");
    expect(context.presenter.fadingKey()).toBe("b");
    expect(context.events.at(-1)).toBe("hidden");
    context.advance(FRAME_MS);
    context.presenter.bringBack(context.target("b", { left: 300, top: 400 }));
    expect(context.presenter.phase()).toBe("open");
    expect(context.events.at(-1)).toBe("settled:b");
    context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);
    expect(context.last().opacity).toBe(1);
    context.presenter.dispose();
  });

  it("keeps inside the area it is given, the screen's bound outside the app window (ПН2)", () => {
    const area = { left: 0, top: 30, right: 1700, bottom: 1080 };
    expect(hoverPreviewClampTop(-50, 200, area)).toBe(30);
    expect(hoverPreviewClampTop(1000, 200, area)).toBe(880);
    expect(hoverPreviewClampLeft(1600, area)).toBe(1460);
    const context = setup({ area });
    context.bring(context.target("a", { left: 1600, top: 1000 }));
    expect(context.shown()).toEqual({ left: 1460, top: 880 });
    context.presenter.dispose();
  });

  it("closes at once and tells the card is gone", () => {
    const context = setup();
    context.bring(context.target("a", { left: 300, top: 100 }));
    context.presenter.close();
    expect(context.presenter.phase()).toBe("closed");
    expect(context.presenter.getView()).toBeNull();
    expect(context.events).toEqual(["settled:a", "hidden"]);
    context.presenter.dispose();
  });
});
