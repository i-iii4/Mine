import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHoverIntent } from "@/hooks/useHoverIntent";
import { CARD_PEEK_PREPARE_MAX_MS } from "@/lib/cardPeek";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import { HOVER_PREVIEW_COLD_OPEN_DELAY_MS } from "@/lib/hoverPreviewTiming";
import {
  HOVER_PREVIEW_WINDOW_SETTLE_MS,
  hoverPreviewBesidePanel,
  type HoverPreviewElementTarget,
  type HoverPreviewWindow,
} from "@/lib/hoverPreviewWindow";
import { indexedBlock } from "@/test/blocks";
import type { IndexedBlock, LightBlock } from "@/types";
import { HoverPreviewWindowLayer, useHoverPreviewWindow } from "./HoverPreviewWindow";

const FRAME_MS = 16;

type Controller = HoverPreviewWindow<HoverPreviewElementTarget, LightBlock | IndexedBlock>;

function card(slug: string): IndexedBlock {
  if (slug.startsWith("picture")) {
    return indexedBlock({
      slug,
      block_type: "image",
      title: null,
      fallback_label: slug,
      media_file: `Media/${slug}.jpg`,
      thumb_format: "jpeg",
      thumb_mtime: 1,
      width: 400,
      height: 400,
      preview_manifest: JSON.stringify({
        kind: "image",
        primary_preview_path: `${slug}.jpg`,
        width: 400,
        height: 400,
        tiles: [{
          source_path: `Media/${slug}.jpg`,
          preview_path: `${slug}.jpg`,
          width: 400,
          height: 400,
          is_video: false,
          is_video_poster: false,
        }],
      }),
    });
  }
  return indexedBlock({ slug, title: null, fallback_label: slug, body: `Body of ${slug}` });
}

function Stand({ expose }: { expose: (controller: Controller, intent: ReturnType<typeof useHoverIntent>) => void }) {
  const intent = useHoverIntent();
  const controller = useHoverPreviewWindow<HoverPreviewElementTarget, LightBlock | IndexedBlock>({
    intent,
    readCard: async (slug) => card(slug),
    place: hoverPreviewBesidePanel(() => document.body.getBoundingClientRect(), "after"),
  });
  expose(controller, intent);
  return (
    <HoverPreviewWindowLayer
      controller={controller}
      vaultPath="/vault"
      thumbsRootPath="/thumbs"
      attribute="data-test-preview"
    />
  );
}

/** A trigger 40 px tall, centred on `centerY`. */
function triggerAt(centerY: number): Element {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({
    x: 0, y: centerY - 20, left: 0, top: centerY - 20, right: 280, bottom: centerY + 20, width: 280, height: 40, toJSON: () => ({}),
  });
  return element;
}

async function settle(ms = 0) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  });
  await act(async () => {
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  });
}

describe("HoverPreviewWindowLayer (SPEC_CARD_STATES.md, С7.11)", () => {
  let controller: Controller;
  let intent: ReturnType<typeof useHoverIntent>;
  let pointerX = 0;
  const shell = () => document.querySelector<HTMLElement>("[data-test-preview]");

  async function open(slug: string, y = 300) {
    render(<Stand expose={(next, nextIntent) => { controller = next; intent = nextIntent; }} />);
    await step(slug, y);
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS);
    await settle(HOVER_INTENT.fadeInMs + FRAME_MS * 2);
  }

  /** The pointer's small step onto `slug`'s trigger, centred on `y`. */
  async function step(slug: string | null, y: number) {
    act(() => {
      pointerX += 1;
      intent.move(slug, pointerX, 100);
      controller.pointer(slug ? { key: slug, slug, element: triggerAt(y) } : null);
    });
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    vi.stubGlobal("innerWidth", 1400);
    vi.stubGlobal("innerHeight", 800);
    // The page's own box: the panel the window stands beside.
    vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 280, bottom: 800, width: 280, height: 800, toJSON: () => ({}),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the card unfolded, out of the pointer's way, on the page's own layer", async () => {
    await open("a");
    const window = shell()!;
    expect(window.parentElement).toBe(document.body);
    expect(window).toHaveClass("pointer-events-none");
    expect(window.querySelector("button")).toBeNull();
    expect(window.querySelector("[data-card-preview-unfolded]")).not.toBeNull();
    expect(window).toHaveTextContent("Body of a");
  });

  it("holds nothing on a layer at rest", async () => {
    await open("a");
    const window = shell()!;
    expect(window.style.willChange).toBe("");
    expect(window.style.transform).toBe("");
    expect(window.style.opacity).toBe("");
    const layer = window.querySelector<HTMLElement>("[data-hover-preview-layer]")!;
    expect(layer.style.willChange).toBe("");
    expect(layer.style.opacity).toBe("");
    expect(window.querySelector("[data-preview-frame-piece]")).toBeNull();
    expect(window).not.toHaveAttribute("data-frame-moving");
  });

  it("does not move while the pointer moves inside one trigger", async () => {
    await open("a");
    await settle(HOVER_INTENT.velocityWindowMs);
    const window = shell()!;
    const top = window.style.top;
    for (let index = 0; index < 4; index += 1) {
      await step("a", 300);
      await settle(FRAME_MS);
    }
    expect(window.style.top).toBe(top);
    expect(window.style.transform).toBe("");
    expect(window.style.willChange).toBe("");
    expect(window.querySelector("[data-preview-frame-piece]")).toBeNull();
  });

  it("goes to the next trigger only by transform, and reads no layout in a frame", async () => {
    await open("a");
    await settle(HOVER_INTENT.velocityWindowMs);
    const window = shell()!;
    const top = window.style.top;
    await step("b", 500);
    const reads = vi.spyOn(Element.prototype, "getBoundingClientRect");
    await settle(FRAME_MS * 3);
    expect(reads).not.toHaveBeenCalled();
    expect(window.style.transform).toMatch(/^translate\(/);
    expect(window.style.willChange).toContain("transform");
    expect(window.style.top).toBe(top);
    expect(window.style.left).toBe("288px");
    await settle(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS);
    expect(window.style.transform).toBe("");
    expect(window.style.willChange).toBe("");
    expect(window.style.top).not.toBe(top);
    expect(window.style.left).toBe("288px");
    reads.mockRestore();
  });

  it("draws the frame in pieces while the card changes, and takes them away at rest", async () => {
    await open("a");
    await settle(HOVER_INTENT.velocityWindowMs);
    await step("b", 300);
    await settle();
    const window = shell()!;
    expect(window).toHaveAttribute("data-frame-moving");
    expect(window.querySelectorAll("[data-preview-frame-piece]").length).toBeGreaterThan(10);
    expect(window.querySelectorAll("[data-hover-preview-layer]")).toHaveLength(2);
    await settle(HOVER_PREVIEW_WINDOW_SETTLE_MS + FRAME_MS * 2);
    expect(window).not.toHaveAttribute("data-frame-moving");
    expect(window.querySelector("[data-preview-frame-piece]")).toBeNull();
    expect(window.querySelectorAll("[data-hover-preview-layer]")).toHaveLength(1);
    expect(window).toHaveTextContent("Body of b");
  });

  it("holds the old card for a picture still decoding, up to the limit", async () => {
    const decode = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode });
    try {
      await open("a");
      await settle(HOVER_INTENT.velocityWindowMs);
      await step("picture", 300);
      await settle();
      expect(decode).toHaveBeenCalled();
      const window = shell()!;
      expect(window.querySelector('[data-hover-preview-layer-role="pending"]')).toHaveStyle({ visibility: "hidden" });
      expect(window.querySelector('[data-hover-preview-layer-role="current"]')).toHaveTextContent("Body of a");
      expect(window).not.toHaveAttribute("data-frame-moving");
      await settle(CARD_PEEK_PREPARE_MAX_MS - 1);
      expect(window.querySelector('[data-hover-preview-layer-role="pending"]')).not.toBeNull();
      await settle(1);
      expect(window.querySelector('[data-hover-preview-layer-role="pending"]')).toBeNull();
      expect(window).toHaveAttribute("data-frame-moving");
      expect(window.querySelector('[data-hover-preview-layer-role="outgoing"]')).toHaveTextContent("Body of a");
    } finally {
      Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    }
  });

  it("fades away in place when the pointer leaves", async () => {
    await open("a");
    const window = shell()!;
    const top = window.style.top;
    act(() => controller.leave());
    await settle(FRAME_MS * 2);
    expect(Number(window.style.opacity)).toBeLessThan(1);
    expect(window.style.top).toBe(top);
    expect(window.style.transform).toBe("");
    await settle(HOVER_INTENT.fadeOutMs + FRAME_MS);
    expect(shell()).toBeNull();
    expect(document.querySelector("[data-hover-preview-window]")).toBeNull();
  });
});
