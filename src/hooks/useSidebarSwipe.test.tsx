import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useSidebarSwipe } from "./useSidebarSwipe";

const listeners = new Map<string, (event: { payload: string }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: string }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(unlisten);
  }),
}));

function Probe({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  useSidebarSwipe({ collapsed, onToggle });
  return null;
}

/// The shell recognises the gesture and emits a direction; this is that event.
function swipe(direction: "left" | "right") {
  listeners.get("sidebar-swipe")?.({ payload: direction });
}

beforeEach(() => {
  listeners.clear();
  unlisten.mockClear();
});

describe("useSidebarSwipe", () => {
  it("opens the panel on a swipe right", async () => {
    const onToggle = vi.fn();
    render(<Probe collapsed onToggle={onToggle} />);
    await Promise.resolve();

    swipe("right");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("closes the panel on a swipe left", async () => {
    const onToggle = vi.fn();
    render(<Probe collapsed={false} onToggle={onToggle} />);
    await Promise.resolve();

    swipe("left");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the panel is already in the wanted state", async () => {
    const onToggle = vi.fn();
    render(<Probe collapsed={false} onToggle={onToggle} />);
    await Promise.resolve();

    swipe("right");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("sees the current state without resubscribing", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Probe collapsed onToggle={onToggle} />);
    await Promise.resolve();

    swipe("right");
    rerender(<Probe collapsed={false} onToggle={onToggle} />);
    swipe("left");

    // One subscription, two decisions: the handler reads state through a ref,
    // so a change of panel state never drops the listener.
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
  });
});
