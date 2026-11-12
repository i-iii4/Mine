import { createRef } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  followMotionKey,
  installMotionInput,
  lastInputIsKey,
  MOTION_KEY_ATTRIBUTE,
  NATIVE_MENU_INPUT,
  nativeMenuCommandIsKey,
  noteNativeMenuCommand,
  useMotionKeyRef,
} from "./motionInput";

// SPEC_MOTION_LEVELS.md, УД4: a key's motion lands at once at every level; a
// menu, a window, the search or a tooltip a key opened carries
// `data-motion-key` while it is on the page.

const removals: (() => void)[] = [];
afterEach(() => {
  while (removals.length > 0) removals.pop()?.();
});

function install(): void {
  removals.push(installMotionInput());
}

function key(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
}

function press(): void {
  window.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
}

function move(movementX: number, movementY: number): void {
  const event = new MouseEvent("pointermove", { bubbles: true });
  Object.defineProperty(event, "movementX", { value: movementX });
  Object.defineProperty(event, "movementY", { value: movementY });
  window.dispatchEvent(event);
}

/** A surface as Radix marks it: `data-state` open or closed. */
function surface(state: "open" | "closed" = "open"): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-state", state);
  document.body.append(element);
  removals.push(() => element.remove());
  return element;
}

/** MutationObserver reports in a microtask. */
async function settle(): Promise<void> {
  await Promise.resolve();
}

describe("the last input", () => {
  it("is never a key on a page that did not install the rule (the clipper, УД10)", () => {
    key();
    noteNativeMenuCommand();
    expect(lastInputIsKey()).toBe(false);
  });

  it("is a key after a keydown and the pointer after a press", () => {
    install();
    expect(lastInputIsKey()).toBe(false);
    key();
    expect(lastInputIsKey()).toBe(true);
    press();
    expect(lastInputIsKey()).toBe(false);
  });

  it("turns to the pointer when it moves, not on a move with no movement", () => {
    install();
    key();
    // WebKit's move under a still pointer when the page changes under it.
    move(0, 0);
    expect(lastInputIsKey()).toBe(true);
    move(3, 0);
    expect(lastInputIsKey()).toBe(false);
  });

  it("counts a native menu command as a key (УД4, п. 1), from one constant", () => {
    install();
    press();
    expect(NATIVE_MENU_INPUT).toBe("key");
    expect(nativeMenuCommandIsKey()).toBe(true);
    noteNativeMenuCommand();
    expect(lastInputIsKey()).toBe(true);
  });

  it("listens once however many times it is installed, and forgets with the last removal", () => {
    const add = vi.spyOn(window, "addEventListener");
    const first = installMotionInput();
    const second = installMotionInput();
    expect(add.mock.calls.filter(([type]) => String(type) === "keydown")).toHaveLength(1);
    add.mockRestore();
    key();
    first();
    first();
    expect(lastInputIsKey()).toBe(true);
    second();
    expect(lastInputIsKey()).toBe(false);
    install();
    expect(lastInputIsKey()).toBe(false);
  });
});

describe("followMotionKey", () => {
  it("marks a surface a key opened, from its first frame", () => {
    install();
    key();
    const element = surface();
    removals.push(followMotionKey(element));
    expect(element).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("leaves a surface the pointer opened unmarked, and its closing by a click", async () => {
    install();
    press();
    const element = surface();
    removals.push(followMotionKey(element));
    expect(element).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    press();
    element.setAttribute("data-state", "closed");
    await settle();
    expect(element).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("marks a surface the pointer opened when a key starts closing it", async () => {
    install();
    press();
    const element = surface();
    removals.push(followMotionKey(element));
    key();
    element.setAttribute("data-state", "closed");
    await settle();
    expect(element).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("keeps a surface a key opened marked whatever closes it", async () => {
    install();
    key();
    const element = surface();
    removals.push(followMotionKey(element));
    move(5, 5);
    press();
    element.setAttribute("data-state", "closed");
    await settle();
    expect(element).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("takes an opening again during the leaving as a new opening", async () => {
    install();
    key();
    const element = surface();
    removals.push(followMotionKey(element));
    element.setAttribute("data-state", "closed");
    await settle();
    press();
    element.setAttribute("data-state", "open");
    await settle();
    expect(element).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("does not take a surface followed again for a new opening", () => {
    install();
    press();
    const element = surface();
    followMotionKey(element)();
    key();
    removals.push(followMotionKey(element));
    expect(element).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });

  it("does not mark a tooltip's change between its open states", async () => {
    install();
    press();
    const element = surface();
    element.setAttribute("data-state", "delayed-open");
    removals.push(followMotionKey(element));
    key();
    element.setAttribute("data-state", "instant-open");
    await settle();
    expect(element).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });
});

describe("useMotionKeyRef", () => {
  it("follows its element and passes it on to the caller's ref", () => {
    install();
    key();
    const objectRef = createRef<HTMLDivElement>();
    const { result } = renderHook(() => useMotionKeyRef(objectRef));
    const element = document.createElement("div");
    result.current(element);
    expect(objectRef.current).toBe(element);
    expect(element).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    result.current(null);
    expect(objectRef.current).toBeNull();

    const callback = vi.fn();
    const { result: withCallback } = renderHook(() => useMotionKeyRef(callback));
    withCallback.current(element);
    expect(callback).toHaveBeenCalledWith(element);
  });

  it("stops following the element it let go", async () => {
    install();
    press();
    const { result } = renderHook(() => useMotionKeyRef<HTMLElement>());
    const element = surface();
    result.current(element);
    result.current(null);
    key();
    element.setAttribute("data-state", "closed");
    await settle();
    expect(element).not.toHaveAttribute(MOTION_KEY_ATTRIBUTE);
  });
});
