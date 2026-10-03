import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChromeDragGesture } from "./useChromeDragGesture";

const commands = vi.hoisted(() => ({
  startWindowDrag: vi.fn(async () => {}),
}));

vi.mock("@/lib/commands", () => ({
  startWindowDrag: commands.startWindowDrag,
}));

function ChromeButton({ onClick }: { onClick: () => void }) {
  const chromeGesture = useChromeDragGesture();
  return (
    <button type="button" {...chromeGesture} onClick={onClick}>
      Space
    </button>
  );
}

describe("useChromeDragGesture", () => {
  beforeEach(() => {
    commands.startWindowDrag.mockClear();
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

    expect(commands.startWindowDrag).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("asks the backend to drag the tab's window after threshold movement and suppresses click (В23)", () => {
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

    expect(commands.startWindowDrag).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
