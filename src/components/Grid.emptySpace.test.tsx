// The empty feed of Everything (SPEC_ONBOARDING.md, О14 and О15): a space that
// never had a card introduces the clipper; a space whose cards were all
// deleted says its feed is empty and does not introduce anything again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Grid } from "./Grid";

class FiringResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element): void {
    const contentRect = { width: 400, height: 800, top: 0, left: 0, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRectReadOnly;
    this.cb([{ target: el, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const PROPS = {
  blocks: [],
  vaultPath: "/tmp/vault",
  tags: [],
  scrollToTop: 0,
  routeSnapshotReady: true,
  onInstallClipper: vi.fn(),
  onBlockClick: vi.fn(),
  onToggleTag: vi.fn(),
  onCreateAndAssign: vi.fn(),
  onLoadBlockTags: vi.fn(async () => new Map<string, string[]>()),
  onBatchSetTag: vi.fn(),
  onCreateAndAssignBatch: vi.fn(),
  onDeleteSelectedBlocks: vi.fn(),
  onMergeSelectedBlocks: vi.fn(),
  onRequestRename: vi.fn(),
  onRequestDelete: vi.fn(),
};

describe("empty Everything feed (А6.13)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FiringResizeObserver);
    // jsdom does not implement Element.scrollTo.
    Element.prototype.scrollTo = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("introduces the clipper in a space that never had a card", () => {
    const { container } = render(<Grid {...PROPS} spaceOnboardingOwed />);
    expect(container.querySelector("[data-empty-space-onboarding]")).not.toBeNull();
    expect(container.querySelector("[data-grid-empty-channel-placeholder]")).toBeNull();
  });

  it("says the feed is empty after every card was deleted, without the introduction", () => {
    const { container } = render(<Grid {...PROPS} spaceOnboardingOwed={false} />);
    expect(container.querySelector("[data-empty-space-onboarding]")).toBeNull();
    expect(container.querySelector("[data-grid-empty-channel-placeholder-text]"))
      .toHaveTextContent("Elements you save will appear here.");
  });

  it("shows neither while the space has not answered yet", () => {
    const { container } = render(<Grid {...PROPS} spaceOnboardingOwed={null} />);
    expect(container.querySelector("[data-empty-space-onboarding]")).toBeNull();
    expect(container.querySelector("[data-grid-empty-channel-placeholder]")).toBeNull();
  });
});
