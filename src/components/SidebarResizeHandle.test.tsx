import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

/// The divider is the handle, looking as shadcn's `SidebarRail` does (user's
/// decision of 07.10.2026).
describe("SidebarResizeHandle", () => {
  const props = () => ({
    isResizing: false,
    secondaryBarVisible: false,
    width: 400,
    minWidth: 314,
    maxWidth: 600,
    disabled: false,
    onResizeStart: vi.fn(),
    onResizeUpdate: vi.fn(),
    onResizeEnd: vi.fn(),
    onResizeTo: vi.fn(),
  });

  it("is the rail's 16px catch whose 2px line lights in both bands under the pointer", () => {
    const { container } = render(<SidebarResizeHandle {...props()} />);
    const catches = Array.from(container.querySelectorAll<HTMLElement>("[data-sidebar-resize-handle]"));
    expect(catches).toHaveLength(2);
    for (const element of catches) {
      expect(element.style.width).toBe("16px");
      expect(element.style.left).toBe("calc(var(--sidebar-width) - 9px)");
      expect(element).toHaveClass("cursor-col-resize", "after:left-1/2", "after:w-[2px]");
      expect(element.childElementCount).toBe(0);
      expect(element).not.toHaveClass("after:bg-sidebar-border");
    }
    fireEvent.pointerEnter(catches[1]!);
    for (const element of catches) expect(element).toHaveClass("after:bg-sidebar-border");
    fireEvent.pointerLeave(catches[1]!);
    for (const element of catches) expect(element).not.toHaveClass("after:bg-sidebar-border");
  });

  it("keeps the line lit through a drag and points the cursor back at a bound", () => {
    const { container, rerender } = render(<SidebarResizeHandle {...props()} isResizing />);
    const line = container.querySelector<HTMLElement>("[role='separator']")!;
    expect(line).toHaveClass("after:bg-sidebar-border");
    rerender(<SidebarResizeHandle {...props()} width={314} />);
    expect(line).toHaveClass("cursor-e-resize");
    rerender(<SidebarResizeHandle {...props()} width={600} />);
    expect(line).toHaveClass("cursor-w-resize");
  });

  it("resizes on a drag past the threshold and does nothing on a click", () => {
    const p = props();
    const { container } = render(<SidebarResizeHandle {...p} />);
    const line = container.querySelector<HTMLElement>("[role='separator']")!;
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
    const line = container.querySelector<HTMLElement>("[role='separator']")!;
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
    const line = container.querySelector<HTMLElement>("[role='separator']")!;
    expect(line).toHaveClass("pointer-events-none");
    expect(line).toHaveAttribute("tabindex", "-1");
    fireEvent.pointerEnter(line);
    expect(line).not.toHaveClass("after:bg-sidebar-border");
    fireEvent.keyDown(line, { key: "ArrowLeft" });
    expect(p.onResizeTo).not.toHaveBeenCalled();
  });
});
