import { afterEach, describe, expect, it } from "vitest";
import { sidebarWidthHost, writeSidebarWidth } from "./sidebarWidth";

const width = (element: HTMLElement) => element.style.getPropertyValue("--sidebar-width");

describe("the sidebar's width (SPEC_NARROW_WINDOW.md, «Как ширина доходит до раскладки»)", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--sidebar-width");
  });

  it("stands on the root and on every element laid out by it", () => {
    const panel = document.createElement("aside");
    const segment = document.createElement("div");
    const stopPanel = sidebarWidthHost(panel);
    const stopSegment = sidebarWidthHost(segment);

    writeSidebarWidth("min(360px, 100vw - 390px)");

    expect(width(document.documentElement)).toBe("min(360px, 100vw - 390px)");
    expect(width(panel)).toBe("min(360px, 100vw - 390px)");
    expect(width(segment)).toBe("min(360px, 100vw - 390px)");
    stopPanel?.();
    stopSegment?.();
  });

  it("gives an element that appears the width the root holds, and lets go of one that leaves", () => {
    writeSidebarWidth("420px");
    const cell = document.createElement("span");
    const stop = sidebarWidthHost(cell);
    expect(width(cell)).toBe("420px");

    stop?.();
    expect(width(cell)).toBe("");
    writeSidebarWidth("500px");
    expect(width(cell)).toBe("");
  });
});
