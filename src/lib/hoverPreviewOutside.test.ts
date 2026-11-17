import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightBlock, OutsideSourceMessage, PreviewOpenRequest, PreviewReport, PreviewStepRequest } from "@/types";

const backend = vi.hoisted(() => ({
  opens: [] as PreviewOpenRequest[],
  steps: [] as PreviewStepRequest[],
  refuse: null as string | null,
}));

vi.mock("./outsideWindowCommands", () => ({
  OUTSIDE_TO_SOURCE_EVENT: "outside-window-report",
  openPreviewOutside: (request: PreviewOpenRequest) => {
    backend.opens.push(request);
    return backend.refuse === null ? Promise.resolve() : Promise.reject(backend.refuse);
  },
  sendPreviewStep: (request: PreviewStepRequest) => {
    backend.steps.push(request);
    return Promise.resolve();
  },
  prepareOutsideWindow: () => Promise.resolve({ ready: true }),
}));

const { HOVER_PREVIEW_COLD_OPEN_DELAY_MS, HoverPreviewOpener } = await import("./hoverPreviewTiming");
const { HoverPreviewWindow, hoverPreviewBesidePanel, hoverPreviewOutsideBesidePanel } = await import("./hoverPreviewWindow");
type HoverPreviewElementTarget = import("./hoverPreviewWindow").HoverPreviewElementTarget;
const { publishCollectionOrder } = await import("./cardCollections");
const {
  followOutsideWindow,
  hearOutsideWindow,
  outsideCardContent,
  outsideCollectionContent,
  outsideLook,
  outsideWindowAnswers,
} = await import("./outsidePreviewSource");
// The page's entry: the backend answers its preparation.
followOutsideWindow();
await Promise.resolve();

type Card = LightBlock;

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => null } as DOMRect;
}

/** A row the pointer can be on: a box at `y`, on the page. */
function row(slug: string, y: number): HoverPreviewElementTarget {
  const element = document.createElement("div");
  document.body.append(element);
  element.getBoundingClientRect = () => box(0, y, 350, 40);
  return { key: `row:${slug}`, slug, element };
}

/** The sidebar over the feed in a narrow window: 350 of 390, no room beside
 *  it (SPEC_OUTSIDE_WINDOW.md, ПН1), unless `wide`. */
function setup(options: { wide?: boolean } = {}) {
  const shown: (string | null)[] = [];
  const panel = () => (options.wide ? box(0, 0, 280, 800) : box(0, 0, 350, 800));
  const opener = new HoverPreviewOpener(() => true);
  const preview = new HoverPreviewWindow<HoverPreviewElementTarget, Card>({
    opener,
    isAttending: () => true,
    // Only the slug is read here: the card is sent on, never drawn.
    readCard: async (slug) => ({ slug }) as unknown as Card,
    place: hoverPreviewBesidePanel(panel, "after"),
    outside: hoverPreviewOutsideBesidePanel<HoverPreviewElementTarget, Card>({
      panel,
      side: "after",
      look: () => ({ vault_path: "/vault", thumbs_root_path: null, collection_order: [] }),
      content: (card) => outsideCardContent(card),
    }),
    onShown: (target) => shown.push(target?.slug ?? null),
  });
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  const open = async (target: HoverPreviewElementTarget) => {
    preview.pointer(target);
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    await flush();
  };
  let reported = 0;
  /** The outside window's page reports, through the backend. */
  const report = (fields: Partial<PreviewReport>) => {
    reported += 1;
    const show = backend.opens.at(-1)!.show;
    const message: OutsideSourceMessage = {
      kind: "preview",
      show,
      number: reported,
      report: { applied: backend.steps.length, phase: "closed", shown_key: null, fading_key: null, pending_key: null, event: null, ...fields },
    };
    hearOutsideWindow(message);
  };
  const close = (reason: "window" | "unresponsive") => hearOutsideWindow({ kind: "closed", show: backend.opens.at(-1)!.show, reason });
  return { preview, shown, open, flush, report, close };
}

describe("a preview with no room beside its panel goes outside (SPEC_OUTSIDE_WINDOW.md, ПН2, НО6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 390);
    backend.opens.length = 0;
    backend.steps.length = 0;
    backend.refuse = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("opens a showing outside with the panel, the trigger and the side, and sends the card after the opening", async () => {
    const context = setup();
    const a = row("a", 200);
    await context.open(a);
    expect(backend.opens).toHaveLength(1);
    expect(backend.opens[0]).toMatchObject({ panel: { x: 0, y: 0, width: 350, height: 800 }, trigger: { x: 0, y: 200, width: 350, height: 40 }, side: "after" });
    expect(backend.steps.map(({ number, step }) => [number, step.kind])).toEqual([[1, "offer"]]);
    expect(backend.steps[0]!.step).toMatchObject({ key: "row:a", content: { kind: "card", block: { slug: "a" } } });
    // Nothing is drawn in this page.
    expect(context.preview.getView()).toBeNull();
    context.preview.dispose();
  });

  it("asks the outside window only once the backend answered the page", () => {
    expect(outsideWindowAnswers()).toBe(true);
  });

  it("sends what only this page knows: the space and the sidebar's order of collections (НО7)", () => {
    publishCollectionOrder([{ tag: "Reading", count: 3 }]);
    expect(outsideLook("/vault", null)).toEqual({ vault_path: "/vault", thumbs_root_path: null, collection_order: [{ tag: "Reading", count: 3 }] });
    publishCollectionOrder([]);
    expect(outsideCollectionContent({
      kind: "collection",
      rowKey: "tag:Reading",
      name: "Reading",
      count: 3,
      cards: [{ url: "asset://a", text: false, hasThumb: true }],
      placeholders: 2,
    })).toEqual({
      kind: "collection",
      collection: { row_key: "tag:Reading", name: "Reading", count: 3, cards: [{ slug: null, url: "asset://a", text: false, has_thumb: true }], placeholders: 2 },
    });
  });

  it("stays inside when the panel has room beside it, as before", async () => {
    const context = setup({ wide: true });
    vi.stubGlobal("innerWidth", 1400);
    await context.open(row("a", 200));
    expect(backend.opens).toHaveLength(0);
    expect(context.preview.getView()?.layers.map((layer) => layer.role)).toEqual(["pending"]);
    context.preview.dispose();
  });

  it("shows the card inside, under the row, when the backend refuses the showing (НО9)", async () => {
    backend.refuse = "not_ready";
    const context = setup();
    await context.open(row("a", 200));
    expect(backend.opens).toHaveLength(1);
    expect(context.preview.getView()?.layers.map((layer) => layer.role)).toEqual(["pending"]);
    context.preview.dispose();
  });

  it("marks its row by the outside window's report, and tells the next trigger and the pointer's leaving", async () => {
    const context = setup();
    const a = row("a", 200);
    await context.open(a);
    context.report({ phase: "open", shown_key: "row:a", event: { kind: "settled", key: "row:a" } });
    expect(context.shown).toEqual(["a"]);
    // The pointer goes on to the next row: its card goes to the same showing.
    const b = row("b", 240);
    context.preview.pointer(b);
    await context.flush();
    expect(backend.opens).toHaveLength(1);
    expect(backend.steps.map(({ step }) => step.kind)).toEqual(["offer", "wanted", "offer"]);
    context.preview.leave();
    expect(backend.steps.map(({ step }) => step.kind).slice(-2)).toEqual(["wanted", "fade_out"]);
    context.report({ phase: "leaving", fading_key: "row:b", event: { kind: "hidden" } });
    expect(context.shown).toEqual(["a", null]);
    context.preview.dispose();
  });

  it("begins a new showing once the one outside closed", async () => {
    const context = setup();
    await context.open(row("a", 200));
    context.report({ phase: "open", shown_key: "row:a", event: { kind: "settled", key: "row:a" } });
    context.preview.leave();
    context.report({ phase: "closed", event: { kind: "closed" } });
    await context.open(row("b", 300));
    expect(backend.opens).toHaveLength(2);
    expect(backend.opens[1]!.show).toBeGreaterThan(backend.opens[0]!.show);
    context.preview.dispose();
  });

  it("goes at once when the backend ends the showing for its window", async () => {
    const context = setup();
    await context.open(row("a", 200));
    context.report({ phase: "open", shown_key: "row:a", event: { kind: "settled", key: "row:a" } });
    context.close("window");
    expect(context.shown).toEqual(["a", null]);
    expect(context.preview.getView()).toBeNull();
    context.preview.dispose();
  });

  it("draws the card inside at once when the outside window drew nothing in time", async () => {
    const context = setup();
    await context.open(row("a", 200));
    backend.refuse = "not_ready";
    context.close("unresponsive");
    await context.flush();
    expect(backend.opens).toHaveLength(2);
    await context.flush();
    expect(context.preview.getView()?.layers.map((layer) => layer.role)).toEqual(["pending"]);
    context.preview.dispose();
  });

  it("takes a report's state only once it has taken every step sent", async () => {
    const context = setup();
    await context.open(row("a", 200));
    // A report made before the offer was taken says nothing of now.
    hearOutsideWindow({
      kind: "preview",
      show: backend.opens[0]!.show,
      number: 1,
      report: { applied: 0, phase: "closed", shown_key: null, fading_key: null, pending_key: null, event: null },
    });
    context.preview.pointer(row("a", 200));
    expect(backend.steps.map(({ step }) => step.kind)).toEqual(["offer"]);
    context.preview.dispose();
  });

  it("sends nothing while a card menu holds the window (С7.8)", async () => {
    const context = setup();
    await context.open(row("a", 200));
    context.report({ phase: "open", shown_key: "row:a", event: { kind: "settled", key: "row:a" } });
    const sent = backend.steps.length;
    context.preview.setFrozen(true);
    context.preview.pointer(row("b", 300));
    context.preview.leave();
    vi.advanceTimersByTime(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    await context.flush();
    expect(backend.steps.length).toBe(sent);
    context.preview.dispose();
  });
});
