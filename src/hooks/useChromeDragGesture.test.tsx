import { fireEvent, render, screen } from "@testing-library/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChromeDragGesture } from "./useChromeDragGesture";

function ChromeButton({ onClick }: { onClick: () => void }) {
  const chromeGesture = useChromeDragGesture();
  return (
    <button type="button" {...chromeGesture} onClick={onClick}>
      Space
    </button>
  );
}

describe("useChromeDragGesture", () => {
  const startDragging = vi.fn(async () => {});

  beforeEach(() => {
    startDragging.mockClear();
    vi.mocked(getCurrentWindow).mockReturnValue({
      startDragging,
    } as never);
  });

  it("keeps a short pointer gesture as a normal click", () => {
    const onClick = vi.fn();
    render(<ChromeButton onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Space" });
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 11,
      clientY: 10,
    });
    fireEvent.click(button);

    expect(startDragging).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("starts native window drag after threshold movement and suppresses click", () => {
    const onClick = vi.fn();
    render(<ChromeButton onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Space" });
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 20,
      clientY: 10,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 20,
      clientY: 10,
    });
    fireEvent.click(button);

    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
