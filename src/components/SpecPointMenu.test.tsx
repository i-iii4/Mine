// A menu described as data that a right click opens (SPEC_MENU_WINDOW.md,
// МО10, МО19, МО41, МО68): in the menu panel when the menu mode is
// `window`, else on the page, its corner on the point either way.

import { StrictMode, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { afterMenuCloses, subscribeContextMenus } from "@/lib/openMenus";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import { menuSpecSize } from "@/lib/menuSpec";
import { sourceVideoSpec } from "@/lib/openCardMenus";
import type { MenuAnswer, MenuPanelToSource, MenuSpec } from "@/types";
import { SpecPointMenu, type SpecPointMenuHandle } from "./SpecPointMenu";

const SPEC = sourceVideoSpec({ downloading: false });
const SURFACE = { "data-source-video-menu": "" } as const;

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

function toSource(menu: number, seq: number, body: MenuPanelToSource) {
  act(() => {
    const payload = { menu, seq, body };
    window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
  });
}

function renderMenu(spec: MenuSpec = SPEC, largest?: MenuSpec) {
  const handle = createRef<SpecPointMenuHandle>();
  const onAct = vi.fn(async (): Promise<MenuAnswer> => ({ kind: "done" }));
  const onOpenChange = vi.fn();
  const view = render(
    <StrictMode>
      <SpecPointMenu handleRef={handle} spec={spec} largest={largest} act={onAct} onOpenChange={onOpenChange} surface={SURFACE} />
    </StrictMode>,
  );
  return { handle, onAct, onOpenChange, ...view };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
  resetMenuPanelSourceForTests(true);
});

afterEach(() => {
  window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
  resetMenuPanelSourceForTests();
});

describe("a right click's menu on the page", () => {
  it("is a dropdown off an anchor of no size on the point, its corner there", async () => {
    const { handle, onAct, onOpenChange } = renderMenu();
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    const menu = await screen.findByRole("menu");
    expect(menu.hasAttribute("data-source-video-menu")).toBe(true);
    expect(menu.getAttribute("data-slot")).toBe("dropdown-menu-content");
    expect([menu.getAttribute("data-side"), menu.getAttribute("data-align")]).toEqual(["right", "start"]);
    const anchor = document.querySelector<HTMLElement>("div.fixed.size-0");
    expect([anchor?.style.left, anchor?.style.top]).toEqual(["300px", "200px"]);
    expect(invokes("menu_panel_open")).toEqual([]);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    // A choice goes straight to the owner's handler.
    fireEvent.click(screen.getByText("Copy Link"));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({ kind: "run", id: "copy-link" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("goes when its owner takes it away", async () => {
    const { handle } = renderMenu();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    await screen.findByRole("menu");
    act(() => handle.current?.close());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

// DESIGN_SYSTEM.md, «Открытое меню» (src/lib/openMenus.ts): the rules of a
// menu a right click opened over the page.
describe("a right click's menu over the page", () => {
  function renderOver(under: { onPointerEnter?: () => void; onClick?: () => void } = {}, onAct?: () => void) {
    const handle = createRef<SpecPointMenuHandle>();
    render(
      <>
        <button type="button" {...under}>Under the menu</button>
        <button type="button">Before</button>
        <input aria-label="Field" />
        <SpecPointMenu
          handleRef={handle}
          spec={SPEC}
          act={async () => {
            onAct?.();
            return { kind: "done" };
          }}
        />
      </>,
    );
    return { handle, under: screen.getByText("Under the menu") };
  }

  it("lets the hover reach what lies under it", async () => {
    const user = userEvent.setup();
    const onPointerEnter = vi.fn();
    const { handle, under } = renderOver({ onPointerEnter });
    act(() => handle.current?.open({ x: 300, y: 200 }));
    await screen.findByRole("menu");
    expect(document.body.style.pointerEvents).toBe("");
    await user.hover(under);
    expect(onPointerEnter).toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on a press outside without acting there", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { handle, under } = renderOver({ onClick });
    act(() => handle.current?.open({ x: 300, y: 200 }));
    await screen.findByRole("menu");
    await user.click(under);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onClick).not.toHaveBeenCalled();
    // The next press is the page's own.
    await user.click(under);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("holds the pointer's answers while it is open (SPEC_CARD_STATES.md, С7.8)", async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    const unsubscribe = subscribeContextMenus(listener);
    try {
      const { handle } = renderOver();
      act(() => handle.current?.open({ x: 300, y: 200 }));
      await screen.findByRole("menu");
      expect(listener).toHaveBeenLastCalledWith(true);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(listener).toHaveBeenLastCalledWith(false));
    } finally {
      unsubscribe();
    }
  });

  // SPEC_FRONTEND.md, «RenameBlockDialog»: a command that moves the focus out
  // of the menu keeps it from going back where it was before the menu.
  it("hands the focus over instead of giving it back", async () => {
    const { handle } = renderOver({}, () => afterMenuCloses(() => screen.getByLabelText("Field").focus()));
    screen.getByText("Before").focus();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    fireEvent.click(await screen.findByText("Copy Link"));
    await waitFor(() => expect(screen.getByLabelText("Field")).toHaveFocus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByLabelText("Field")).toHaveFocus();
  });
});

describe("a right click's menu in the menu panel", () => {
  beforeEach(() => {
    window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
  });

  it("asks the panel at the point with the menu at its largest, nothing on the page", async () => {
    const largest = sourceVideoSpec({ downloading: true });
    const { handle } = renderMenu(SPEC, largest);
    // Mounted with no menu: StrictMode's trial run of the mount closed nothing.
    expect(invokes("menu_panel_close")).toEqual([]);
    act(() => handle.current?.open({ x: 300, y: 200 }));
    const [args] = invokes("menu_panel_open") as [{ request: Record<string, unknown> }];
    expect(args.request).toMatchObject({
      anchor: { x: 300, y: 200, width: 0, height: 0 },
      opener: { kind: "point" },
      spec: SPEC,
      by_key: false,
      ...menuSpecSize(largest),
    });
    await act(async () => {});
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("carries out the panel's choice with the owner's handler, and closes with the panel", async () => {
    const { handle, onAct, onOpenChange } = renderMenu();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    await waitFor(() => expect(invokes("menu_panel_open")).toHaveLength(1));
    toSource(1, 1, { kind: "action", request: 1, action: { kind: "run", id: "open-original" } });
    await waitFor(() => expect(onAct).toHaveBeenCalledWith({ kind: "run", id: "open-original" }));
    toSource(1, 2, { kind: "closed", reason: "chosen", key_returned: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(invokes("menu_panel_close")).toEqual([]);
  });

  it("opens on the page at the same point when the panel refuses it", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "app_inactive" });
    const { handle } = renderMenu();
    act(() => handle.current?.open({ x: 300, y: 200 }));
    const menu = await screen.findByRole("menu");
    expect([menu.getAttribute("data-side"), menu.getAttribute("data-align")]).toEqual(["right", "start"]);
    expect(screen.getByRole("menuitem", { name: "Delete Embed" })).toBeTruthy();
  });
});
