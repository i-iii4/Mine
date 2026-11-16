// The owner's side of a menu in the menu panel (SPEC_MENU_WINDOW.md, МО41,
// МО42): one menu at a time, closed where its owner takes it away and when
// the owner unmounts, never by React's trial run of the owner's mount.

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import type { MenuPanelToSource, MenuSpec } from "@/types";
import { usePanelMenu, type PanelMenuRequest } from "./usePanelMenu";

const SPEC: MenuSpec = {
  role: "action",
  entries: [{ kind: "item", id: "reveal", label: "Reveal in Finder", icon: null, variant: "default", truncate: false }],
};

function request(on: Partial<Pick<PanelMenuRequest, "onAction" | "onClosed">> = {}): PanelMenuRequest {
  return {
    anchor: { x: 100, y: 100, width: 24, height: 24 },
    opener: { kind: "plate", align: "end" },
    menu: { spec: SPEC, byKey: false },
    onAction: on.onAction ?? (() => ({ kind: "done" })),
    onClosed: on.onClosed ?? (() => undefined),
    contextMenu: false,
    eventAt: null,
  };
}

function invokes(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
}

function toSource(menu: number, seq: number, body: MenuPanelToSource) {
  act(() => {
    const payload = { menu, seq, body };
    window.dispatchEvent(new CustomEvent(MENU_PANEL_TO_SOURCE_EVENT, { detail: { event: MENU_PANEL_TO_SOURCE_EVENT, payload } }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === "menu_panel_close" ? { closed: true, key_returned: true } : null));
  window.localStorage.setItem(MENU_MODE_STORAGE_KEY, "window");
  resetMenuPanelSourceForTests(true);
});

afterEach(() => {
  window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
  resetMenuPanelSourceForTests();
});

describe("usePanelMenu", () => {
  it("asks the panel for a menu and holds its handle while the menu is there", async () => {
    const { result } = renderHook(() => usePanelMenu());
    expect(result.current.session).toBeNull();
    let asked = false;
    act(() => {
      asked = result.current.open(request());
    });
    expect(asked).toBe(true);
    expect(invokes("menu_panel_open")).toHaveLength(1);
    expect(result.current.session).not.toBeNull();
  });

  it("asks for nothing when no menu goes to the panel now: the owner opens it on its page", () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    const { result } = renderHook(() => usePanelMenu());
    let asked = true;
    act(() => {
      asked = result.current.open(request());
    });
    expect(asked).toBe(false);
    expect(invokes("menu_panel_open")).toEqual([]);
    expect(result.current.session).toBeNull();
  });

  it("lets the handle go when the panel refuses the menu, so the owner's menu opens on the page", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "not_ready" });
    const onClosed = vi.fn();
    const { result } = renderHook(() => usePanelMenu());
    act(() => {
      result.current.open(request({ onClosed }));
    });
    expect(result.current.session).not.toBeNull();
    await settle();
    expect(result.current.session).toBeNull();
    // It never showed: nothing closed.
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("tells the owner when the menu closed elsewhere, and lets the handle go", async () => {
    const onClosed = vi.fn();
    const { result } = renderHook(() => usePanelMenu());
    act(() => {
      result.current.open(request({ onClosed }));
    });
    await settle();
    toSource(1, 1, { kind: "closed", reason: "outside", key_returned: true });
    expect(onClosed).toHaveBeenCalledWith("outside");
    expect(result.current.session).toBeNull();
  });

  it("closes the menu when its owner takes it away, without telling the owner", async () => {
    const onClosed = vi.fn();
    const { result } = renderHook(() => usePanelMenu());
    act(() => {
      result.current.open(request({ onClosed }));
    });
    await settle();
    act(() => result.current.close());
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
    expect(result.current.session).toBeNull();
    await settle();
    expect(onClosed).not.toHaveBeenCalled();
    // Nothing is open: a second closing asks for nothing.
    act(() => result.current.close());
    expect(invokes("menu_panel_close")).toHaveLength(1);
  });

  it("closes the menu when its owner unmounts, and not on the owner's mount in StrictMode", async () => {
    const { result, unmount } = renderHook(() => usePanelMenu(), { wrapper: StrictMode });
    // StrictMode ran the effect's cleanup once on mount: no menu was open.
    expect(invokes("menu_panel_close")).toEqual([]);
    act(() => {
      result.current.open(request());
    });
    await settle();
    expect(invokes("menu_panel_close")).toEqual([]);
    unmount();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
  });
});
