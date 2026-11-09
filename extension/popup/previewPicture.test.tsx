// A picture once shown in the clipper's preview stays the same element: the
// panel's height following its content, the clipper's own updates and a hover
// in the collection list never recreate it (SPEC_CLIPPER.md, Layout).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { state, renders } = vi.hoisted(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: { set: async () => undefined } } };
  return {
    renders: { popup: 0 },
    state: {
      state: "main", saveMode: "app", currentType: "content", articleExtractionState: "ready",
      metadata: { url: "https://example.test/walton-ford", title: "Walton Ford", selection: "", detectedType: "article", image: null as string | null },
      articleData: { content: "Walton Ford\n\n![](https://example.test/big.png)", embeddedVideos: undefined as unknown },
      channels: [{ tag: "Интерфейсы", block_count: 173 }, { tag: "Покупки", block_count: 8 }],
      selectedTags: [], saving: false, savePinned: false, canSave: true, nativeStatusError: null,
      reconnecting: false, connectionChecking: false, retryConnection: vi.fn(),
      channelsLoading: false, channelsError: null, retryChannels: vi.fn(),
      save: vi.fn(), setCurrentType: vi.fn(), toggleTag: vi.fn(), createChannel: vi.fn(),
    },
  };
});
vi.mock("./hooks/useClipperState", () => ({
  useClipperState: () => {
    renders.popup += 1;
    return state;
  },
}));

import { OverlayShell } from "./OverlayShell";
import { PopupApp } from "./PopupApp";

/** The panel's height, as the shell's observer reads it. */
let panelHeight = 400;
const observed: Array<() => void> = [];

beforeEach(() => {
  renders.popup = 0;
  panelHeight = 400;
  observed.length = 0;
  state.currentType = "content";
  state.metadata.image = null;
  state.articleData.content = "Walton Ford\n\n![](https://example.test/big.png)";
  vi.stubGlobal("ResizeObserver", class {
    private readonly fire: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.fire = () => callback([], this as unknown as ResizeObserver);
    }
    observe() { observed.push(this.fire); }
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => (
    { height: panelHeight, width: 360, top: 0, left: 0, right: 360, bottom: panelHeight, x: 0, y: 0, toJSON: () => ({}) }
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const picture = (container: HTMLElement) => container.querySelector<HTMLImageElement>('img[src="https://example.test/big.png"]');

function panelBecomes(height: number) {
  panelHeight = height;
  act(() => { for (const fire of observed) fire(); });
}

describe("the picture in the clipper's preview", () => {
  it("stays the same element while the panel's height follows its content", () => {
    const { container } = render(<OverlayShell portalContainer={null} edits={{ changed: false }} />);
    const shown = picture(container);
    expect(shown).not.toBeNull();
    const rendersBefore = renders.popup;
    // The picture came, then the panel grew, shrank and grew: the observer
    // reports each of them.
    panelBecomes(700);
    panelBecomes(560);
    panelBecomes(700);
    expect(picture(container)).toBe(shown);
    // The panel's size is the shell's: the clipper inside has no reason to run.
    expect(renders.popup).toBe(rendersBefore);
  });

  it("stays the same element when the clipper itself updates", () => {
    const { container, rerender } = render(<PopupApp />);
    const shown = picture(container);
    expect(shown).not.toBeNull();
    state.selectedTags = [];
    rerender(<PopupApp />);
    rerender(<PopupApp />);
    expect(picture(container)).toBe(shown);
  });

  it("is not touched by a hover in the collection list", () => {
    const { container } = render(<PopupApp />);
    const shown = picture(container);
    const rendersBefore = renders.popup;
    const rows = container.querySelectorAll<HTMLElement>("[data-collection-picker-row]");
    fireEvent.pointerMove(rows[1]!, { clientX: 120, clientY: 160, pointerId: 1 });
    expect(rows[1]).toHaveAttribute("data-collection-picker-row-active", "true");
    fireEvent.pointerMove(rows[0]!, { clientX: 120, clientY: 120, pointerId: 1 });
    expect(rows[0]).toHaveAttribute("data-collection-picker-row-active", "true");
    expect(picture(container)).toBe(shown);
    expect(renders.popup).toBe(rendersBefore);
  });
});

describe("a panel left low in the window", () => {
  it("moves up when it grows, without waiting for a task after the frame", () => {
    Object.assign(window, { innerWidth: 1280, innerHeight: 900 });
    const { container } = render(
      <OverlayShell portalContainer={null} edits={{ changed: false }} initialBounds={{ left: 100, top: 400, width: 360, height: null }} />,
    );
    const panel = container.querySelector<HTMLElement>("[data-mine-clipper-panel]")!;
    panelHeight = 749;
    // Outside act, as in a browser: the observer runs just before the paint.
    const environment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const inAct = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (const fire of observed) fire();
      expect(parseFloat(panel.style.top)).toBe(900 - 16 - 749);
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = inAct;
    }
  });
});

// In a browser a picture has no height until it loads. What a block will
// measure is known from its first frame (SPEC_CLIPPER.md, Layout); the real
// geometry is measured in scripts/clipper-worker-smoke.mjs.
describe("the preview's height before the picture arrives", () => {
  const previewOf = (container: HTMLElement) => container.querySelector("[data-clipper-preview]")!;

  it("takes the whole limit of the body when the body has a picture", () => {
    const { container } = render(<PopupApp />);
    expect(previewOf(container)).toHaveClass("h-[280px]");
  });

  it("follows the text when the body has no picture", () => {
    state.articleData.content = "Only words";
    const { container } = render(<PopupApp />);
    expect(previewOf(container)).toHaveClass("max-h-[280px]", "min-h-24");
    expect(previewOf(container)).not.toHaveClass("h-[280px]");
  });

  it("stands at the picture's limit for an image clip", () => {
    state.currentType = "image";
    state.metadata.image = "https://example.test/big.png";
    const { container } = render(<PopupApp />);
    expect(previewOf(container)).toHaveClass("h-[220px]");
  });

  it("gives a link's picture its limit", () => {
    state.currentType = "link";
    state.metadata.image = "https://example.test/big.png";
    const { container } = render(<PopupApp />);
    expect(picture(container)!.parentElement).toHaveClass("h-[120px]");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
