import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

/// The divider is the handle, built as shadcn's `SidebarRail` is (user's
/// decision of 07.10.2026).
describe("SidebarResizeHandle", () => {
  // The testing library's cleanup unmounts each render, which takes the
  // portalled part out of this row again.
  const topRow = document.createElement("header");
  document.body.append(topRow);

  const props = () => ({
    isResizing: false,
    topRowHost: topRow,
    width: 400,
    minWidth: 314,
    maxWidth: 600,
    disabled: false,
    onResizeStart: vi.fn(),
    onResizeUpdate: vi.fn(),
    onResizeEnd: vi.fn(),
    onResizeTo: vi.fn(),
  });
  const parts = (container: HTMLElement) => ({
    top: topRow.querySelector<HTMLElement>("[data-sidebar-resize-handle]")!,
    body: container.querySelector<HTMLElement>("[role='separator']")!,
  });

  it("lays the rail's 16px catch in the top row and in the body, each as tall as its box", () => {
    const { container } = render(<SidebarResizeHandle {...props()} />);
    const { top, body } = parts(container);
    // The body's part is the handle's own child: the body positions it.
    expect(body.parentElement).toBe(container);
    expect(top.style.top).toBe("0px");
    expect(top.style.bottom).toBe("-1px");
    expect(body.style.top).toBe("0px");
    expect(body.style.bottom).toBe("0px");
    for (const element of [top, body]) {
      expect(element.style.width).toBe("16px");
      expect(element.style.left).toBe("calc(var(--sidebar-width) - 9px)");
      expect(element).toHaveClass("absolute", "cursor-col-resize", "after:left-1/2", "after:w-[2px]");
      expect(element.childElementCount).toBe(0);
      expect(element).not.toHaveClass("after:bg-border-accent");
    }
  });

  it("lights the line in both parts only after the hover wait, and puts it out with no wait", () => {
    const { container } = render(<SidebarResizeHandle {...props()} />);
    const { top, body } = parts(container);
    fireEvent.pointerEnter(top);
    for (const element of [top, body]) {
      expect(element).toHaveClass("after:bg-border-accent", "after:delay-300");
    }
    fireEvent.pointerLeave(top);
    for (const element of [top, body]) {
      expect(element).not.toHaveClass("after:bg-border-accent");
      expect(element).not.toHaveClass("after:delay-300");
    }
  });

  it("lights the line with no wait from the press and through a drag", () => {
    const { container, rerender } = render(<SidebarResizeHandle {...props()} />);
    const { body } = parts(container);
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();
    body.hasPointerCapture = vi.fn(() => true);
    fireEvent.pointerEnter(body);
    fireEvent.pointerDown(body, { pointerId: 1, button: 0, clientX: 400 });
    expect(body).toHaveClass("after:bg-border-accent");
    expect(body).not.toHaveClass("after:delay-300");
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 400 });
    expect(body).toHaveClass("after:delay-300");

    rerender(<SidebarResizeHandle {...props()} isResizing />);
    expect(body).toHaveClass("after:bg-border-accent");
    expect(body).not.toHaveClass("after:delay-300");
  });

  it("points the cursor back at a bound", () => {
    const { container, rerender } = render(<SidebarResizeHandle {...props()} width={314} />);
    const { top, body } = parts(container);
    for (const element of [top, body]) expect(element).toHaveClass("cursor-e-resize");
    rerender(<SidebarResizeHandle {...props()} width={600} />);
    for (const element of [top, body]) expect(element).toHaveClass("cursor-w-resize");
  });

  it("resizes on a drag past the threshold and does nothing on a click", () => {
    const p = props();
    const { container } = render(<SidebarResizeHandle {...p} />);
    const { body: line } = parts(container);
    line.setPointerCapture = vi.fn();
    line.releasePointerCapture = vi.fn();
    line.hasPointerCapture = vi.fn(() => true);

    // A click: no drag, no collapse, nothing else either. Selection is held
    // off from the press and given back on release.
    fireEvent.pointerDown(line, { pointerId: 1, button: 0, clientX: 400 });
    expect(document.body).toHaveClass("sidebar-resizing");
    fireEvent.pointerUp(line, { pointerId: 1, clientX: 401 });
    expect(document.body).not.toHaveClass("sidebar-resizing");
    expect(p.onResizeStart).not.toHaveBeenCalled();
    expect(p.onResizeEnd).not.toHaveBeenCalled();

    fireEvent.pointerDown(line, { pointerId: 1, button: 0, clientX: 400 });
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 420 });
    fireEvent.pointerUp(line, { pointerId: 1, clientX: 420 });
    expect(p.onResizeStart).toHaveBeenCalledWith(400, 400);
    expect(p.onResizeUpdate).toHaveBeenCalledWith(420);
    expect(p.onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it("moves the line from the keyboard as a separator does, and keeps the keys", () => {
    const p = props();
    const { container } = render(<SidebarResizeHandle {...p} />);
    const { body: line } = parts(container);
    expect(line).toHaveAttribute("aria-orientation", "vertical");
    expect(line).toHaveAttribute("aria-valuenow", "400");
    expect(line).toHaveAttribute("tabindex", "0");

    const parentKey = vi.fn();
    document.body.addEventListener("keydown", parentKey);
    fireEvent.keyDown(line, { key: "ArrowLeft" });
    fireEvent.keyDown(line, { key: "ArrowRight" });
    fireEvent.keyDown(line, { key: "Home" });
    fireEvent.keyDown(line, { key: "End" });
    expect(p.onResizeTo.mock.calls).toEqual([[384], [416], [314], [600]]);
    expect(parentKey).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", parentKey);
  });

  it("lets nothing through while a card or a collection is dragged", () => {
    const p = { ...props(), disabled: true };
    const { container } = render(<SidebarResizeHandle {...p} />);
    const { body: line } = parts(container);
    expect(line).toHaveClass("pointer-events-none");
    expect(line).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(line, { key: "ArrowLeft" });
    expect(p.onResizeTo).not.toHaveBeenCalled();
    fireEvent.pointerEnter(line);
    expect(line).not.toHaveClass("after:bg-border-accent");
  });

  it("lays only the body's part until the top row is there", () => {
    const { container } = render(<SidebarResizeHandle {...props()} topRowHost={null} />);
    expect(container.querySelectorAll("[data-sidebar-resize-handle]")).toHaveLength(1);
    expect(topRow.childElementCount).toBe(0);
  });
});
