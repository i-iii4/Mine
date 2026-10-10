// The overlay moves by its header and resizes by its bottom right corner, keeps
// what the person set between openings and fits it into the window
// (SPEC_CLIPPER.md, «Доработки после живого просмотра», пункт 4 и Р10).
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { stored } = vi.hoisted(() => {
  const stored: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { set: async (values: Record<string, unknown>) => { Object.assign(stored, values); } } },
  };
  return { stored };
});

vi.mock("./PopupApp", () => ({
  PopupApp: () => (
    <div>
      <div data-clipper-drag-handle="" data-testid="header">
        <button type="button">Space</button>
      </div>
      <p>Body</p>
    </div>
  ),
}));

import { OverlayShell } from "./OverlayShell";

function setWindow(width: number, height: number) {
  Object.assign(window, { innerWidth: width, innerHeight: height });
  act(() => { window.dispatchEvent(new Event("resize")); });
}

function open(initialBounds?: Parameters<typeof OverlayShell>[0]["initialBounds"]) {
  const view = render(<OverlayShell portalContainer={null} edits={{ changed: false }} initialBounds={initialBounds} />);
  const panel = view.container.querySelector<HTMLElement>("[data-mine-clipper-panel]")!;
  return { ...view, panel, header: view.getByTestId("header"), corner: panel.querySelector<HTMLElement>("[data-clipper-resize-handle]")! };
}

function drag(from: HTMLElement, panel: HTMLElement, dx: number, dy: number) {
  fireEvent.pointerDown(from, { pointerId: 1, button: 0, clientX: 500, clientY: 100 });
  fireEvent.pointerMove(panel, { pointerId: 1, clientX: 500 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(panel, { pointerId: 1, clientX: 500 + dx, clientY: 100 + dy });
}

const box = (panel: HTMLElement) => ({
  left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), width: parseFloat(panel.style.width),
  height: panel.style.height ? parseFloat(panel.style.height) : null,
});

beforeEach(() => {
  for (const key of Object.keys(stored)) delete stored[key];
  setWindow(1440, 900);
});

afterEach(() => setWindow(1024, 768));

describe("the overlay's place and size (Р10)", () => {
  it("opens in the top right corner at 360 px, following its content, until moved", () => {
    const { panel } = open();
    expect(box(panel)).toEqual({ left: 1440 - 16 - 360, top: 16, width: 360, height: null });
    expect(panel.style.maxHeight).toBe(`${900 - 32}px`);
    expect(panel.hasAttribute("data-clipper-sized")).toBe(false);
  });

  it("moves by its header within the window and keeps the place for the next opening", () => {
    const { panel, header } = open();
    drag(header, panel, -300, 200);
    expect(box(panel)).toMatchObject({ left: 1440 - 16 - 360 - 300, top: 216 });
    expect(stored.mineOverlayBounds).toEqual({ left: 764, top: 216, width: 360, height: null });
    drag(header, panel, 5000, -5000);
    expect(box(panel)).toMatchObject({ left: 1440 - 360, top: 0 });
  });

  it("does not move when the press is on a control of the header or on the body", () => {
    const { panel, getByRole, getByText } = open();
    drag(getByRole("button", { name: "Space" }), panel, -300, 200);
    drag(getByText("Body"), panel, -300, 200);
    expect(box(panel)).toMatchObject({ left: 1440 - 16 - 360, top: 16 });
    expect(stored.mineOverlayBounds).toBeUndefined();
  });

  it("resizes by its bottom right corner from 360 to 640 px wide and from 430 px to the window's height", () => {
    const { panel, corner } = open({ left: 100, top: 100, width: 400, height: 500 });
    drag(corner, panel, 120, 80);
    expect(box(panel)).toEqual({ left: 100, top: 100, width: 520, height: 580 });
    expect(panel.getAttribute("data-clipper-sized")).toBe("true");
    expect(stored.mineOverlayBounds).toEqual({ left: 100, top: 100, width: 520, height: 580 });
    drag(corner, panel, 5000, 5000);
    expect(box(panel)).toEqual({ left: 100, top: 100, width: 640, height: 800 });
    drag(corner, panel, -5000, -5000);
    expect(box(panel)).toEqual({ left: 100, top: 100, width: 360, height: 430 });
  });

  it("stays whole in a smaller window and comes back to what was set when there is room", () => {
    const { panel } = open({ left: 700, top: 300, width: 600, height: 600 });
    setWindow(800, 500);
    expect(box(panel)).toEqual({ left: 200, top: 0, width: 600, height: 500 });
    setWindow(1440, 900);
    expect(box(panel)).toEqual({ left: 700, top: 300, width: 600, height: 600 });
    expect(stored.mineOverlayBounds).toBeUndefined();
  });
});
