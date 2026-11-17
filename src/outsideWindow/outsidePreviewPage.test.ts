import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import {
  HOVER_PREVIEW_WINDOW_SETTLE_MS,
  HoverPreviewPresenter,
  type HoverPreviewStageHost,
  type HoverPreviewWindowPaint,
} from "@/lib/hoverPreviewPresenter";
import { setMotionLevel } from "@/test/motionLevel";
import type { LightBlock, OutsidePageMessage, OutsidePageReport, PageArea, PreviewContent, PreviewStep } from "@/types";
import { OutsidePreviewPage, type OutsidePreviewTarget } from "./outsidePreviewPage";

const FRAME_MS = 16;
const AREA: PageArea = { left: 22, top: 22, right: 262, bottom: 1102 };
const LOOK = { vault_path: "/vault", thumbs_root_path: null, collection_order: [] };

function card(slug: string): PreviewContent {
  // The window here never draws its card: only the slug is read, as the key
  // of the layer's content. A full record would say nothing more.
  return { kind: "card", block: { slug } as unknown as LightBlock, thumb_version: null };
}

function trigger(centerY: number) {
  return { x: -300, y: centerY - 20, width: 280, height: 40 };
}

/** The page as the backend drives it: messages in, reports out. */
function setup() {
  const reports: OutsidePageReport[] = [];
  const page = new OutsidePreviewPage((report) => reports.push(report));
  const paints: HoverPreviewWindowPaint[] = [];
  let number = 0;
  const begin = (session = 1) => {
    page.hear({ kind: "preview", session, area: AREA, look: LOOK });
    page.current()!.presenter.setPainter((paint) => paints.push(paint));
    number = 0;
  };
  const step = (value: PreviewStep, at?: number) => {
    number += 1;
    page.hear({ kind: "preview_step", session: page.current()!.id, number: at ?? number, step: value });
  };
  /** The component's measure of the card laid out unseen. */
  const ready = (height = 200) => {
    const presenter = page.current()!.presenter;
    const pending = presenter.getView()?.layers.find((layer) => layer.role === "pending");
    presenter.prepared(pending!.id, { height, mediaHeight: 0, radius: 0 });
  };
  const events = () => reports.flatMap((report) => (report.kind === "preview" && report.report.event ? [report.report.event.kind] : []));
  return { page, reports, paints, begin, step, ready, events };
}

describe("the outside window's page (SPEC_OUTSIDE_WINDOW.md, НО6, НО7)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    vi.stubGlobal("innerHeight", 1124);
    vi.stubGlobal("innerWidth", 284);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the offered card in the column, centred on its trigger, and reports it settled and its first frame", () => {
    const context = setup();
    context.begin();
    context.step({ kind: "offer", key: "a", trigger: trigger(400), content: card("a") });
    context.ready(200);
    const last = context.paints.at(-1)!;
    expect(last.left).toBe(AREA.left);
    expect(last.laidTop + last.translateY).toBe(400 - 100);
    expect(context.events()).toEqual(["settled"]);
    vi.advanceTimersByTime(FRAME_MS);
    expect(context.reports).toContainEqual({ kind: "first_frame", session: 1 });
    const settled = context.reports.find((report) => report.kind === "preview" && report.report.event?.kind === "settled");
    expect(settled).toMatchObject({ report: { phase: "open", shown_key: "a" } });
    context.page.dispose();
  });

  it("applies the steps in their numbers' order, a later one waiting for those before it", () => {
    const context = setup();
    context.begin();
    // The offer of "b" comes before the offer of "a" that preceded it.
    context.step({ kind: "offer", key: "b", trigger: trigger(600), content: card("b") }, 2);
    expect(context.page.current()!.presenter.pendingKey()).toBeNull();
    context.step({ kind: "offer", key: "a", trigger: trigger(400), content: card("a") }, 1);
    expect(context.page.current()!.presenter.pendingKey()).toBe("b");
    context.page.dispose();
  });

  it("drops a ready card the source's pointer left, and tells why", () => {
    const context = setup();
    context.begin();
    context.step({ kind: "offer", key: "a", trigger: trigger(400), content: card("a") });
    context.step({ kind: "wanted", key: "b" });
    context.ready();
    expect(context.page.current()!.presenter.phase()).toBe("closed");
    expect(context.reports.at(-1)).toMatchObject({ report: { phase: "closed", event: { kind: "dropped", reason: "left" } } });
    context.page.dispose();
  });

  it("reports the window closed once it faded, which ends the showing for the backend", () => {
    const context = setup();
    context.begin();
    context.step({ kind: "offer", key: "a", trigger: trigger(400), content: card("a") });
    context.ready();
    vi.advanceTimersByTime(HOVER_INTENT.fadeInMs + FRAME_MS);
    context.step({ kind: "fade_out" });
    expect(context.events()).toEqual(["settled", "hidden"]);
    vi.advanceTimersByTime(HOVER_INTENT.fadeOutMs + FRAME_MS * 2);
    expect(context.events()).toEqual(["settled", "hidden", "closed"]);
    context.page.dispose();
  });

  it("drops the window at once when the backend ends the showing, and says it listens again after a stall", () => {
    const context = setup();
    context.begin();
    context.step({ kind: "offer", key: "a", trigger: trigger(400), content: card("a") });
    context.ready();
    const told = context.reports.length;
    context.page.hear({ kind: "end", session: 1, reason: "unresponsive" });
    expect(context.page.current()).toBeNull();
    expect(context.reports.length).toBe(told);
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(context.reports.at(-1)).toEqual({ kind: "ready" });
    context.page.dispose();
  });

  it("ignores what belongs to a showing other than its own", () => {
    const context = setup();
    context.begin(2);
    const message: OutsidePageMessage = { kind: "preview_step", session: 1, number: 1, step: { kind: "offer", key: "a", trigger: trigger(400), content: card("a") } };
    context.page.hear(message);
    context.page.hear({ kind: "end", session: 1, reason: "window" });
    expect(context.page.current()?.id).toBe(2);
    expect(context.page.current()!.presenter.pendingKey()).toBeNull();
    context.page.dispose();
  });

  // The window moves outside as it moves inside (ПН7): the same calls give
  // the same frames as the window driven directly in a page.
  describe.each(["full", "minimal", "off"] as const)("at the level %s", (level) => {
    beforeEach(() => {
      setMotionLevel(level);
    });

    it("writes the frames the same window writes driven directly", () => {
      const context = setup();
      context.begin();
      const direct = new HoverPreviewPresenter<OutsidePreviewTarget, PreviewContent>({
        place: (target, height) => ({ left: AREA.left, top: target.trigger.y + target.trigger.height / 2 - height / 2 }),
        area: () => AREA,
      });
      let wanted: string | null = null;
      const host: HoverPreviewStageHost<OutsidePreviewTarget> = {
        stillWanted: (key) => wanted === key,
        onSettled: () => undefined,
        onHidden: () => undefined,
        onDropped: () => undefined,
        onTargetGone: () => undefined,
      };
      direct.setHost(host);
      const directPaints: HoverPreviewWindowPaint[] = [];
      direct.setPainter((paint) => directPaints.push(paint));
      const offer = (key: string, y: number, height: number) => {
        wanted = key;
        direct.offer({ key, slug: key, trigger: trigger(y) }, card(key));
        const pending = direct.getView()!.layers.find((layer) => layer.role === "pending")!;
        direct.prepared(pending.id, { height, mediaHeight: 0, radius: 0 });
        context.step({ kind: "offer", key, trigger: trigger(y), content: card(key) });
        context.ready(height);
      };

      offer("a", 300, 200);
      vi.advanceTimersByTime(HOVER_INTENT.fadeInMs + FRAME_MS);
      offer("b", 700, 340);
      vi.advanceTimersByTime(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS);
      direct.fadeOut();
      context.step({ kind: "fade_out" });
      vi.advanceTimersByTime(HOVER_INTENT.fadeOutMs + FRAME_MS * 2);

      expect(context.paints.length).toBeGreaterThan(10);
      expect(context.paints).toEqual(directPaints);
      direct.dispose();
      context.page.dispose();
    });
  });
});

describe("the outside window's entry (SPEC_OUTSIDE_WINDOW.md, НО1)", () => {
  it("is a clear page of the build that the default capability lets talk to the backend", () => {
    const html = readFileSync("outside-window.html", "utf8");
    expect(html).toContain('<html lang="en" data-outside-window>');
    expect(html).toContain('src="/src/outsideWindow/main.tsx"');
    const css = readFileSync("src/outsideWindow/outsideWindow.css", "utf8");
    // global.css paints `#root` by its id: the page's rule names the id too
    // (the browser check holds the pixels, scripts/outside-window-audit.mjs).
    expect(css).toMatch(/html\[data-outside-window\],\s*html\[data-outside-window\] body,\s*html\[data-outside-window\] #root \{\s*background: transparent;/);
    expect(readFileSync("vite.config.ts", "utf8")).toContain('outsideWindow: path.resolve(__dirname, "outside-window.html")');
    const capabilities = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as { webviews: string[] };
    expect(capabilities.webviews).toContain("outside-window");
    // The backend's label, page and events are the page's.
    const backend = readFileSync("src-tauri/src/outside_window/mod.rs", "utf8");
    const commands = readFileSync("src/lib/outsideWindowCommands.ts", "utf8");
    for (const name of ['"outside-window"', '"outside-window.html"', '"outside-window-message"', '"outside-window-report"']) {
      expect(backend).toContain(name);
    }
    for (const name of ['"outside-window"', '"outside-window-message"', '"outside-window-report"']) {
      expect(commands).toContain(name);
    }
  });

  it("keeps the backend's column and gap equal to the page's window", () => {
    const geometry = readFileSync("src-tauri/src/outside_window/geometry.rs", "utf8");
    expect(geometry).toContain("pub const PREVIEW_WIDTH_PX: f64 = 240.0;");
    expect(geometry).toContain("pub const PREVIEW_GAP_PX: f64 = 8.0;");
  });
});
