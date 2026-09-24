import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChromeControl } from "./chrome-control";
import { Button } from "./button";
import { ActionButton } from "../ActionButton";
import { SegmentedControl } from "./segmented-control";

describe("chrome hit targets", () => {
  it("extends the same button and preserves its ref, handler and disabled state", () => {
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    const { rerender } = render(<ChromeControl ref={ref} onClick={click}><button>Action</button></ChromeControl>);
    const button = screen.getByRole("button");
    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute("data-chrome-control");
    expect(button.querySelector("button")).toBeNull();
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    rerender(<ChromeControl ref={ref} onClick={click}><button disabled>Action</button></ChromeControl>);
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("separates icon plate from target without changing ordinary buttons", () => {
    render(<><Button variant="chrome" size="chrome-icon">Chrome</Button><Button size="icon">Ordinary</Button></>);
    const chrome = screen.getByRole("button", { name: "Chrome" });
    expect(chrome).toHaveAttribute("data-chrome-control");
    expect(chrome.querySelector("[data-chrome-plate]")).not.toBeNull();
    const ordinary = screen.getByRole("button", { name: "Ordinary" });
    expect(ordinary).not.toHaveAttribute("data-chrome-control");
    expect(ordinary.querySelector("[data-chrome-plate]")).toBeNull();
  });

  it("extends actions but not read-only shortcuts", () => {
    const click = vi.fn();
    const { unmount } = render(<><ActionButton chrome onClick={click}>Run</ActionButton><ActionButton chrome readOnly>Reference</ActionButton></>);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("data-chrome-control");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(click).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Reference").closest("[data-chrome-control]")).toBeNull();
    unmount();
  });

  it("gives each chrome segment its own target without nesting buttons", () => {
    const change = vi.fn();
    render(<SegmentedControl chrome aria-label="Mode" value="grid" options={[{ value: "grid", label: "Grid" }, { value: "graph", label: "Graph" }]} onChange={change} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAttribute("data-chrome-control");
      expect(button.querySelector("button")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(change).toHaveBeenCalledWith("graph");
  });
});
