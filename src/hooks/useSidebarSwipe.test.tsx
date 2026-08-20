import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useSidebarSwipe } from "./useSidebarSwipe";

function Probe({
  collapsed,
  onToggle,
  disabled,
}: {
  collapsed: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  useSidebarSwipe({ collapsed, onToggle, disabled });
  return null;
}

/// One wheel event, as a trackpad delivers them: a stream of small deltas.
function wheel(deltaX: number, deltaY: number, timeStamp: number) {
  const event = new WheelEvent("wheel", { deltaX, deltaY });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  window.dispatchEvent(event);
}

/// A gesture is many small events, not one big one.
function swipe(totalX: number, startAt = 0, deltaY = 0) {
  const steps = 8;
  for (let i = 0; i < steps; i += 1) {
    wheel(totalX / steps, deltaY, startAt + i * 16);
  }
}

describe("useSidebarSwipe", () => {
  it("opens the panel on a swipe right and closes it on a swipe left", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Probe collapsed onToggle={onToggle} />);

    // Natural scrolling reports negative deltaX for fingers moving right.
    swipe(-120);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<Probe collapsed={false} onToggle={onToggle} />);
    swipe(120, 1000);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the panel is already in the wanted state", () => {
    const onToggle = vi.fn();
    render(<Probe collapsed={false} onToggle={onToggle} />);

    // Swiping right with the panel already open asks for what it has.
    swipe(-120);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores a short nudge", () => {
    const onToggle = vi.fn();
    render(<Probe collapsed onToggle={onToggle} />);

    swipe(-40);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores the sideways noise of a vertical scroll", () => {
    const onToggle = vi.fn();
    render(<Probe collapsed onToggle={onToggle} />);

    // A finger never travels straight: every scroll carries some deltaX. Left
    // unguarded, it accumulates into a swipe over a long page.
    for (let i = 0; i < 60; i += 1) {
      wheel(-6, 40, i * 16);
    }
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("fires once per flick, not once per inertia event", () => {
    const onToggle = vi.fn();
    render(<Probe collapsed onToggle={onToggle} />);

    // Inertia keeps events coming after the fingers lift.
    swipe(-120);
    for (let i = 0; i < 30; i += 1) {
      wheel(-20, 0, 200 + i * 16);
    }
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the trackpad goes quiet", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Probe collapsed onToggle={onToggle} />);

    swipe(-120);
    rerender(<Probe collapsed={false} onToggle={onToggle} />);
    // A pause longer than the rest window, then the opposite swipe.
    swipe(120, 5000);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("stays out of the way while a card is open", () => {
    const onToggle = vi.fn();
    render(<Probe collapsed onToggle={onToggle} disabled />);

    swipe(-200);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
