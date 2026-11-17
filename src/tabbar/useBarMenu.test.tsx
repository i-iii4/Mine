// The bar's side of a menu in the menu panel (SPEC_MENU_WINDOW.md, МО19,
// МО41, МО68а): in the panel when the menu mode is `window`, the system's
// own menu when the panel takes none.

import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MENU_MODE_STORAGE_KEY } from "@/lib/menuMode";
import { MENU_PANEL_TO_SOURCE_EVENT } from "@/lib/menuPanelProtocol";
import { resetMenuPanelSourceForTests } from "@/lib/menuPanelSource";
import type { MenuPanelToSource } from "@/types";
import { tabMenuSpec } from "./barMenus";
import { useBarMenu, type BarMenuRequest } from "./useBarMenu";

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

function request(over: Partial<BarMenuRequest> = {}): BarMenuRequest & { onAction: ReturnType<typeof vi.fn>; native: ReturnType<typeof vi.fn> } {
  return {
    key: "tab",
    anchor: { x: 300, y: 12, width: 0, height: 0 },
    opener: { kind: "point" },
    spec: tabMenuSpec(1, 3),
    byKey: false,
    contextMenu: true,
    onAction: vi.fn(),
    native: vi.fn(),
    ...over,
  } as BarMenuRequest & { onAction: ReturnType<typeof vi.fn>; native: ReturnType<typeof vi.fn> };
}

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

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

describe("useBarMenu", () => {
  it("shows the system's menu at once when the menu mode is Web, and asks the panel nothing", () => {
    window.localStorage.removeItem(MENU_MODE_STORAGE_KEY);
    const { result } = renderHook(() => useBarMenu());
    const asked = request();
    act(() => result.current.open(asked));
    expect(asked.native).toHaveBeenCalledTimes(1);
    expect(invokes("menu_panel_open")).toEqual([]);
    expect(result.current.openKey).toBeNull();
  });

  it("asks the panel in the input's handler and names the menu open there", async () => {
    const { result } = renderHook(() => useBarMenu(), { wrapper: strict });
    // Mounted with no menu: StrictMode's trial run of the mount closed nothing.
    expect(invokes("menu_panel_close")).toEqual([]);
    const asked = request();
    act(() => result.current.open(asked));
    const [args] = invokes("menu_panel_open") as [{ request: Record<string, unknown> }];
    expect(args.request).toMatchObject({ anchor: asked.anchor, opener: { kind: "point" }, spec: asked.spec, by_key: false });
    expect(result.current.openKey).toBe("tab");
    expect(asked.native).not.toHaveBeenCalled();
    await settle();
    expect(result.current.openKey).toBe("tab");
  });

  it("carries out the panel's choice, and forgets the menu once the panel closed it", async () => {
    const { result } = renderHook(() => useBarMenu());
    const asked = request();
    act(() => result.current.open(asked));
    await settle();
    toSource(1, 1, { kind: "action", request: 1, action: { kind: "run", id: "close" } });
    await settle();
    expect(asked.onAction).toHaveBeenCalledExactlyOnceWith({ kind: "run", id: "close" });
    toSource(1, 2, { kind: "closed", reason: "chosen", key_returned: true });
    expect(result.current.openKey).toBeNull();
    expect(asked.native).not.toHaveBeenCalled();
    expect(invokes("menu_panel_close")).toEqual([]);
  });

  it("shows the system's menu when the panel refuses the menu", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "app_inactive" });
    const { result } = renderHook(() => useBarMenu());
    const asked = request();
    act(() => result.current.open(asked));
    expect(asked.native).not.toHaveBeenCalled();
    await settle();
    expect(asked.native).toHaveBeenCalledTimes(1);
    expect(result.current.openKey).toBeNull();
  });

  it("sends the open menu anew, takes it away, and closes it when the bar unmounts", async () => {
    const { result, unmount } = renderHook(() => useBarMenu());
    act(() => result.current.open(request()));
    await settle();
    act(() => result.current.update(tabMenuSpec(0, 2)));
    expect(invokes("menu_panel_update")).toEqual([{ menu: 1, number: 1, spec: tabMenuSpec(0, 2) }]);
    act(() => result.current.close());
    expect(result.current.openKey).toBeNull();
    expect(invokes("menu_panel_close")).toEqual([expect.objectContaining({ menu: 1, reason: "source" })]);
    // Closed already: nothing more to take away, nothing to send.
    act(() => result.current.close());
    act(() => result.current.update(tabMenuSpec(0, 1)));
    expect(invokes("menu_panel_close")).toHaveLength(1);
    expect(invokes("menu_panel_update")).toHaveLength(1);

    act(() => result.current.open(request({ key: "settings" })));
    await settle();
    expect(result.current.openKey).toBe("settings");
    unmount();
    expect(invokes("menu_panel_close")).toEqual([
      expect.objectContaining({ menu: 1, reason: "source" }),
      expect.objectContaining({ menu: 2, reason: "source" }),
    ]);
  });
});
