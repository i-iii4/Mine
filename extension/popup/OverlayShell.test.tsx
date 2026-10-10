// The overlay moves by its header and resizes by any of its corners, keeps
// what the person set between openings and fits it into the window
// (SPEC_CLIPPER.md, «Доработки после живого просмотра», пункт 4 и Р10).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverlayCorner } from "./lib/overlayBounds";

const { stored } = vi.hoisted(() => {
  const stored: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: { set: async (values: Record<string, unknown>) => { Object.assign(stored, values); } } },
  };
  return { stored };
});

const LONG_SPACE = "/Users/x/Spaces/A space whose name fills the whole header of the clipper";

// The "…" menu reads the browser's settings; here it is the plain button it is.
vi.mock("./components/ClipperOverflowMenu", () => ({
  ClipperOverflowMenu: () => <button type="button" aria-label="More" />,
}));

vi.mock("./PopupApp", async () => {
  const { VaultSelect } = await import("./components/VaultSelect");
  return {
    PopupApp: () => (
      <div>
        <VaultSelect
          value={LONG_SPACE}
          options={[LONG_SPACE, "/Users/x/Spaces/Journal"]}
          onChange={() => undefined}
          onReveal={() => undefined}
          onAddSpace={() => undefined}
          onClose={() => undefined}
        />
        <p>Body</p>
      </div>
    ),
  };
});

import { OverlayShell } from "./OverlayShell";

function setWindow(width: number, height: number) {
  Object.assign(window, { innerWidth: width, innerHeight: height });
  act(() => { window.dispatchEvent(new Event("resize")); });
}

function open(initialBounds?: Parameters<typeof OverlayShell>[0]["initialBounds"]) {
  const view = render(<OverlayShell portalContainer={null} edits={{ changed: false }} initialBounds={initialBounds} />);
  const panel = view.container.querySelector<HTMLElement>("[data-mine-clipper-panel]")!;
  const corner = (name: OverlayCorner) => panel.querySelector<HTMLElement>(`[data-clipper-resize-handle="${name}"]`)!;
  return {
    ...view, panel, corner,
    header: panel.querySelector<HTMLElement>("[data-clipper-drag-handle]")!,
    name: screen.getByRole("button", { name: /Switch space: A space whose name/ }),
  };
}

/** A press at (500, 100), a move by `dx`, `dy`, a release, and the click a
 *  browser sends after it to the element pressed. */
function press(from: HTMLElement, panel: HTMLElement, dx: number, dy: number) {
  fireEvent.pointerDown(from, { pointerId: 1, button: 0, clientX: 500, clientY: 100 });
  fireEvent.pointerMove(panel, { pointerId: 1, clientX: 500 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(panel, { pointerId: 1, clientX: 500 + dx, clientY: 100 + dy });
  fireEvent.click(from);
}

const box = (panel: HTMLElement) => ({
  left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), width: parseFloat(panel.style.width),
  height: panel.style.height ? parseFloat(panel.style.height) : null,
});

const menuIsOpen = () => screen.queryByRole("textbox", { name: "Search spaces" }) !== null;

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
    press(header, panel, -300, 200);
    expect(box(panel)).toMatchObject({ left: 1440 - 16 - 360 - 300, top: 216 });
    expect(stored.mineOverlayBounds).toEqual({ left: 764, top: 216, width: 360, height: null });
    press(header, panel, 5000, -5000);
    expect(box(panel)).toMatchObject({ left: 1440 - 360, top: 0 });
  });

  it("moves by the space's name past 4 px, and the menu stays shut", () => {
    const { panel, name } = open();
    press(name, panel, -300, 200);
    expect(box(panel)).toMatchObject({ left: 1440 - 16 - 360 - 300, top: 216 });
    expect(stored.mineOverlayBounds).toEqual({ left: 764, top: 216, width: 360, height: null });
    expect(menuIsOpen()).toBe(false);
    expect(name).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the space menu on a click of the name, and on a press that moves less than 4 px", async () => {
    const { panel, name } = open();
    press(name, panel, 2, 2);
    expect(box(panel)).toMatchObject({ left: 1440 - 16 - 360, top: 16 });
    expect(stored.mineOverlayBounds).toBeUndefined();
    expect(await screen.findByRole("textbox", { name: "Search spaces" })).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-expanded", "true");
  });

  it("does not move when the press is on the \"…\" or close button or on the body", () => {
    const { panel, getByRole, getByText } = open();
    press(getByRole("button", { name: "More" }), panel, -300, 200);
    press(getByRole("button", { name: "Close" }), panel, -300, 200);
    press(getByText("Body"), panel, -300, 200);
    expect(box(panel)).toMatchObject({ left: 1440 - 16 - 360, top: 16 });
    expect(stored.mineOverlayBounds).toBeUndefined();
  });

  it("has a 16 px corner on each side, with the cursor of its diagonal", () => {
    const { corner } = open();
    expect(corner("top-left").className).toContain("cursor-nwse-resize");
    expect(corner("bottom-right").className).toContain("cursor-nwse-resize");
    expect(corner("top-right").className).toContain("cursor-nesw-resize");
    expect(corner("bottom-left").className).toContain("cursor-nesw-resize");
    for (const name of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      expect(corner(name).className).toContain("size-4");
      expect(corner(name)).toHaveAttribute("aria-hidden", "true");
    }
  });

  // From 400 × 500 at (400, 200): the opposite corner stays where it was.
  it.each([
    ["bottom-right", 120, 80, { left: 400, top: 200, width: 520, height: 580 }],
    ["top-left", -120, -80, { left: 280, top: 120, width: 520, height: 580 }],
    ["top-right", 120, -80, { left: 400, top: 120, width: 520, height: 580 }],
    ["bottom-left", -120, 80, { left: 280, top: 200, width: 520, height: 580 }],
  ] as const)("resizes by its %s corner and keeps the size", (name, dx, dy, expected) => {
    const { panel, corner } = open({ left: 400, top: 200, width: 400, height: 500 });
    press(corner(name), panel, dx, dy);
    expect(box(panel)).toEqual(expected);
    expect(panel.getAttribute("data-clipper-sized")).toBe("true");
    expect(stored.mineOverlayBounds).toEqual(expected);
  });

  it("keeps the opposite corner still at the size limits and at the window's edge", () => {
    const { panel, corner } = open({ left: 400, top: 200, width: 400, height: 500 });
    press(corner("top-left"), panel, 5000, 5000);
    expect(box(panel)).toEqual({ left: 800 - 360, top: 700 - 430, width: 360, height: 430 });
    press(corner("top-left"), panel, -5000, -5000);
    expect(box(panel)).toEqual({ left: 800 - 640, top: 0, width: 640, height: 700 });
    press(corner("bottom-right"), panel, 5000, 5000);
    expect(box(panel)).toEqual({ left: 160, top: 0, width: 640, height: 900 });
    press(corner("bottom-right"), panel, -5000, -5000);
    expect(box(panel)).toEqual({ left: 160, top: 0, width: 360, height: 430 });
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
