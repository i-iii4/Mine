import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ButtonStyleNotice, BUTTON_STYLE_NOTICE_MS } from "./ButtonStyleNotice";
import { BUTTON_STYLE_NOTICE_EVENT } from "@/lib/buttonStyle";

/// Dev button styles: a switch shows which style is on for a moment. Which
/// page hears it is decided by the bar (src/lib/buttonStyle.ts).
describe("ButtonStyleNotice", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the style a switch turned on and leaves after a moment", () => {
    render(<ButtonStyleNotice />);
    act(() => {
      window.dispatchEvent(new CustomEvent(BUTTON_STYLE_NOTICE_EVENT, { detail: "Buttons: Retro" }));
    });
    expect(screen.getByText("Buttons: Retro")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(BUTTON_STYLE_NOTICE_MS));
    expect(screen.queryByText("Buttons: Retro")).not.toBeInTheDocument();
  });

  it("starts over on a second switch", () => {
    render(<ButtonStyleNotice />);
    act(() => {
      window.dispatchEvent(new CustomEvent(BUTTON_STYLE_NOTICE_EVENT, { detail: "Buttons: Retro" }));
    });
    act(() => vi.advanceTimersByTime(BUTTON_STYLE_NOTICE_MS - 200));
    act(() => {
      window.dispatchEvent(new CustomEvent(BUTTON_STYLE_NOTICE_EVENT, { detail: "Buttons: Linear" }));
    });
    act(() => vi.advanceTimersByTime(BUTTON_STYLE_NOTICE_MS - 200));
    expect(screen.getByText("Buttons: Linear")).toBeInTheDocument();
  });
});
