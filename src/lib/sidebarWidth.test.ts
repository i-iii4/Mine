import { afterEach, describe, expect, it } from "vitest";
import { sidebarColumnsHost, sidebarWidthHost, writeSidebarWidth } from "./sidebarWidth";

const width = (element: HTMLElement) => element.style.getPropertyValue("--sidebar-width");
const columns = (element: HTMLElement) => element.style.getPropertyValue("--sidebar-columns-width");

describe("the sidebar's width (SPEC_NARROW_WINDOW.md, «Как ширина доходит до раскладки»)", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--sidebar-width");
    document.documentElement.style.removeProperty("--sidebar-columns-width");
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

  it("leaves the columns at the open width when the sidebar's width goes to none (user's decision of 05.11.2026)", () => {
    const panel = document.createElement("aside");
    const cell = document.createElement("span");
    const stopPanel = sidebarWidthHost(panel);
    const stopCell = sidebarColumnsHost(cell);

    writeSidebarWidth("500px");
    expect(columns(cell)).toBe("500px");
    expect(width(cell)).toBe("");

    writeSidebarWidth("0px", "500px");
    expect(width(panel)).toBe("0px");
    expect(width(document.documentElement)).toBe("0px");
    expect(columns(cell)).toBe("500px");
    expect(columns(document.documentElement)).toBe("500px");

    // A drag moves both.
    writeSidebarWidth("420px");
    expect(width(panel)).toBe("420px");
    expect(columns(cell)).toBe("420px");

    stopPanel?.();
    stopCell?.();
    expect(columns(cell)).toBe("");
  });

  it("gives a cell that appears the columns' width the root holds, or its plain width where none was written", () => {
    document.documentElement.style.setProperty("--sidebar-width", "600px");
    const cell = document.createElement("span");
    const stop = sidebarColumnsHost(cell);
    expect(columns(cell)).toBe("600px");
    stop?.();

    writeSidebarWidth("0px", "500px");
    const next = document.createElement("span");
    const stopNext = sidebarColumnsHost(next);
    expect(columns(next)).toBe("500px");
    stopNext?.();
  });
});
