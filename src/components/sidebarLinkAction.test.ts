// A row's button answers as far left as its word will step, at every row,
// stepped or not (user's decision of 15.11.2026; SPEC_CARD_STATES.md, С7.10).
// jsdom resolves neither the custom property's length nor the `::after` box
// the Contents list's stylesheet gives the button: the test gives them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkActionContains, linkActionReach } from "./Sidebar";

/** The reach each test button has, as the stylesheet would give it. */
const reaches = new Map<Element, number>();
const realComputedStyle = window.getComputedStyle;

beforeEach(() => {
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = realComputedStyle(element, pseudo);
    const reach = reaches.get(element);
    if (reach === undefined) return style;
    return new Proxy(style, {
      get(target, property) {
        if (property === "getPropertyValue") {
          return (name: string) => (name === "--sidebar-link-reach" ? `${reach}px` : target.getPropertyValue(name));
        }
        if (property === "width" && pseudo === "::after") return `${reach}px`;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
});

function control(rect: { left: number; top: number; width: number; height: number }, reach: number | null): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("data-sidebar-link-action", "");
  button.getBoundingClientRect = () => DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  if (reach !== null) reaches.set(button, reach);
  return button;
}

afterEach(() => {
  vi.restoreAllMocks();
  reaches.clear();
});

describe("a row's button's answering area", () => {
  it("reaches left of the box as far as the word will step, on a row whose button is not marked", () => {
    const button = control({ left: 200, top: 40, width: 80, height: 32 }, 16);
    expect(button.hasAttribute("data-sidebar-link-pointer")).toBe(false);
    expect(linkActionReach(button)).toBe(16);
    expect(linkActionContains(button, 184, 56)).toBe(true);
    expect(linkActionContains(button, 183.9, 56)).toBe(false);
    expect(linkActionContains(button, 279.9, 56)).toBe(true);
    expect(linkActionContains(button, 280, 56)).toBe(false);
  });

  it("is the same once the button is marked: the edge does not move under the pointer", () => {
    const button = control({ left: 200, top: 40, width: 80, height: 32 }, 16);
    const before = [183, 184, 185].map((x) => linkActionContains(button, x, 56));
    button.setAttribute("data-sidebar-link-pointer", "");
    expect([183, 184, 185].map((x) => linkActionContains(button, x, 56))).toEqual(before);
  });

  it("lets a pointer going straight down through the words land in each row's area", () => {
    const rows = [0, 32, 64, 96].map((top) => control({ left: 200, top, width: 80, height: 32 }, 16));
    for (const [index, button] of rows.entries()) {
      const y = index * 32 + 16;
      expect(rows.map((other) => linkActionContains(other, 186, y))).toEqual(rows.map((other) => other === button));
    }
  });

  it("has no reach where the word does not step, the table", () => {
    const button = control({ left: 200, top: 0, width: 80, height: 32 }, null);
    expect(linkActionReach(button)).toBe(0);
    expect(linkActionContains(button, 199, 16)).toBe(false);
    expect(linkActionContains(button, 200, 16)).toBe(true);
  });
});
