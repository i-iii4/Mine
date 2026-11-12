import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The module keeps the level of its page: each case loads it afresh.
async function load() {
  vi.resetModules();
  return import("./motion");
}

/** The system's "Reduce motion", heard on the fly: `set` flips it and tells
 *  the listeners, as macOS does. Only this file fakes it (SPEC_MOTION_LEVELS.md,
 *  «Тесты»). */
function systemMotion(reduce: boolean) {
  let matches = reduce;
  const listeners = new Set<() => void>();
  const added = vi.fn();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(prefers-reduced-motion: reduce)" && matches;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => {
      added();
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    added,
    set(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const root = () => document.documentElement.getAttribute("data-motion");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.removeItem("mine.motion");
});

describe("the motion level (SPEC_MOTION_LEVELS.md, НС2, НС3, НС6)", () => {
  it.each([
    ["full", false, "full"],
    ["full", true, "full"],
    ["minimal", false, "minimal"],
    ["minimal", true, "minimal"],
    ["off", false, "off"],
    ["off", true, "off"],
    [null, false, "full"],
    [null, true, "minimal"],
    ["slow", false, "full"],
    ["slow", true, "minimal"],
  ] as const)("is %s stored with the system's flag %s: %s", async (stored, reduce, level) => {
    systemMotion(reduce);
    if (stored !== null) window.localStorage.setItem("mine.motion", stored);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionLevel()).toBe(level);
    expect(root()).toBe(level);
  });

  it("is Full before the page's entry installs it", async () => {
    systemMotion(true);
    const motion = await load();
    expect(motion.motionLevel()).toBe("full");
  });

  it("follows the system on the fly while no level is chosen, and not once one is", async () => {
    const system = systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionLevel()).toBe("full");
    system.set(true);
    expect(motion.motionLevel()).toBe("minimal");
    expect(root()).toBe("minimal");
    system.set(false);
    expect(motion.motionLevel()).toBe("full");
    motion.chooseMotionLevel("full");
    system.set(true);
    expect(motion.motionLevel()).toBe("full");
    expect(root()).toBe("full");
  });

  it("adds no second listener of the system on a second installation", async () => {
    const system = systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    motion.installMotionLevel();
    expect(system.added).toHaveBeenCalledTimes(1);
  });

  it("stores a choice, the system's own level too, and puts it on the root", async () => {
    systemMotion(true);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionLevel()).toBe("minimal");
    motion.chooseMotionLevel("minimal");
    expect(window.localStorage.getItem("mine.motion")).toBe("minimal");
    motion.chooseMotionLevel("off");
    expect(window.localStorage.getItem("mine.motion")).toBe("off");
    expect(root()).toBe("off");
  });

  it("re-reads the stored choice another window made", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    window.localStorage.setItem("mine.motion", "off");
    motion.reloadMotionLevel();
    expect(motion.motionLevel()).toBe("off");
    window.localStorage.removeItem("mine.motion");
    motion.reloadMotionLevel();
    expect(motion.motionLevel()).toBe("full");
  });

  it("takes the system's level when storage cannot be read", async () => {
    systemMotion(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionLevel()).toBe("minimal");
  });

  it("keeps a choice storage will not take for this page's session, and says so", async () => {
    systemMotion(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const motion = await load();
    motion.installMotionLevel();
    motion.chooseMotionLevel("off");
    expect(motion.motionLevel()).toBe("off");
    expect(root()).toBe("off");
    expect(error).toHaveBeenCalled();
  });

  it("wakes a subscriber when the level changes, and not for the same level", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    let renders = 0;
    function Shown() {
      renders += 1;
      return createElement("p", { "data-testid": "level" }, motion.useMotionLevel());
    }
    render(createElement(Shown));
    expect(screen.getByTestId("level")).toHaveTextContent("full");
    const before = renders;
    act(() => motion.chooseMotionLevel("full"));
    expect(renders).toBe(before);
    act(() => motion.chooseMotionLevel("minimal"));
    expect(screen.getByTestId("level")).toHaveTextContent("minimal");
  });
});

describe("the clipper and the graph (УД9, УД10, НС7)", () => {
  it("follows the system alone on its root: Off under the flag, Full without it, the stored key never read", async () => {
    const system = systemMotion(false);
    window.localStorage.setItem("mine.motion", "minimal");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const motion = await load();
    const shadowTop = document.createElement("div");
    const stop = motion.followSystemMotion(shadowTop);
    expect(shadowTop.getAttribute("data-motion")).toBe("full");
    expect(motion.motionLevel()).toBe("full");
    system.set(true);
    expect(shadowTop.getAttribute("data-motion")).toBe("off");
    expect(motion.motionLevel()).toBe("off");
    stop();
    system.set(false);
    expect(shadowTop.getAttribute("data-motion")).toBe("off");
    expect(read).not.toHaveBeenCalledWith("mine.motion");
  });

  it("gives the graph the system's flag alone, whatever level is chosen", async () => {
    const system = systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    motion.chooseMotionLevel("off");
    expect(motion.systemReducesMotion()).toBe(false);
    system.set(true);
    motion.chooseMotionLevel("full");
    expect(motion.systemReducesMotion()).toBe(true);
  });
});

describe("a motion's time and a scroll's behaviour (УД2, УД4)", () => {
  it("gives Full its own time, Minimal the lesser of it and the set's, Off none, a key none on every level", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionMs(200, "enter")).toBe(200);
    expect(motion.motionMs(200, "enter", { byKey: true })).toBe(0);
    motion.chooseMotionLevel("minimal");
    expect(motion.motionMs(200, "enter")).toBe(150);
    expect(motion.motionMs(200, "exit")).toBe(100);
    expect(motion.motionMs(120, "enter")).toBe(120);
    expect(motion.motionMs(200, "enter", { byKey: true })).toBe(0);
    motion.chooseMotionLevel("off");
    expect(motion.motionMs(200, "enter")).toBe(0);
    expect(motion.motionMs(200, "exit", { byKey: true })).toBe(0);
  });

  it("gives the system's flag with no choice Minimal's times, not none", async () => {
    systemMotion(true);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionMs(400, "enter")).toBe(150);
    motion.chooseMotionLevel("off");
    expect(motion.motionMs(400, "enter")).toBe(0);
  });

  it("turns the curve to E only where Minimal shortens the time", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionEasing(200, "enter", "ease")).toBe("ease");
    motion.chooseMotionLevel("minimal");
    expect(motion.motionEasing(200, "enter", "ease")).toBe(motion.MOTION_EASE);
    expect(motion.motionEasing(120, "enter", "ease")).toBe("ease");
  });

  it("scrolls smoothly only in Full and not by a key", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.scrollBehavior()).toBe("smooth");
    expect(motion.scrollBehavior({ byKey: true })).toBe("auto");
    motion.chooseMotionLevel("minimal");
    expect(motion.scrollBehavior()).toBe("auto");
    motion.chooseMotionLevel("off");
    expect(motion.scrollBehavior()).toBe("auto");
  });
});

describe("the five tokens («Величины»)", () => {
  /** A token's value in the root block of global.css. */
  async function token(name: string): Promise<string> {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles/global.css", "utf8");
    const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
    if (!match?.[1]) throw new Error(`No ${name} in global.css`);
    return match[1].trim();
  }

  it("keeps the CSS tokens equal to the code's values", async () => {
    const motion = await load();
    const { HOVER_INTENT } = await import("./hoverIntent");
    const { CARD_PEEK_CENTER_SCALE, CARD_PEEK_MARGIN_PX, CARD_PEEK_NUDGE_SCALE } = await import("./cardPeek");
    expect(await token("--motion-enter")).toBe(`${motion.MOTION_ENTER_MS}ms`);
    expect(await token("--hover-intent-fade-in")).toBe(`${motion.MOTION_ENTER_MS}ms`);
    expect(HOVER_INTENT.fadeInMs).toBe(motion.MOTION_ENTER_MS);
    expect(await token("--motion-exit")).toBe(`${motion.MOTION_EXIT_MS}ms`);
    expect(await token("--hover-intent-fade-out")).toBe(`${motion.MOTION_EXIT_MS}ms`);
    expect(HOVER_INTENT.fadeOutMs).toBe(motion.MOTION_EXIT_MS);
    expect(await token("--motion-ease")).toBe(motion.MOTION_EASE);
    const shift = /^calc\((\d+)px \/ (\d+)\)$/.exec(await token("--motion-shift"));
    expect(Number(shift?.[1]) / Number(shift?.[2]) * 6).toBe(CARD_PEEK_MARGIN_PX);
    expect(Number(await token("--motion-scale"))).toBe(CARD_PEEK_CENTER_SCALE);
    expect(CARD_PEEK_NUDGE_SCALE).toBe(1 - (1 - CARD_PEEK_CENTER_SCALE) / 6);
  });
});

describe("a key's mark (УД4, п. 3, п. 7)", () => {
  it("lands what a key opened at once, but not a menu or tooltip the pointer opened inside it, nor a refused name's shake", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles/global.css", "utf8");
    const start = css.indexOf("[data-motion-key] *:not(");
    const rule = start < 0 ? "" : css.slice(start, css.indexOf(")::before", start));
    expect(rule).toContain("[data-name-refused]");
    expect(rule).toContain(':is([data-radix-menu-content], [data-slot="tooltip-content"]):not([data-motion-key])');
    expect(rule).toContain(':is([data-radix-menu-content], [data-slot="tooltip-content"]):not([data-motion-key]) *');
  });
});
