// TRIAL (SPEC_MENU_WINDOW.md, МО41, МО42): the feed owns the right click's
// menu it opens in the menu panel. The menu stays open in StrictMode, whose
// mount runs every effect's cleanup once, and closes when the feed unmounts.

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { lightBlock } from "@/test/blocks";
import { Grid } from "./Grid";

class FiringResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element): void {
    const contentRect = { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRectReadOnly;
    this.cb([{ target: el, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const PROPS = {
  blocks: [lightBlock({ id: 1, slug: "alpha-block", block_type: "article", title: "Alpha", body: "Body text" })],
  vaultPath: "/tmp/vault",
  tags: [],
  scrollToTop: 0,
  routeSnapshotReady: true,
  onBlockClick: vi.fn(),
  onToggleTag: vi.fn(),
  onCreateAndAssign: vi.fn(),
  onLoadBlockTags: vi.fn(async () => new Map<string, string[]>()),
  onBatchSetTag: vi.fn(),
  onCreateAndAssignBatch: vi.fn(),
  onPrepareDeleteSelectedBlocks: vi.fn(async (slugs: string[]) => ({ slugs, markdown_files: [], unused_media: [], shared_media: [] })),
  onDeleteSelectedBlocks: vi.fn(async () => undefined),
  onMergeSelectedBlocks: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the feed's right click menu in the menu panel", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FiringResizeObserver);
    // jsdom does not implement Element.scrollTo.
    Element.prototype.scrollTo = vi.fn();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
    resetMenuPanelSourceForTests(true);
  });

  afterEach(() => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    resetMenuPanelSourceForTests();
    vi.unstubAllGlobals();
  });

  it("stays open in StrictMode, and closes when the feed unmounts", async () => {
    const { unmount } = render(
      <StrictMode>
        <Grid {...PROPS} />
      </StrictMode>,
    );
    await settle();
    const card = document.querySelector('[data-block-slug="alpha-block"]');
    expect(card).not.toBeNull();
    fireEvent.contextMenu(card as HTMLElement, { clientX: 300, clientY: 200 });
    await settle();
    // Asked for in the click's own handler, at the point of the click.
    expect(invokes("menu_panel_open")).toEqual([
      { request: expect.objectContaining({ menu: 1, opener: { kind: "point" }, anchor: { x: 300, y: 200, width: 0, height: 0 } }) },
    ]);
    // The component that follows the card mounted, and StrictMode ran its
    // effects' cleanups: none of them closed the menu.
    expect(invokes("menu_panel_close")).toEqual([]);
    unmount();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
  });
});
