// A tooltip glides to the next button of its group (SPEC_MOTION_LEVELS.md,
// М3; user's decision of 15.11.2026; src/lib/tooltipGlide.ts), with the real
// provider, Radix tooltips and `Button`s. jsdom lays nothing out and runs no
// animation: the buttons' boxes are given, and a stylesheet gives the
// tooltip the animation names Radix waits for, the ones tw-animate-css and
// global.css give it; a leaving ends when the test says so.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installMotionInput, MOTION_KEY_ATTRIBUTE } from "@/lib/motionInput";
import type { MotionLevel } from "@/lib/motion";
import {
  TOOLTIP_GLIDE_FRAME_ATTRIBUTE,
  TOOLTIP_GLIDE_OUTGOING_ATTRIBUTE,
  TOOLTIP_GLIDE_SETTLE_MS,
  TOOLTIP_GLIDING_ATTRIBUTE,
  TOOLTIP_HANDOFF_ATTRIBUTE,
  TOOLTIP_HOLD_ATTRIBUTE,
} from "@/lib/tooltipGlide";
import { setMotionLevel } from "@/test/motionLevel";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/** Longer than the button's 500 ms tooltip delay. */
const PAST_THE_DELAY_MS = 650;
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** Radix's state reaches the glides on a mutation record, a microtask after
 *  React's commit and before the frame. */
const settle = () => act(async () => undefined);
const frames = (count: number) => act(async () => {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
});

const animations = document.createElement("style");
animations.textContent = `
  [data-slot="tooltip-content"] { animation-name: enter; }
  [data-slot="tooltip-content"][data-state="closed"] { animation-name: exit; }
  [data-slot="tooltip-content"][data-tooltip-handoff]:not([data-state="closed"]) { animation-name: none; }
`;
beforeAll(() => document.head.append(animations));
afterAll(() => animations.remove());

let removeInput: () => void;
beforeEach(() => {
  removeInput = installMotionInput();
});
afterEach(() => removeInput());

function place(element: Element, box: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
}

/** A row like the image preview's island: Zoom out, a label, Zoom in; and a
 *  button in a container of its own. */
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
const contentSaying = (text: string) => contents().find((content) => content.querySelector("[data-tooltip-text]")?.textContent === text);
/** The tooltips a person sees: on the page and not hidden. */
const seen = () => contents().filter((content) => content.style.visibility !== "hidden");

function layOut(): void {
  place(screen.getByTestId("group"), { left: 0, top: 0, width: 200, height: 32 });
  place(button("Zoom out"), { left: 0, top: 0, width: 32, height: 32 });
  place(screen.getByTestId("label"), { left: 36, top: 0, width: 32, height: 32 });
  place(button("Zoom in"), { left: 72, top: 0, width: 32, height: 32 });
  place(screen.getByTestId("name"), { left: 120, top: 0, width: 60, height: 32 });
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

describe.each<MotionLevel>(["full", "minimal", "off"])("a tooltip glides to the next button of its group at %s (Р1)", (level) => {
  beforeEach(() => setMotionLevel(level));

  it("stays on the page, takes the new text and width, and goes when the pointer leaves the group", async () => {
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    expect(zoomOut).not.toHaveAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);

    // Over the label between the two: the tooltip stays, its leaving waits.
    await leave("Zoom out", { x: 50, y: 16 }, screen.getByTestId("label"));
    expect(zoomOut).toHaveAttribute("data-state", "closed");
    expect(zoomOut).toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    expect(seen()).toEqual([zoomOut]);

    // On the neighbour: its tooltip opens at once, unseen until the frame it
    // takes over in; in that frame it stands at the old place.
    fireEvent.pointerMove(button("Zoom in"), { clientX: 88, clientY: 16 });
    const zoomIn = contentSaying("Zoom in");
    expect(zoomIn).toBeDefined();
    expect(zoomIn).toHaveAttribute("data-state", "instant-open");
    await settle();
    expect(seen()).toHaveLength(1);
    if (seen()[0] === zoomIn) expect(zoomIn).toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    else expect(seen()).toEqual([zoomOut]);

    await frames(3);
    // One tooltip on screen in every step: the new one, at the old place.
    expect(seen()).toEqual([zoomIn]);
    expect(zoomIn).toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    expect(zoomIn).toHaveAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
    expect(zoomIn!.querySelector(`[${TOOLTIP_GLIDE_FRAME_ATTRIBUTE}]`)).not.toBeNull();
    expect(zoomIn!.querySelector(`[${TOOLTIP_GLIDE_OUTGOING_ATTRIBUTE}]`)?.textContent).toBe("Zoom out");
    expect(zoomOut).toHaveStyle({ visibility: "hidden" });
    expect(zoomOut).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    // The old one's leaving, unseen, takes it off the page.
    endLeaving(zoomOut);
    await frames(1);
    expect(zoomOut.isConnected).toBe(false);
    expect(button("Zoom in")).toHaveAttribute("aria-describedby");

    // At rest: its own frame and text, nothing of the glide left.
    await wait(TOOLTIP_GLIDE_SETTLE_MS + 100);
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    expect(zoomIn!.querySelector(`[${TOOLTIP_GLIDE_FRAME_ATTRIBUTE}]`)).toBeNull();
    expect(zoomIn!.querySelector(`[${TOOLTIP_GLIDE_OUTGOING_ATTRIBUTE}]`)).toBeNull();
    const text = zoomIn!.querySelector<HTMLElement>("[data-tooltip-text]")!;
    expect(text.style.transform).toBe("");
    expect(text.style.opacity).toBe("");
    expect(seen()).toEqual([zoomIn]);

    // Out of the group: it goes as before, at once.
    await leave("Zoom in", { x: 88, y: 120 });
    expect(zoomIn).toHaveAttribute("data-state", "closed");
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
    endLeaving(zoomIn!);
    await frames(1);
    expect(contents()).toEqual([]);
  });

  it("goes as before when the pointer stays over the gap past the grace", async () => {
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    await leave("Zoom out", { x: 50, y: 16 }, screen.getByTestId("label"));
    expect(zoomOut).toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    await wait(200);
    expect(zoomOut).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    expect(zoomOut.style.visibility).toBe("");
  });

  it("brings another group's tooltip at its own place, with no glide", async () => {
    render(<Stand />);
    layOut();
    const zoomIn = await restOn("Zoom in", 88);
    await leave("Zoom in", { x: 250, y: 16 });
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    fireEvent.pointerMove(button("Close"), { clientX: 316, clientY: 16 });
    await settle();
    const close = contentSaying("Close");
    expect(close).toBeDefined();
    expect(close).not.toHaveAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
    await frames(3);
    expect(close).not.toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    expect(close!.style.visibility).toBe("");
  });

  it("stands a tooltip the keyboard's focus opened at once, and never glides it", async () => {
    render(<Stand />);
    layOut();
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => button("Zoom out").focus());
    const zoomOut = contentSaying("Zoom out");
    expect(zoomOut).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    fireEvent.keyDown(button("Zoom out"), { key: "Tab" });
    act(() => button("Zoom in").focus());
    const zoomIn = contentSaying("Zoom in");
    expect(zoomIn).toHaveAttribute(MOTION_KEY_ATTRIBUTE);
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
    await frames(3);
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    expect(zoomIn!.style.visibility).toBe("");
  });

  it("leaves a message the pointer does not drive out of the glides", async () => {
    const { rerender } = render(<Stand />);
    layOut();
    await restOn("Zoom in", 88);
    rerender(<Stand notice="That name is taken" />);
    const notice = contentSaying("That name is taken");
    expect(notice).toBeDefined();
    await frames(3);
    expect(notice).not.toHaveAttribute(TOOLTIP_HANDOFF_ATTRIBUTE);
    expect(notice).not.toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    expect(notice!.style.visibility).toBe("");
  });
});

/** The pointer goes out of the window in one move, faster than a frame: its
 *  button and every element up to the root are left for nothing, and no
 *  move comes (WebKit, scripts/tooltip-glide-audit.mjs). */
async function leaveTheWindow(name: string): Promise<void> {
  fireEvent.pointerLeave(button(name), { clientX: -40, clientY: 16, relatedTarget: null });
  fireEvent.pointerLeave(document.documentElement, { clientX: -40, clientY: 16, relatedTarget: null });
  await settle();
}

describe.each<MotionLevel>(["full", "minimal", "off"])("a tooltip when the pointer leaves the window at %s", (level) => {
  beforeEach(() => setMotionLevel(level));

  it("goes, however fast the pointer left, and the next one waits for its delay again", async () => {
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    await leaveTheWindow("Zoom out");
    expect(zoomOut).toHaveAttribute("data-state", "closed");
    expect(zoomOut).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
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

  it("takes a tooltip on its way to the neighbour, with no wait for one", async () => {
    render(<Stand />);
    layOut();
    await restOn("Zoom out", 16);
    await leave("Zoom out", { x: 50, y: 16 }, screen.getByTestId("label"));
    fireEvent.pointerMove(button("Zoom in"), { clientX: 88, clientY: 16 });
    await settle();
    await frames(3);
    const zoomIn = contentSaying("Zoom in");
    expect(zoomIn).toHaveAttribute(TOOLTIP_GLIDING_ATTRIBUTE);
    await leaveTheWindow("Zoom in");
    expect(zoomIn).toHaveAttribute("data-state", "closed");
    expect(zoomIn).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
  });

  it("lets the pointer take a tooltip whose leaving waited over the gap", async () => {
    render(<Stand />);
    layOut();
    const zoomOut = await restOn("Zoom out", 16);
    await leave("Zoom out", { x: 50, y: 16 }, screen.getByTestId("label"));
    expect(zoomOut).toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
    fireEvent.pointerLeave(document.documentElement, { clientX: 50, clientY: -30, relatedTarget: null });
    await settle();
    expect(zoomOut).not.toHaveAttribute(TOOLTIP_HOLD_ATTRIBUTE);
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
