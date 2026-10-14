// The tab bar's look follows the stored settings and every change the
// settings window sends (SPEC_TABS.md, «Полоса вкладок»). There is no layout
// variant any more (SPEC_DEEP_AUDIT.md, Е8.1): the bar writes none.
import { act, renderHook } from "@testing-library/react";
import { INTERFACE_FONT_STORAGE_KEY } from "@/lib/fontChoice";
import { SETTINGS_CHANGED_EVENT } from "@/lib/settingsChanged";
import { THEME_STORAGE_KEY } from "@/lib/themeMode";
import { applyStoredAppearance, useAppearanceSync } from "./appearance";

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  for (const name of ["data-theme", "data-design", "data-font-interface"]) root.removeAttribute(name);
});

describe("tab bar appearance", () => {
  it("applies the stored theme and interface font, and no layout variant", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    applyStoredAppearance();

    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-font-interface")).toBe("system");
    expect(root.hasAttribute("data-design")).toBe(false);
    expect(localStorage.getItem("mine.design")).toBeNull();
  });

  it("re-applies the theme a settings change carries, with the value it carries", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    applyStoredAppearance();
    const { unmount } = renderHook(() => useAppearanceSync());

    // The page subscription hears the event with the Tauri envelope.
    act(() => {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
        detail: { payload: { key: THEME_STORAGE_KEY, value: "light" } },
      }));
    });
    expect(root.getAttribute("data-theme")).toBe("light");

    // A font change re-applies the font, and leaves the theme alone.
    root.removeAttribute("data-font-interface");
    act(() => {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
        detail: { payload: { key: INTERFACE_FONT_STORAGE_KEY, value: "system" } },
      }));
    });
    expect(root.getAttribute("data-font-interface")).toBe("system");
    expect(root.getAttribute("data-theme")).toBe("light");

    // Once unmounted, the bar no longer follows.
    unmount();
    act(() => {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
        detail: { payload: { key: THEME_STORAGE_KEY, value: "dark" } },
      }));
    });
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});
