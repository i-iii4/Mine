import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTheme as setTauriTheme } from "@tauri-apps/api/app";
import { applyTheme, getStoredTheme } from "./themeMode";

describe("themeMode", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    vi.mocked(setTauriTheme).mockClear();
  });

  it("defaults to system and migrates legacy high-contrast to dark", () => {
    expect(getStoredTheme()).toBe("system");

    localStorage.setItem("theme", "high-contrast");
    expect(getStoredTheme()).toBe("dark");

    localStorage.setItem("theme", "light");
    expect(getStoredTheme()).toBe("light");
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem("theme", "neon");
    expect(getStoredTheme()).toBe("system");
  });

  it("syncs the document and the native AppKit theme for explicit modes", () => {
    applyTheme("dark");

    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(setTauriTheme).toHaveBeenLastCalledWith("dark");
  });

  it("clears overrides and resets the native theme for system mode", () => {
    applyTheme("light");
    applyTheme("system");

    expect(localStorage.getItem("theme")).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("");
    expect(setTauriTheme).toHaveBeenLastCalledWith(null);
  });
});
