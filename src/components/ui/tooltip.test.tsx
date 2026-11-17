// The tooltips of a row of buttons (SPEC_MOTION_LEVELS.md, М3; user's
// decision of 15.11.2026, after the motion guide): the first one after its
// delay with its appearance, the next ones at once with none, the one before
// gone in that frame; a tooltip the pointer leaves goes with its leaving, and
// one the pointer opened goes when the pointer leaves the window. With the
// real provider, Radix tooltips and `Button`s. jsdom lays nothing out and runs
// no animation: the buttons' boxes are given, and a stylesheet gives the
// tooltip the animation names Radix waits for, the ones tw-animate-css and
// global.css give it; a leaving ends when the test says so.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMotionInput, MOTION_KEY_ATTRIBUTE } from "@/lib/motionInput";
import type { MotionLevel } from "@/lib/motion";
import { setMotionLevel } from "@/test/motionLevel";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** Longer than the button's 500 ms tooltip delay. */
const PAST_THE_DELAY_MS = 650;
/** Time passes: on the test's own clock where a test fakes it, so a check
 *  that a delay has not run out yet counts it as the page does. */
const wait = (ms: number) => (vi.isFakeTimers()
  ? act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  })
  : act(() => new Promise<void>((resolve) => setTimeout(resolve, ms))));
/** Radix's state reaches the tooltip's own follower on a mutation record, a
 *  microtask after React's commit and before the frame. */
const settle = () => act(async () => undefined);
const frames = (count: number) => act(async () => {
  for (let index = 0; index < count; index += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersToNextFrame();
    else await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
});

const animations = document.createElement("style");
animations.textContent = `
  [data-slot="tooltip-content"] { animation-name: enter; }
  [data-slot="tooltip-content"][data-state="closed"] { animation-name: exit; }
  [data-slot="tooltip-content"][data-state="instant-open"]:not([data-tooltip-message]) { animation-name: none; }
`;
beforeAll(() => document.head.append(animations));
afterAll(() => animations.remove());

let removeInput: () => void;
beforeEach(() => {
  removeInput = installMotionInput();
});
afterEach(() => {
  removeInput();
  vi.useRealTimers();
});

function place(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
}

/** A row like the image preview's island: Zoom out, a label, Zoom in; a
 *  message that cannot be saved beside it; a button in a container of its
 *  own. */
function Stand({ notice = null }: { notice?: string | null }) {
  return (
    <TooltipProvider>
      <div data-testid="group">
        <Button size="icon" aria-label="Zoom out">−</Button>
        <span data-testid="label">100%</span>
        <Button size="icon" aria-label="Zoom in">+</Button>
        <Tooltip open={notice !== null}>
          <TooltipTrigger asChild>
            <span data-testid="name">Name</span>
          </TooltipTrigger>
          <TooltipContent>{notice}</TooltipContent>
        </Tooltip>
      </div>
      <div data-testid="other">
        <Button size="icon" aria-label="Close">×</Button>
      </div>
    </TooltipProvider>
  );
}

const button = (name: string) => screen.getByRole("button", { name });
const contents = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'));
/** A tooltip's own text: its content less the copy Radix keeps for
 *  assistive technology. */
const textOf = (content: HTMLElement) => content.firstChild?.textContent ?? "";
const contentSaying = (text: string) => contents().find((content) => textOf(content) === text);
/** The tooltips a person sees: on the page and not taken over by the next. */
const seen = () => contents().filter((content) => !content.hasAttribute("data-tooltip-replaced"));
const animationOf = (content: HTMLElement) => getComputedStyle(content).animationName;

function layOut(): void {
  place(screen.getByTestId("group"), { left: 0, top: 0, width: 200, height: 32 });
  place(button("Zoom out"), { left: 0, top: 0, width: 32, height: 32 });
  place(screen.getByTestId("label"), { left: 36, top: 0, width: 32, height: 32 });
  place(button("Zoom in"), { left: 72, top: 0, width: 32, height: 32 });
  place(screen.getByTestId("other"), { left: 300, top: 0, width: 32, height: 32 });
  place(button("Close"), { left: 300, top: 0, width: 32, height: 32 });
}

/** The pointer rests on `name` until its tooltip is up. */
async function restOn(name: string, x: number): Promise<HTMLElement> {
  fireEvent.pointerMove(button(name), { clientX: x, clientY: 16 });
  await wait(PAST_THE_DELAY_MS);
  const content = contentSaying(name);
  expect(content).toBeDefined();
  return content!;
}

/** The pointer leaves `name` for a point, moving there. */
async function leave(name: string, to: { x: number; y: number }, over: Element = document.body): Promise<void> {
  fireEvent.pointerLeave(button(name), { clientX: to.x, clientY: to.y });
  fireEvent.pointerMove(over, { clientX: to.x, clientY: to.y });
  await settle();
}

/** The leaving's animation ends; jsdom has no AnimationEvent to carry its
 *  name, which Radix reads. */
function endLeaving(content: HTMLElement): void {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "exit" });
  act(() => {
    content.dispatchEvent(event);
  });
}

describe.each<MotionLevel>(["full", "minimal", "off"])("the tooltips of a row of buttons at %s (Р1)", (level) => {
  beforeEach(() => setMotionLevel(level));

  it("brings the first one after its delay, with its appearance", async () => {
    // The delay runs from the pointer's move, the page's own timer: the
    // page's clock is faked, so the test counts the delay as the page does.
    vi.useFakeTimers();
    render(<Stand />);
    layOut();
    fireEvent.pointerMove(button("Zoom out"), { clientX: 16, clientY: 16 });
    await wait(300);
    expect(contents()).toEqual([]);
    const zoomOut = await restOn("Zoom out", 16);
    expect(zoomOut).toHaveAttribute("data-state", "delayed-open");
    expect(animationOf(zoomOut)).toBe("enter");
  });

  it("puts the next one at once with no appearance, the one before gone in that frame", async () => {
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    // Over the label the tooltip goes with its leaving, as before.
    await leave("Zoom out", { x: 50, y: 16 }, screen.getByTestId("label"));
    expect(zoomOut).toHaveAttribute("data-state", "closed");
    expect(animationOf(zoomOut)).toBe("exit");
    expect(seen()).toEqual([zoomOut]);

    fireEvent.pointerMove(button("Zoom in"), { clientX: 88, clientY: 16 });
    await settle();
    await frames(3);
    const zoomIn = contentSaying("Zoom in");
    expect(zoomIn).toHaveAttribute("data-state", "instant-open");
    expect(animationOf(zoomIn!)).toBe("none");
    // One tooltip on screen: the one before is hidden, its leaving unseen.
    expect(seen()).toEqual([zoomIn]);
    expect(zoomOut).toHaveAttribute("data-tooltip-replaced");
    endLeaving(zoomOut);
    await frames(1);
    expect(zoomOut.isConnected).toBe(false);
    expect(button("Zoom in")).toHaveAttribute("aria-describedby");

    // Any next button, in this row or another, the same way.
    await leave("Zoom in", { x: 250, y: 16 });
    fireEvent.pointerMove(button("Close"), { clientX: 316, clientY: 16 });
    await settle();
    await frames(3);
    const close = contentSaying("Close");
    expect(close).toHaveAttribute("data-state", "instant-open");
    expect(animationOf(close!)).toBe("none");
    expect(seen()).toEqual([close]);
  });

  it("lets a tooltip the pointer leaves go with its leaving when no next one comes", async () => {
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    await leave("Zoom out", { x: 16, y: 120 });
    expect(zoomOut).toHaveAttribute("data-state", "closed");
    expect(animationOf(zoomOut)).toBe("exit");
    expect(zoomOut).not.toHaveAttribute("data-tooltip-replaced");
    endLeaving(zoomOut);
    await frames(1);
    expect(contents()).toEqual([]);
  });

  it("stands a tooltip the keyboard's focus opened at once", async () => {
    render(<Stand />);
    layOut();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => button("Zoom out").focus());
    const zoomOut = contentSaying("Zoom out");
    expect(zoomOut).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    fireEvent.keyDown(button("Zoom out"), { key: "Tab" });
    act(() => button("Zoom in").focus());
    await settle();
    await frames(3);
    const zoomIn = contentSaying("Zoom in");
    expect(zoomIn).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    expect(seen()).toEqual([zoomIn]);
  });

  it("keeps a message's own appearance", async () => {
    const { rerender } = render(<Stand />);
    layOut();
    rerender(<Stand notice="That name is taken" />);
    const notice = contentSaying("That name is taken");
    expect(notice).toHaveAttribute("data-tooltip-message");
    expect(animationOf(notice!)).toBe("enter");
  });
});

/** The pointer goes out of the window in one move, faster than a frame: its
 *  button and every element up to the root are left for nothing, and no
 *  move comes (WebKit, scripts/tooltip-motion-audit.mjs). */
async function leaveTheWindow(name: string): Promise<void> {
  fireEvent.pointerLeave(button(name), { clientX: -40, clientY: 16, relatedTarget: null });
  fireEvent.pointerLeave(document.documentElement, { clientX: -40, clientY: 16, relatedTarget: null });
  await settle();
}

describe.each<MotionLevel>(["full", "minimal", "off"])("a tooltip when the pointer leaves the window at %s", (level) => {
  beforeEach(() => setMotionLevel(level));

  it("goes, however fast the pointer left, and the next one waits for its delay again", async () => {
    // The delays run from the pointer's moves, the page's own timers: the
    // page's clock is faked, so the test counts them as the page does.
    vi.useFakeTimers();
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    await leaveTheWindow("Zoom out");
    expect(zoomOut).toHaveAttribute("data-state", "closed");
    expect(animationOf(zoomOut)).toBe("exit");
    endLeaving(zoomOut);
    await frames(1);
    expect(contents()).toEqual([]);
    // Back on a button: the delay runs as after any close.
    await wait(400);
    fireEvent.pointerMove(button("Zoom in"), { clientX: 88, clientY: 16 });
    await wait(100);
    expect(contentSaying("Zoom in")).toBeUndefined();
    await wait(PAST_THE_DELAY_MS);
    expect(contentSaying("Zoom in")).toHaveAttribute("data-state", "delayed-open");
  });

  it("takes a next tooltip too", async () => {
    render(<Stand />);
    layOut();
    await restOn("Zoom out", 16);
    await leave("Zoom out", { x: 50, y: 16 }, screen.getByTestId("label"));
    fireEvent.pointerMove(button("Zoom in"), { clientX: 88, clientY: 16 });
    await settle();
    const zoomIn = contentSaying("Zoom in");
    expect(zoomIn).toHaveAttribute("data-state", "instant-open");
    await leaveTheWindow("Zoom in");
    expect(zoomIn).toHaveAttribute("data-state", "closed");
  });

  it("keeps a tooltip the keyboard's focus opened while the focus stays", async () => {
    render(<Stand />);
    layOut();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => button("Zoom out").focus());
    const zoomOut = contentSaying("Zoom out");
    expect(zoomOut).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    fireEvent.pointerLeave(document.documentElement, { clientX: -40, clientY: 16, relatedTarget: null });
    await settle();
    expect(zoomOut).not.toHaveAttribute("data-state", "closed");
  });

  it("keeps a message the pointer does not drive", async () => {
    const { rerender } = render(<Stand />);
    layOut();
    rerender(<Stand notice="That name is taken" />);
    const notice = contentSaying("That name is taken");
    fireEvent.pointerLeave(document.documentElement, { clientX: -40, clientY: 16, relatedTarget: null });
    await settle();
    expect(notice).not.toHaveAttribute("data-state", "closed");
  });
});

describe("a tooltip with no provider above, as in the clipper", () => {
  it("goes when the pointer leaves the window too", async () => {
    render(<Button size="icon" aria-label="More">⋯</Button>);
    fireEvent.pointerMove(button("More"), { clientX: 16, clientY: 16 });
    await wait(PAST_THE_DELAY_MS);
    const more = contentSaying("More");
    expect(more).toBeDefined();
    await leaveTheWindow("More");
    expect(more).toHaveAttribute("data-state", "closed");
  });
});
