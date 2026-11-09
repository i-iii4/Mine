import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPRING_RESPONSE_S, springSettleMs } from "./channelIcon";
import { FLOATING_LAYER_EDGE_PX } from "./floatingLayer";
import { HOVER_INTENT } from "./hoverIntent";
import {
  HOVER_PREVIEW_COLD_OPEN_DELAY_MS,
  HOVER_PREVIEW_WARM_WINDOW_MS,
  HoverPreviewOpener,
} from "./hoverPreviewTiming";
import {
  HOVER_PREVIEW_WINDOW_GAP_PX,
  HOVER_PREVIEW_WINDOW_SETTLE_MS,
  HOVER_PREVIEW_WINDOW_WIDTH_PX,
  HoverPreviewWindow,
  hoverPreviewBesidePanel,
  hoverPreviewCoverScale,
  hoverPreviewWindowLeft,
  hoverPreviewWindowRowLeft,
  hoverPreviewWindowRowTop,
  hoverPreviewWindowTop,
  stepHoverPreviewSpring,
  type HoverPreviewElementTarget,
  type HoverPreviewMeasure,
  type HoverPreviewPlace,
  type HoverPreviewTarget,
  type HoverPreviewWindowPaint,
} from "./hoverPreviewWindow";

const FRAME_MS = 16;

describe("the window's geometry (SPEC_CARD_STATES.md, С7.11)", () => {
  const width = HOVER_PREVIEW_WINDOW_WIDTH_PX;

  it("takes the card's width of С10.4 and the floating layer's margin", () => {
    expect(width).toBe(240);
    expect(FLOATING_LAYER_EDGE_PX).toBe(8);
  });

  it("stands beside the panel: after the sidebar, before the open card's panel", () => {
    expect(hoverPreviewWindowLeft({ left: 0, right: 280 }, 1400, "after")).toBe(280 + HOVER_PREVIEW_WINDOW_GAP_PX);
    expect(hoverPreviewWindowLeft({ left: 1100, right: 1400 }, 1400, "before")).toBe(1100 - HOVER_PREVIEW_WINDOW_GAP_PX - width);
  });

  it("takes the other side when the preferred one has no room, and none when neither has", () => {
    expect(hoverPreviewWindowLeft({ left: 300, right: 1300 }, 1400, "after")).toBe(300 - HOVER_PREVIEW_WINDOW_GAP_PX - width);
    expect(hoverPreviewWindowLeft({ left: 100, right: 400 }, 1400, "before")).toBe(400 + HOVER_PREVIEW_WINDOW_GAP_PX);
    expect(hoverPreviewWindowLeft({ left: 100, right: 900 }, 1000, "before")).toBeNull();
  });

  it("centres on its trigger's centre, kept 8 px off the app window's edges", () => {
    expect(hoverPreviewWindowTop(400, 200, 800)).toBe(300);
    expect(hoverPreviewWindowTop(10, 200, 800)).toBe(FLOATING_LAYER_EDGE_PX);
    expect(hoverPreviewWindowTop(795, 200, 800)).toBe(800 - FLOATING_LAYER_EDGE_PX - 200);
  });

  it("keeps the top in reach of a frame taller than the app window", () => {
    expect(hoverPreviewWindowTop(400, 900, 800)).toBe(FLOATING_LAYER_EDGE_PX);
  });

  it("with no room beside the panel stands under the row, or over it, right edge on the row's", () => {
    expect(hoverPreviewWindowRowLeft({ left: 100, right: 700 }, 800)).toBe(700 - width);
    expect(hoverPreviewWindowRowTop({ top: 100, bottom: 140 }, 200, 800)).toBe(140 + HOVER_PREVIEW_WINDOW_GAP_PX);
    expect(hoverPreviewWindowRowTop({ top: 600, bottom: 640 }, 200, 800)).toBe(600 - HOVER_PREVIEW_WINDOW_GAP_PX - 200);
  });

  it("fills a frame taller than the card by growing its media uniformly, never below 1", () => {
    expect(hoverPreviewCoverScale(100, 200, 170)).toBe(1);
    expect(hoverPreviewCoverScale(200, 200, 170)).toBe(1);
    expect(hoverPreviewCoverScale(370, 200, 170)).toBe(2);
    expect(hoverPreviewCoverScale(370, 200, 0)).toBe(1);
  });
});

describe("the window's spring", () => {
  const run = (spring: ReturnType<typeof stepHoverPreviewSpring>, ms: number) => {
    let current = spring;
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) current = stepHoverPreviewSpring(current, FRAME_MS);
    return current;
  };

  it("is the menu's spring: response 0.3 s, settled in 441 ms", () => {
    expect(SPRING_RESPONSE_S).toBe(0.3);
    expect(HOVER_PREVIEW_WINDOW_SETTLE_MS).toBe(springSettleMs(SPRING_RESPONSE_S));
    expect(HOVER_PREVIEW_WINDOW_SETTLE_MS).toBe(441);
    const settled = run({ position: 0, velocity: 0, target: 100 }, 448);
    expect(Math.abs(settled.position - 100)).toBeLessThan(0.1);
  });

  it("never overshoots from rest", () => {
    let spring = { position: 0, velocity: 0, target: 100 };
    let highest = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      spring = stepHoverPreviewSpring(spring, FRAME_MS);
      highest = Math.max(highest, spring.position);
    }
    expect(highest).toBeLessThanOrEqual(100);
  });

  it("takes a new target from where it is, at the speed it has", () => {
    const moving = run({ position: 0, velocity: 0, target: 100 }, 80);
    const retargeted = { ...moving, target: -50 };
    expect(retargeted.position).toBe(moving.position);
    expect(retargeted.velocity).toBe(moving.velocity);
    const next = stepHoverPreviewSpring(retargeted, FRAME_MS);
    // Still on its way up for that frame: it brakes, it does not jump.
    expect(next.position).toBeGreaterThan(moving.position);
    expect(next.position - moving.position).toBeLessThan(moving.velocity * (FRAME_MS / 1000) * 1.01);
    expect(next.velocity).toBeLessThan(moving.velocity);
  });
});

/** A trigger 40 px tall, centred on `centerY`, as the window reads it. */
function triggerAt(centerY: number, span = { left: 0, right: 280 }): Element {
  return {
    getBoundingClientRect: () => ({ ...span, top: centerY - 20, bottom: centerY + 20 }),
  } as unknown as Element;
}

/** What the component does: reads the measure, then says the card is ready. */
function setup(options: {
  hold?: boolean;
  attending?: boolean;
  heights?: Record<string, number>;
  panel?: { left: number; right: number };
} = {}) {
  const state = { attending: options.attending ?? true };
  const paints: HoverPreviewWindowPaint[] = [];
  const shown: (string | null)[] = [];
  const heights = options.heights ?? {};
  const measureOf = (slug: string): HoverPreviewMeasure => ({
    height: heights[slug] ?? 200,
    mediaHeight: 0,
    radius: 0,
  });
  const opener = new HoverPreviewOpener(() => state.attending);
  const readCard = vi.fn(async (slug: string) => ({ slug }));
  const preview = new HoverPreviewWindow<HoverPreviewElementTarget, { slug: string }>({
    opener,
    isAttending: () => state.attending,
    readCard,
    place: hoverPreviewBesidePanel(() => options.panel ?? { left: 0, right: 280 }, "after"),
    onShown: (target) => shown.push(target?.slug ?? null),
  });
  preview.setPainter((paint) => paints.push(paint));
  const held: { id: number; slug: string }[] = [];
  const seen = new Set<number>();
  preview.subscribe(() => {
    const pending = preview.getView()?.layers.find((layer) => layer.role === "pending");
    if (!pending || seen.has(pending.id)) return;
    seen.add(pending.id);
    if (options.hold) held.push({ id: pending.id, slug: pending.card.slug });
    else queueMicrotask(() => preview.prepared(pending.id, measureOf(pending.card.slug)));
  });
  const target = (slug: string, centerY = 400): HoverPreviewElementTarget => ({
    key: `row:${slug}`,
    slug,
    element: triggerAt(centerY),
  });
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await flush();
  };
  const current = () => preview.getView()?.layers.filter((layer) => layer.role === "current").map((layer) => layer.card.slug);
  const last = () => paints[paints.length - 1]!;
  const shownTop = () => last().laidTop + last().translateY;
  return { preview, state, paints, shown, readCard, held, target, flush, advance, current, last, shownTop, measureOf };
}

/** The first window, on `slug`'s trigger centred on `y`, its fade done. */
async function openAt(context: ReturnType<typeof setup>, slug: string, y: number) {
  context.preview.pointer(context.target(slug, y));
  await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
  await context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);
}

describe("one window over the list (SPEC_CARD_STATES.md, С7.11)", () => {
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

  it("appears after the cold delay, at its trigger at once, fading in over the fade-in", async () => {
    const context = setup();
    context.preview.pointer(context.target("a", 400));
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
    expect(context.preview.getView()).toBeNull();
    await context.advance(1);
    expect(context.preview.getView()?.shown).toBe(true);
    expect(context.current()).toEqual(["a"]);
    expect(context.last().left).toBe(280 + HOVER_PREVIEW_WINDOW_GAP_PX);
    // On its trigger's centre in its first frame: no flight.
    expect(context.last().opacity).toBe(0);
    expect(context.shownTop()).toBe(400 - 100);
    expect(context.last().translateY).toBe(0);
    await context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);
    expect(context.last().opacity).toBe(1);
    expect(context.shownTop()).toBe(400 - 100);
    context.preview.dispose();
  });

  it("does not move at all while the pointer moves inside one trigger", async () => {
    const context = setup();
    await openAt(context, "a", 400);
    const painted = context.paints.length;
    context.readCard.mockClear();
    for (let step = 0; step < 6; step += 1) {
      context.preview.pointer(context.target("a", 400));
      await context.advance(FRAME_MS);
    }
    context.preview.attendingChanged();
    await context.advance(FRAME_MS * 4);
    expect(context.paints.length).toBe(painted);
    expect(context.last().moving).toBe(false);
    expect(context.readCard).not.toHaveBeenCalled();
    context.preview.dispose();
  });

  it("goes to the next trigger with its card in one motion by the spring, and rests with no layer", async () => {
    const context = setup();
    await openAt(context, "a", 200);
    const left = context.last().left;

    context.preview.pointer(context.target("b", 500));
    await context.flush();
    expect(context.current()).toEqual(["b"]);
    const tops = [context.shownTop()];
    expect(tops[0]).toBe(200 - 100);
    expect(context.last().moving).toBe(true);
    while (context.last().moving) {
      await context.advance(FRAME_MS);
      tops.push(context.shownTop());
      expect(context.last().left).toBe(left);
    }
    // One motion: never back, never past the place.
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]!).toBeGreaterThanOrEqual(tops[index - 1]!);
      expect(tops[index]!).toBeLessThanOrEqual(500 - 100);
    }
    expect(tops[tops.length - 1]).toBe(500 - 100);
    expect(tops.length * FRAME_MS).toBeGreaterThanOrEqual(HOVER_PREVIEW_WINDOW_SETTLE_MS);
    const rest = context.last();
    expect(rest.translateY).toBe(0);
    expect(rest.laidTop).toBe(400);
    expect(rest.left).toBe(left);
    const painted = context.paints.length;
    await context.advance(FRAME_MS * 10);
    expect(context.paints.length).toBe(painted);
    context.preview.dispose();
  });

  it("takes a new trigger in mid-motion from where it is, at the speed it has", async () => {
    const context = setup();
    await openAt(context, "a", 200);
    context.preview.pointer(context.target("b", 700));
    await context.flush();
    await context.advance(FRAME_MS * 5);
    const before = context.shownTop();
    await context.advance(FRAME_MS);
    const at = context.shownTop();
    const step = at - before;
    expect(step).toBeGreaterThan(0);

    context.preview.pointer(context.target("c", 200));
    await context.flush();
    // The change itself moves nothing.
    expect(context.shownTop()).toBe(at);
    await context.advance(FRAME_MS);
    // Still on its way down for that frame: it brakes, it does not jump.
    const next = context.shownTop();
    expect(next).toBeGreaterThan(at);
    expect(next - at).toBeLessThan(step);

    let lowest = next;
    while (context.last().moving) {
      await context.advance(FRAME_MS);
      lowest = Math.max(lowest, context.shownTop());
    }
    expect(lowest).toBeLessThan(700 - 100);
    expect(context.shownTop()).toBe(200 - 100);
    context.preview.dispose();
  });

  it("on a fast pass changes neither its card nor its place, and both together when attending resumes", async () => {
    const context = setup({ hold: true });
    context.preview.pointer(context.target("a", 200));
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    context.preview.prepared(context.held.shift()!.id, context.measureOf("a"));
    await context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);
    const painted = context.paints.length;
    const top = context.shownTop();
    context.readCard.mockClear();

    context.state.attending = false;
    for (const [slug, y] of [["b", 300], ["c", 400], ["d", 500]] as const) {
      context.preview.pointer(context.target(slug, y));
      await context.advance(FRAME_MS);
    }
    expect(context.readCard).not.toHaveBeenCalled();
    expect(context.current()).toEqual(["a"]);
    expect(context.paints.length).toBe(painted);

    // The pointer stops on a trigger: the mode turns on with no new step.
    context.state.attending = true;
    context.preview.attendingChanged();
    await context.flush();
    expect(context.readCard).toHaveBeenCalledWith("d");
    // Until the card is ready the window stands where it stood.
    await context.advance(FRAME_MS * 3);
    expect(context.current()).toEqual(["a"]);
    expect(context.shownTop()).toBe(top);
    context.preview.prepared(context.held.shift()!.id, context.measureOf("d"));
    expect(context.current()).toEqual(["d"]);
    expect(context.shown).toEqual(["a", "d"]);
    await context.advance(FRAME_MS * 2);
    expect(context.shownTop()).toBeGreaterThan(top);
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS);
    expect(context.shownTop()).toBe(500 - 100);
    context.preview.dispose();
  });

  it("fades the old card out over the fade-out and the new one in over the fade-in, frame whole", async () => {
    const context = setup();
    await openAt(context, "a", 200);
    context.preview.pointer(context.target("b", 200));
    await context.flush();
    const view = context.preview.getView()!;
    expect(view.frameMoving).toBe(true);
    expect(view.layers.map((layer) => layer.role)).toEqual(["outgoing", "current"]);
    const [oldId, newId] = view.layers.map((layer) => layer.id);
    const opacityOf = (id: number | undefined) => context.last().layers.find((layer) => layer.id === id)?.opacity;
    expect(opacityOf(oldId)).toBe(1);
    expect(opacityOf(newId)).toBe(0);
    await context.advance(HOVER_INTENT.fadeOutMs + FRAME_MS);
    expect(opacityOf(oldId)).toBe(0);
    expect(opacityOf(newId)).toBeGreaterThan(0.5);
    expect(opacityOf(newId)).toBeLessThan(1);
    await context.advance(HOVER_INTENT.fadeInMs);
    expect(opacityOf(newId)).toBe(1);
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS);
    expect(context.preview.getView()?.frameMoving).toBe(false);
    expect(context.preview.getView()?.layers.map((layer) => layer.role)).toEqual(["current"]);
    context.preview.dispose();
  });

  it("keeps the old card until the new one is decoded, and drops a card the pointer has left", async () => {
    const context = setup({ hold: true });
    context.preview.pointer(context.target("a", 200));
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    expect(context.preview.getView()?.shown).toBe(false);
    const first = context.held.shift()!;
    context.preview.prepared(first.id, context.measureOf("a"));
    expect(context.current()).toEqual(["a"]);

    context.preview.pointer(context.target("b", 240));
    await context.flush();
    expect(context.current()).toEqual(["a"]);
    expect(context.preview.getView()?.layers.map((layer) => layer.role)).toEqual(["current", "pending"]);

    // The pointer goes on before it is ready: "b" never shows.
    context.preview.pointer(context.target("c", 280));
    await context.flush();
    const stale = context.held.shift()!;
    expect(stale.slug).toBe("b");
    context.preview.prepared(stale.id, context.measureOf("b"));
    expect(context.current()).toEqual(["a"]);
    const next = context.held.shift()!;
    expect(next.slug).toBe("c");
    context.preview.prepared(next.id, context.measureOf("c"));
    expect(context.current()).toEqual(["c"]);
    context.preview.dispose();
  });

  it("takes the new card's height by the spring, about the trigger's centre", async () => {
    const context = setup({ heights: { a: 200, b: 400 } });
    await openAt(context, "a", 400);
    context.preview.pointer(context.target("b", 400));
    await context.flush();
    expect(context.last().laidHeight).toBe(400);
    expect(context.last().height).toBe(200);
    await context.advance(FRAME_MS * 4);
    expect(context.last().height).toBeGreaterThan(200);
    expect(context.last().height).toBeLessThan(400);
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS);
    expect(context.last().height).toBe(400);
    expect(context.last().laidHeight).toBe(400);
    expect(context.shownTop()).toBe(400 - 200);
    expect(context.last().frameMoving).toBe(false);
    context.preview.dispose();
  });

  it("stays 8 px off the app window's edges through a retarget and a change of height", async () => {
    const context = setup({ heights: { a: 200, b: 500 } });
    await openAt(context, "a", 790);
    expect(context.shownTop()).toBe(800 - FLOATING_LAYER_EDGE_PX - 200);
    context.preview.pointer(context.target("b", 790));
    await context.flush();
    for (let frame = 0; frame < 40; frame += 1) {
      await context.advance(FRAME_MS);
      const bottom = context.shownTop() + context.last().height;
      expect(bottom).toBeLessThanOrEqual(800 - FLOATING_LAYER_EDGE_PX + 0.001);
      expect(context.shownTop()).toBeGreaterThanOrEqual(FLOATING_LAYER_EDGE_PX);
    }
    context.preview.dispose();
  });

  it("fades in place on leaving, and comes back within the warm window with no delay", async () => {
    const context = setup();
    await openAt(context, "a", 400);
    context.preview.leave();
    expect(context.shown).toEqual(["a", null]);
    const top = context.shownTop();
    await context.advance(FRAME_MS * 2);
    expect(context.last().opacity).toBeLessThan(1);
    expect(context.shownTop()).toBe(top);
    await context.advance(HOVER_INTENT.fadeOutMs);
    expect(context.preview.getView()).toBeNull();

    context.preview.pointer(context.target("b", 100));
    await context.flush();
    expect(context.current()).toEqual(["b"]);
    expect(context.shownTop()).toBe(FLOATING_LAYER_EDGE_PX);
    context.preview.dispose();
  });

  it("waits the cold delay again past the warm window", async () => {
    const context = setup();
    await openAt(context, "a", 400);
    context.preview.leave();
    await context.advance(HOVER_PREVIEW_WARM_WINDOW_MS + 1);
    context.preview.pointer(context.target("b", 100));
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - 1);
    expect(context.preview.getView()).toBeNull();
    await context.advance(1);
    expect(context.current()).toEqual(["b"]);
    context.preview.dispose();
  });

  it("over no trigger holds on a fast pass, and in the attending mode lets go after the grace", async () => {
    const context = setup();
    await openAt(context, "a", 400);

    context.state.attending = false;
    context.preview.pointer(null);
    await context.advance(HOVER_INTENT.leaveGraceMs * 2);
    expect(context.shown).toEqual(["a"]);

    context.state.attending = true;
    context.preview.attendingChanged();
    await context.advance(HOVER_INTENT.leaveGraceMs - 1);
    expect(context.shown).toEqual(["a"]);
    // Back on a trigger within the grace it stays.
    context.preview.pointer(context.target("a", 400));
    await context.advance(HOVER_INTENT.leaveGraceMs);
    expect(context.shown).toEqual(["a"]);

    context.preview.pointer(null);
    await context.advance(HOVER_INTENT.leaveGraceMs);
    expect(context.shown).toEqual(["a", null]);
    context.preview.dispose();
  });

  it("with no room beside the panel stands under the row, or over it, and goes to the next by the spring", async () => {
    const context = setup({ panel: { left: 100, right: 1300 } });
    const rowAt = (slug: string, centerY: number): HoverPreviewElementTarget => ({
      key: `row:${slug}`,
      slug,
      element: triggerAt(centerY, { left: 100, right: 1300 }),
    });
    context.preview.pointer(rowAt("a", 120));
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    expect(context.last().left).toBe(1300 - HOVER_PREVIEW_WINDOW_WIDTH_PX);
    expect(context.shownTop()).toBe(140 + HOVER_PREVIEW_WINDOW_GAP_PX);
    await context.advance(HOVER_INTENT.fadeInMs + FRAME_MS);

    context.preview.pointer(rowAt("b", 720));
    await context.flush();
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS);
    expect(context.current()).toEqual(["b"]);
    expect(context.shownTop()).toBe(700 - HOVER_PREVIEW_WINDOW_GAP_PX - 200);
    expect(context.last().left).toBe(1300 - HOVER_PREVIEW_WINDOW_WIDTH_PX);
    context.preview.dispose();
  });

  it("goes at once for a rebuilt list, and a request on the way goes with it", async () => {
    const context = setup();
    await openAt(context, "a", 400);
    context.preview.dismiss();
    expect(context.preview.getView()).toBeNull();
    expect(context.shown).toEqual(["a", null]);

    context.preview.pointer(context.target("b", 400));
    context.preview.dismiss();
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS * 2);
    expect(context.preview.getView()).toBeNull();
    context.preview.dispose();
  });

  it("holds its card while frozen, and forgets a trigger that left the page", async () => {
    const context = setup();
    await openAt(context, "a", 400);
    context.preview.setFrozen(true);
    context.preview.pointer(context.target("b", 500));
    context.preview.leave();
    await context.advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    expect(context.current()).toEqual(["a"]);
    context.preview.setFrozen(false);
    context.preview.forget("row:other");
    expect(context.current()).toEqual(["a"]);
    context.preview.forget("row:a");
    expect(context.preview.getView()).toBeNull();
    context.preview.dispose();
  });

  describe("with reduced motion", () => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    });

    it("stands at the new trigger at once, and changes the content only by fading", async () => {
      const context = setup({ heights: { a: 200, b: 400 } });
      await openAt(context, "a", 300);
      context.preview.pointer(context.target("b", 450));
      await context.flush();
      expect(context.last().height).toBe(400);
      expect(context.shownTop()).toBe(450 - 200);
      const [oldId, newId] = context.preview.getView()!.layers.map((layer) => layer.id);
      const opacityOf = (id: number | undefined) => context.last().layers.find((layer) => layer.id === id)?.opacity;
      expect(opacityOf(oldId)).toBe(1);
      expect(opacityOf(newId)).toBe(0);
      await context.advance(HOVER_INTENT.fadeOutMs + FRAME_MS);
      expect(opacityOf(oldId)).toBe(0);
      expect(opacityOf(newId)).toBeGreaterThan(0);
      expect(context.shownTop()).toBe(450 - 200);
      context.preview.dispose();
    });
  });
});

/** A window over targets that move on their own, as the graph's nodes do. */
function setupTracked(heights: Record<string, number> = {}) {
  const state = { attending: true };
  const paints: HoverPreviewWindowPaint[] = [];
  const places = new Map<string, HoverPreviewPlace>();
  const reads: string[] = [];
  const opener = new HoverPreviewOpener(() => state.attending);
  const preview = new HoverPreviewWindow<HoverPreviewTarget, { slug: string }>({
    opener,
    isAttending: () => state.attending,
    readCard: async (slug) => ({ slug }),
    place: (target, _height, moment) => {
      reads.push(moment);
      return places.get(target.key) ?? null;
    },
    tracksTarget: true,
  });
  preview.setPainter((paint) => paints.push(paint));
  const seen = new Set<number>();
  preview.subscribe(() => {
    const pending = preview.getView()?.layers.find((layer) => layer.role === "pending");
    if (!pending || seen.has(pending.id)) return;
    seen.add(pending.id);
    queueMicrotask(() => preview.prepared(pending.id, {
      height: heights[pending.card.slug] ?? 200,
      mediaHeight: 0,
      radius: 0,
    }));
  });
  const advance = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const last = () => paints[paints.length - 1]!;
  const shown = () => ({ left: last().left + last().translateX, top: last().laidTop + last().translateY });
  const open = async (key: string, place: HoverPreviewPlace) => {
    places.set(key, place);
    preview.pointer({ key, slug: key });
    await advance(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    await advance(HOVER_INTENT.fadeInMs + FRAME_MS);
    await advance(HOVER_PREVIEW_WINDOW_SETTLE_MS);
  };
  return { preview, state, paints, places, reads, advance, last, shown, open };
}

describe("a window over targets that move on their own (SPEC_CARD_STATES.md, С7.11)", () => {
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

  it("takes the window with its target in the same frame, with no lag", async () => {
    const context = setupTracked();
    await context.open("a", { left: 300, top: 200, side: "below" });
    expect(context.last().moving).toBe(false);
    context.places.set("a", { left: 310, top: 207, side: "below" });
    await context.advance(FRAME_MS);
    expect(context.shown()).toEqual({ left: 310, top: 207 });
    expect(context.last().moving).toBe(true);
    context.places.set("a", { left: 345, top: 180, side: "below" });
    await context.advance(FRAME_MS);
    expect(context.shown()).toEqual({ left: 345, top: 180 });
    context.preview.dispose();
  });

  it("goes back on plain layout once its target stops, and paints nothing while it stands", async () => {
    const context = setupTracked();
    await context.open("a", { left: 300, top: 200, side: "below" });
    context.places.set("a", { left: 310.4, top: 207.6, side: "below" });
    await context.advance(FRAME_MS);
    expect(context.last().moving).toBe(true);
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS);
    const rest = context.last();
    expect(rest.moving).toBe(false);
    expect(rest.translateX).toBe(0);
    expect(rest.translateY).toBe(0);
    expect(rest.left).toBe(310);
    expect(rest.laidTop).toBe(208);
    const painted = context.paints.length;
    context.reads.length = 0;
    await context.advance(FRAME_MS * 5);
    // It keeps watching its target, coordinates only, and writes nothing.
    expect(context.paints.length).toBe(painted);
    expect(context.reads).toEqual(["frame", "frame", "frame", "frame", "frame"]);
    context.preview.dispose();
  });

  it("goes to another target by springs in both axes, in one motion, with its card", async () => {
    const context = setupTracked();
    await context.open("a", { left: 300, top: 200, side: "below" });
    context.places.set("b", { left: 700, top: 500, side: "below" });
    context.preview.pointer({ key: "b", slug: "b" });
    await context.advance(0);
    expect(context.shown()).toEqual({ left: 300, top: 200 });
    const lefts = [context.shown().left];
    const tops = [context.shown().top];
    for (let frame = 0; frame < 40 && context.last().moving; frame += 1) {
      await context.advance(FRAME_MS);
      lefts.push(context.shown().left);
      tops.push(context.shown().top);
    }
    for (let index = 1; index < lefts.length; index += 1) {
      expect(lefts[index]!).toBeGreaterThanOrEqual(lefts[index - 1]!);
      expect(tops[index]!).toBeGreaterThanOrEqual(tops[index - 1]!);
      expect(lefts[index]!).toBeLessThanOrEqual(700);
      expect(tops[index]!).toBeLessThanOrEqual(500);
    }
    // Two springs of one response: the path between the places is straight.
    const middle = Math.floor(lefts.length / 3);
    expect((lefts[middle]! - 300) / 400).toBeCloseTo((tops[middle]! - 200) / 300, 2);
    expect(context.shown()).toEqual({ left: 700, top: 500 });
    context.preview.dispose();
  });

  it("adds the new target's own movement to the spring's way at once, with no lag", async () => {
    // Two windows on one clock, on the same way; only one target moves on.
    const still = setupTracked();
    const moving = setupTracked();
    for (const context of [still, moving]) {
      await context.open("a", { left: 300, top: 200, side: "below" });
      context.places.set("b", { left: 700, top: 500, side: "below" });
    }
    for (const context of [still, moving]) context.preview.pointer({ key: "b", slug: "b" });
    await moving.advance(FRAME_MS * 4);
    moving.places.set("b", { left: 750, top: 470, side: "below" });
    for (let frame = 0; frame < 6; frame += 1) {
      await moving.advance(FRAME_MS);
      expect(moving.shown().left - still.shown().left).toBeCloseTo(50, 2);
      expect(moving.shown().top - still.shown().top).toBeCloseTo(-30, 2);
    }
    still.preview.dispose();
    moving.preview.dispose();
  });

  it("turns to the target's other side by the spring, not by a jump", async () => {
    const context = setupTracked();
    await context.open("a", { left: 300, top: 400, side: "below" });
    context.places.set("a", { left: 300, top: 100, side: "above" });
    await context.advance(FRAME_MS);
    expect(Math.abs(context.shown().top - 400)).toBeLessThan(10);
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS);
    expect(context.shown().top).toBe(100);
    context.preview.dispose();
  });

  it("goes at once when its target is gone", async () => {
    const context = setupTracked();
    await context.open("a", { left: 300, top: 200, side: "below" });
    context.places.delete("a");
    await context.advance(FRAME_MS);
    expect(context.preview.getView()).toBeNull();
    context.preview.dispose();
  });

  it("stands where it is while it fades out, and comes back to a target that moved meanwhile", async () => {
    const context = setupTracked();
    await context.open("a", { left: 300, top: 200, side: "below" });
    context.preview.leave();
    context.places.set("a", { left: 340, top: 200, side: "below" });
    await context.advance(FRAME_MS * 2);
    expect(context.shown().left).toBe(300);
    context.preview.pointer({ key: "a", slug: "a" });
    await context.advance(FRAME_MS);
    expect(context.preview.getView()?.shown).toBe(true);
    await context.advance(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS);
    expect(context.shown().left).toBe(340);
    expect(context.last().opacity).toBe(1);
    context.preview.dispose();
  });
});

describe("one source for all the surfaces (SPEC_CARD_STATES.md, С7.11)", () => {
  it("wires the sidebar, the open card's panel and the graph to the same window", () => {
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    const detail = readFileSync("src/components/Detail.tsx", "utf8");
    const graph = readFileSync("src/components/GraphView.tsx", "utf8");
    for (const source of [sidebar, detail, graph]) {
      expect(source).toContain("useHoverPreviewWindow<");
      expect(source).toContain("<HoverPreviewWindowLayer");
      expect(source).toContain("new RestingPointer()");
    }
    for (const source of [sidebar, detail]) {
      expect(source).toContain("readCard: getBlock");
    }
    expect(graph).not.toContain("useHoverPreviewOpener");
    expect(sidebar).not.toContain("useHoverPreviewOpener");
    expect(sidebar).not.toContain("onPreviewEnter");
  });

  it("keeps its fade times equal to the hover tokens of С7.6", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).toContain(`--hover-intent-fade-in: ${HOVER_INTENT.fadeInMs}ms`);
    expect(css).toContain(`--hover-intent-fade-out: ${HOVER_INTENT.fadeOutMs}ms`);
  });
});
