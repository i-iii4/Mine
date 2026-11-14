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

describe("a role's time and curve, a spring's way and a scroll's behaviour (РД2, РД4, УД4)", () => {
  it("gives each role its time in Full and Minimal alike, a press none at Off, a key none in every mode", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    // Отклик 150/100, Поверхность 200 both ways, Перемещение 200: Minimal
    // changes no role's time («Режимы»).
    for (const level of ["full", "minimal"] as const) {
      motion.chooseMotionLevel(level);
      expect(motion.roleMs("response", "enter")).toBe(150);
      expect(motion.roleMs("response", "exit")).toBe(100);
      expect(motion.roleMs("surface", "enter")).toBe(200);
      expect(motion.roleMs("surface", "exit")).toBe(200);
      expect(motion.roleMs("move", "enter")).toBe(200);
      expect(motion.roleMs("move", "exit")).toBe(200);
      expect(motion.roleMs("surface", "enter", { byKey: true })).toBe(0);
      expect(motion.roleMs("move", "enter", { byKey: true })).toBe(0);
    }
    motion.chooseMotionLevel("off");
    for (const role of ["response", "surface", "move"] as const) {
      expect(motion.roleMs(role, "enter")).toBe(0);
      expect(motion.roleMs(role, "exit")).toBe(0);
    }
  });

  it("keeps what answers the pointer, the focus or a drag the same in every mode", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    for (const level of motion.MOTION_LEVELS) {
      motion.chooseMotionLevel(level);
      expect(motion.roleMs("response", "enter", { answers: true })).toBe(150);
      expect(motion.roleMs("response", "exit", { answers: true })).toBe(100);
      expect(motion.roleMs("surface", "enter", { answers: true })).toBe(200);
      expect(motion.roleMs("move", "enter", { answers: true })).toBe(200);
      expect(motion.springMotion({ answers: true })).toBe("spring");
      expect(motion.scrollBehavior({ answers: true })).toBe("smooth");
      // A key's command is at once all the same.
      expect(motion.roleMs("move", "enter", { answers: true, byKey: true })).toBe(0);
    }
  });

  it("gives the system's flag with no choice Minimal, whose times are Full's", async () => {
    systemMotion(true);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.motionLevel()).toBe("minimal");
    expect(motion.roleMs("surface", "enter")).toBe(200);
    expect(motion.springMotion()).toBe("move");
    motion.chooseMotionLevel("off");
    expect(motion.roleMs("surface", "enter")).toBe(0);
  });

  it("gives each role one curve on every level", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    for (const level of motion.MOTION_LEVELS) {
      motion.chooseMotionLevel(level);
      expect(motion.roleEasing("response")).toBe(motion.MOTION_EASE);
      expect(motion.roleEasing("surface")).toBe(motion.MOTION_SURFACE_EASE);
      expect(motion.roleEasing("move")).toBe(motion.MOTION_MOVE_EASE);
    }
  });

  it("moves a member of Пружина on its spring in Full, as Перемещение in Minimal, at once at Off and by a key", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.springMotion()).toBe("spring");
    expect(motion.springMotion({ byKey: true })).toBe("instant");
    motion.chooseMotionLevel("minimal");
    expect(motion.springMotion()).toBe("move");
    expect(motion.springMotion({ byKey: true })).toBe("instant");
    motion.chooseMotionLevel("off");
    expect(motion.springMotion()).toBe("instant");
  });

  it("scrolls smoothly in Full and Minimal, at once at Off and by a key", async () => {
    systemMotion(false);
    const motion = await load();
    motion.installMotionLevel();
    expect(motion.scrollBehavior()).toBe("smooth");
    expect(motion.scrollBehavior({ byKey: true })).toBe("auto");
    motion.chooseMotionLevel("minimal");
    expect(motion.scrollBehavior()).toBe("smooth");
    expect(motion.scrollBehavior({ byKey: true })).toBe("auto");
    motion.chooseMotionLevel("off");
    expect(motion.scrollBehavior()).toBe("auto");
  });
});

describe("the roles' tokens (РД2)", () => {
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
    expect(HOVER_INTENT.fadeInMs).toBe(motion.MOTION_ENTER_MS);
    expect(await token("--motion-exit")).toBe(`${motion.MOTION_EXIT_MS}ms`);
    expect(HOVER_INTENT.fadeOutMs).toBe(motion.MOTION_EXIT_MS);
    expect(await token("--motion-ease")).toBe(motion.MOTION_EASE);
    expect(await token("--motion-surface-enter")).toBe(`${motion.MOTION_SURFACE_MS}ms`);
    expect(await token("--motion-move")).toBe(`${motion.MOTION_MOVE_MS}ms`);
    expect(await token("--motion-move-ease")).toBe(motion.MOTION_MOVE_EASE);
    expect(await token("--motion-menu-blink")).toBe(`${motion.MOTION_MENU_BLINK_MS}ms`);
    const shift = /^calc\((\d+)px \/ (\d+)\)$/.exec(await token("--motion-shift"));
    expect(Number(shift?.[1]) / Number(shift?.[2]) * 6).toBe(CARD_PEEK_MARGIN_PX);
    expect(Number(await token("--motion-scale"))).toBe(CARD_PEEK_CENTER_SCALE);
    expect(CARD_PEEK_NUDGE_SCALE).toBe(1 - (1 - CARD_PEEK_CENTER_SCALE) / 6);
  });
});

describe("a key's mark (УД4, п. 3, п. 7)", () => {
  it("lands at once the surface a key opened and the parts that carry its entrance, nothing that answers the pointer inside it", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const end = css.indexOf("animation-duration: 0.01ms !important;");
    const rule = css.slice(css.lastIndexOf("}", end) + 1, end);
    expect(rule).toContain("[data-motion-key],");
    expect(rule).toContain("[data-motion-key] > :is([data-sidebar-overlay-scrim], [data-sidebar-overlay-panel])");
    expect(rule).toContain("[data-tabs-indicator]");
    // No blanket over what the surface holds: the rows of a search ⌘F
    // opened go on answering the pointer («Режимы»).
    expect(rule).not.toContain("[data-motion-key] *");
    // An app page at Off has no blanket rule either; the clipper keeps its
    // own, which leaves the shake of a refused name moving (УД10, В3).
    expect(rule).not.toMatch(/(^|,)\s*\[data-motion="off"\] \*/);
    expect(rule).toContain('[data-motion-clipper][data-motion="off"] *:not(.mine-progress-indeterminate, .animate-spin, [data-name-refused])');
  });
});
