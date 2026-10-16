import { afterEach, describe, expect, it } from "vitest";
import { isDetailShortcutBlockedTarget, isOverlayKeyboardTarget } from "./keyboardTargets";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  const target = document.querySelector<HTMLElement>("[data-target]");
  if (!target) throw new Error("no target");
  return target;
}

describe("isDetailShortcutBlockedTarget: which layers own the page's shortcuts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets the page's own surfaces through: an open card and the sidebar over the feed", () => {
    expect(isDetailShortcutBlockedTarget(mount(`<div role="dialog" data-detail-root><button data-target></button></div>`))).toBe(false);
    // SPEC_NARROW_WINDOW.md, У11: ⇧⌘F works from inside the panel.
    expect(isDetailShortcutBlockedTarget(mount(`<div role="dialog" data-sidebar-overlay-panel><input data-target /></div>`))).toBe(false);
    expect(isDetailShortcutBlockedTarget(mount(`<main><button data-target></button></main>`))).toBe(false);
  });

  it("blocks other dialogs, menus, listboxes and the image preview", () => {
    expect(isDetailShortcutBlockedTarget(mount(`<div role="dialog"><button data-target></button></div>`))).toBe(true);
    expect(isDetailShortcutBlockedTarget(mount(`<div role="menu"><div data-target></div></div>`))).toBe(true);
    expect(isDetailShortcutBlockedTarget(mount(`<div role="listbox"><div data-target></div></div>`))).toBe(true);
    expect(isDetailShortcutBlockedTarget(mount(`<div data-image-preview-overlay><div data-target></div></div>`))).toBe(true);
    // A menu opened from the sidebar over the feed keeps its own keys.
    expect(isDetailShortcutBlockedTarget(mount(
      `<div role="dialog" data-sidebar-overlay-panel><div role="menu"><div data-target></div></div></div>`,
    ))).toBe(true);
  });

  it("keeps the sidebar over the feed an overlay for the feed's own keys", () => {
    expect(isOverlayKeyboardTarget(mount(`<div role="dialog" data-sidebar-overlay-panel><a data-target></a></div>`))).toBe(true);
  });
});
