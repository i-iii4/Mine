import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventCallback } from "@tauri-apps/api/event";
import { setMotionLevel } from "@/test/motionLevel";
import { installMotionInput } from "./motionInput";
import { SIDEBAR_RESIZING_CLASS, sidebarMorphMotion } from "./sidebarLook";
import { WINDOW_LIVE_RESIZE_EVENT, followWindowLiveResize, windowEdgeInHand } from "./windowLiveResize";

/// The person holding the window's edge (SPEC_MOTION_LEVELS.md, Р1, С3;
/// user's decision of 15.11.2026): the backend's word on the live resize.

const heard = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>(), unlistened: 0 }));
vi.mock("./pageEvents", () => ({
  listenPage: async <T,>(event: string, handler: EventCallback<T>) => {
    heard.handlers.set(event, (payload) => handler({ event, id: 1, payload: payload as T }));
    return () => {
      heard.unlistened += 1;
      heard.handlers.delete(event);
    };
  },
}));

/** The backend says the window's edge is held (`true`) or released. */
const say = (live: boolean) => heard.handlers.get(WINDOW_LIVE_RESIZE_EVENT)!(live);

describe("the window's edge in hand", () => {
  let stop: () => void;
  beforeEach(async () => {
    heard.handlers.clear();
    heard.unlistened = 0;
    stop = followWindowLiveResize();
    await vi.waitFor(() => expect(heard.handlers.has(WINDOW_LIVE_RESIZE_EVENT)).toBe(true));
  });
  afterEach(() => {
    stop();
    document.body.classList.remove(SIDEBAR_RESIZING_CLASS);
  });

  it("follows the live resize's start and end", () => {
    expect(windowEdgeInHand()).toBe(false);
    say(true);
    expect(windowEdgeInHand()).toBe(true);
    say(false);
    expect(windowEdgeInHand()).toBe(false);
  });

  it.each(["full", "minimal", "off"] as const)("moves the sidebar's rows on the spring in %s while the window's edge is held", (level) => {
    setMotionLevel(level);
    say(true);
    expect(sidebarMorphMotion()).toBe("spring");
  });

  it.each([
    ["full", "spring"],
    ["minimal", "move"],
    ["off", "instant"],
  ] as const)("moves them by the level in %s once the window's edge is released", (level, motion) => {
    setMotionLevel(level);
    say(true);
    say(false);
    expect(sidebarMorphMotion()).toBe(motion);
  });

  it.each(["full", "minimal", "off"] as const)("moves them on the spring in %s under the sidebar's edge in hand, as under the window's", (level) => {
    setMotionLevel(level);
    document.body.classList.add(SIDEBAR_RESIZING_CLASS);
    expect(sidebarMorphMotion()).toBe("spring");
  });

  it("lands a key's width at once once the window's edge is released", () => {
    setMotionLevel("full");
    const removeInput = installMotionInput();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    say(true);
    expect(sidebarMorphMotion()).toBe("spring");
    say(false);
    expect(sidebarMorphMotion()).toBe("instant");
    removeInput();
  });

  it.each([
    ["the window losing the focus", () => window.dispatchEvent(new Event("blur"))],
    ["the page put away", () => window.dispatchEvent(new Event("pagehide"))],
  ])("drops the mark on %s", (_name, lose) => {
    setMotionLevel("off");
    say(true);
    lose();
    expect(windowEdgeInHand()).toBe(false);
    expect(sidebarMorphMotion()).toBe("instant");
  });

  it("drops the mark when the page is hidden, and keeps it while it is shown", () => {
    const state = vi.spyOn(document, "visibilityState", "get");
    say(true);
    state.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(windowEdgeInHand()).toBe(true);
    state.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(windowEdgeInHand()).toBe(false);
    state.mockRestore();
  });

  it("drops the mark and the subscription with its teardown", () => {
    say(true);
    stop();
    expect(windowEdgeInHand()).toBe(false);
    expect(heard.unlistened).toBe(1);
    window.dispatchEvent(new Event("blur"));
    // A second teardown in afterEach changes nothing.
    stop = () => undefined;
  });

  it("takes nothing but `true` for a held edge", () => {
    say(true);
    heard.handlers.get(WINDOW_LIVE_RESIZE_EVENT)!(null);
    expect(windowEdgeInHand()).toBe(false);
  });
});
