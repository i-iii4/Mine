// The sidebar's preview window over a collection's name (SPEC_CARD_STATES.md,
// С7.12; user's decision of 15.11.2026): the window's second content, its
// trigger and its way to and from a thumbnail's card. jsdom lays nothing
// out: the boxes the rules read are given.

import { act, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { DndContext } from "@dnd-kit/core";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HOVER_PREVIEW_COLD_OPEN_DELAY_MS } from "@/lib/hoverPreviewTiming";
import { HOVER_INTENT } from "@/lib/hoverIntent";
import type { MotionLevel } from "@/lib/motion";
import { indexedBlock } from "@/test/blocks";
import { installCodeMirrorLayoutStubs } from "@/test/codemirror";
import { setMotionLevel } from "@/test/motionLevel";
import { installSidebarStripWidth } from "@/test/sidebarStrip";
import type { PreviewCard, TagCount } from "@/types";
import { Sidebar } from "./Sidebar";

installSidebarStripWidth(1893);

const INTENT_TIMERS = {
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
} satisfies Parameters<typeof vi.useFakeTimers>[0];

function tag(name: string, count: number): TagCount {
  return { tag: name, count };
}

function cards(prefix: string, count: number): PreviewCard[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}-${index}`,
    url: `asset://localhost/thumbs/${prefix}-${index}.micro.jpg`,
    text: false,
    hasThumb: true,
  }));
}

const props: ComponentProps<typeof Sidebar> = {
  collapsed: false,
  widthAnimating: false,
  vaultPath: "/vault",
  thumbsRootPath: "/vault/.mine/cache/thumbs",
  orderedTags: [tag("alpha", 12), tag("beta", 4), tag("empty", 0)],
  channelPreviews: new Map([
    ["__all__", cards("all", 20)],
    ["alpha", cards("alpha", 12)],
    ["beta", cards("beta", 4)],
    ["empty", []],
  ]),
  totalBlocks: 20,
  isDropDragging: false,
  isCreatingChannel: false,
  onSetCreatingChannel: vi.fn(),
  onDeleteTag: vi.fn(),
  onRenameTag: vi.fn(),
  onCreateChannel: vi.fn(),
};

function tree(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <TooltipProvider>
        <DndContext>
          <Sidebar {...props} {...overrides} />
        </DndContext>
      </TooltipProvider>
    </MemoryRouter>
  );
}

function box(element: Element, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
  });
}

/** Runs `ms` and lets the window read, measure and show its content. */
async function settle(ms = 0) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  });
  await act(async () => {
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  });
}

let pointerX = 20;
/** The pointer's own movement onto `target`, resting there: two reports at
 *  different points, then the speed settles (С7.5, С7.2). */
function restOn(target: Element, y = 10) {
  pointerX += 4;
  fireEvent.pointerMove(target, { clientX: pointerX, clientY: y });
  fireEvent.pointerMove(target, { clientX: pointerX + 1, clientY: y });
  act(() => { vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs + 10); });
}

const nameOf = (container: HTMLElement, rowKey: string) =>
  container.querySelector(`[data-sidebar-row-key="${rowKey}"] [data-sidebar-name-cell]`) as HTMLElement;
const theWindow = () => document.querySelector<HTMLElement>("[data-sidebar-thumbnail-hover-preview]");
const collectionShown = () => theWindow()?.querySelector('[data-hover-preview-layer-role="current"] [data-collection-preview]');

// jsdom lays out no text: a name's lines, which the row's button asks for
// over its name (Sidebar.tsx, `nameRunsUnderLinkWord`), are none.
installCodeMirrorLayoutStubs();

beforeEach(() => {
  vi.useFakeTimers(INTENT_TIMERS);
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (command, args) => (
    command === "get_block" ? indexedBlock({ slug: (args as { slug: string }).slug }) : null
  ));
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each<MotionLevel>(["full", "minimal", "off"])("the window over a collection's name at %s (Р1)", (level) => {
  beforeEach(() => setMotionLevel(level));

  it("opens after the rest, beside the menu, with the collection's first nine cards, its whole name and count", async () => {
    const { container } = render(tree());
    restOn(nameOf(container, "tag:alpha"));
    // The rest counts from the pointer's last step, a velocity window ago.
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS - HOVER_INTENT.velocityWindowMs - 60);
    expect(theWindow()).toBeNull();
    await settle(100);
    const shown = collectionShown();
    expect(shown).toHaveAttribute("data-collection-preview", "tag:alpha");
    expect(shown?.querySelectorAll('[data-collection-preview-tile="card"]')).toHaveLength(9);
    expect(shown?.querySelector("[data-collection-preview-name]")).toHaveTextContent("alpha");
    expect(shown?.querySelector("[data-collection-preview-count]")).toHaveTextContent("12 elements");
    // The collection's window reads nothing: no card is asked for.
    expect(invoke).not.toHaveBeenCalledWith("get_block", expect.anything());
  });

  it("shows fewer rows for a short collection, and Everything's with the space's count", async () => {
    const { container } = render(tree());
    restOn(nameOf(container, "tag:beta"));
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 100);
    expect(collectionShown()?.querySelectorAll('[data-collection-preview-tile="card"]')).toHaveLength(4);
    restOn(nameOf(container, "all"));
    await settle(100);
    const all = collectionShown();
    expect(all).toHaveAttribute("data-collection-preview", "all");
    expect(all?.querySelector("[data-collection-preview-name]")).toHaveTextContent("Everything");
    expect(all?.querySelector("[data-collection-preview-count]")).toHaveTextContent("20 elements");
  });

  it("does not open over an empty collection", async () => {
    const { container } = render(tree());
    restOn(nameOf(container, "tag:empty"));
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 200);
    expect(theWindow()).toBeNull();
  });

  it("goes from a thumbnail's card to the collection and back in the one window", async () => {
    const { container } = render(tree());
    const thumbnail = container.querySelector('[data-sidebar-row-key="tag:alpha"] [data-sidebar-preview-thumbnail="trigger"]')!;
    restOn(thumbnail);
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 100);
    const window = theWindow();
    expect(window?.querySelector('[data-hover-preview-layer-role="current"] [data-card-preview]')).not.toBeNull();
    expect(collectionShown()).toBeFalsy();
    restOn(nameOf(container, "tag:alpha"));
    await settle(10);
    // The same window: the card goes out as the collection comes in.
    expect(theWindow()).toBe(window);
    expect(window?.querySelector('[data-hover-preview-layer-role="outgoing"] [data-card-preview]')).not.toBeNull();
    expect(collectionShown()).toHaveAttribute("data-collection-preview", "tag:alpha");
    expect(window).toHaveAttribute("data-frame-moving");
    restOn(thumbnail);
    await settle(10);
    expect(theWindow()).toBe(window);
    expect(window?.querySelector('[data-hover-preview-layer-role="current"] [data-collection-preview]')).toBeNull();
    expect(window?.querySelector('[data-hover-preview-layer-role="outgoing"] [data-collection-preview]')).not.toBeNull();
  });

  it("leaves the count, a thumbnail and the row's button to their own answers", async () => {
    const { container } = render(tree({ linkedBlockSlug: "open-card", linkedTags: ["alpha"], onToggleLinkedTag: vi.fn() }));
    const row = container.querySelector('[data-sidebar-row-key="tag:alpha"]')!;
    const count = row.querySelector("[data-sidebar-meta-count]")!;
    restOn(count);
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 200);
    expect(theWindow()).toBeNull();
    // The button lets the pointer through to the name until its row lights;
    // its box decides, as the name's answer does (С7.10).
    const button = row.querySelector("[data-sidebar-link-action]")!;
    box(button, { left: 200, top: 0, width: 80, height: 32 });
    const name = nameOf(container, "tag:alpha");
    fireEvent.pointerMove(name, { clientX: 230, clientY: 10 });
    fireEvent.pointerMove(name, { clientX: 231, clientY: 10 });
    act(() => { vi.advanceTimersByTime(HOVER_INTENT.velocityWindowMs + 10); });
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 200);
    expect(theWindow()).toBeNull();
    // Off the button, over the name: the collection's window.
    restOn(name);
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 200);
    expect(collectionShown()).toHaveAttribute("data-collection-preview", "tag:alpha");
  });

  it("goes at once when its row is pressed, as a thumbnail's card goes", async () => {
    const { container } = render(tree());
    const name = nameOf(container, "tag:alpha");
    restOn(name);
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 100);
    expect(collectionShown()).toBeTruthy();
    fireEvent.pointerDown(name);
    await settle(10);
    expect(theWindow()).toBeNull();
  });

  it("is gone during a drag", async () => {
    const { container, rerender } = render(tree());
    restOn(nameOf(container, "tag:alpha"));
    await settle(HOVER_PREVIEW_COLD_OPEN_DELAY_MS + 100);
    expect(collectionShown()).toBeTruthy();
    rerender(tree({ isDropDragging: true }));
    await settle(10);
    expect(theWindow()).toBeNull();
  });
});
