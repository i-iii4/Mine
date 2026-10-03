// The interface version every page shows (DESIGN_SYSTEM.md, «Версии интерфейса»).

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UI_VERSION,
  UI_VERSION_STORAGE_KEY,
  applyUiVersion,
  getStoredUiVersion,
  getUiVersion,
  storeUiVersion,
} from "./uiVersion";

afterEach(() => {
  localStorage.removeItem(UI_VERSION_STORAGE_KEY);
  document.documentElement.removeAttribute("data-ui-version");
});

describe("interface version", () => {
  it("is version 2, the one being worked on, until another is chosen", () => {
    expect(DEFAULT_UI_VERSION).toBe(2);
    expect(getStoredUiVersion()).toBe(2);
    expect(getUiVersion()).toBe(2);
  });

  it("stores a choice and shows it on the page's root", () => {
    storeUiVersion(1);
    expect(localStorage.getItem(UI_VERSION_STORAGE_KEY)).toBe("1");
    expect(document.documentElement).toHaveAttribute("data-ui-version", "1");
    expect(getStoredUiVersion()).toBe(1);
  });

  it("reads an unknown stored value as the default", () => {
    localStorage.setItem(UI_VERSION_STORAGE_KEY, "7");
    expect(getStoredUiVersion()).toBe(DEFAULT_UI_VERSION);
    applyUiVersion(getStoredUiVersion());
    expect(getUiVersion()).toBe(DEFAULT_UI_VERSION);
  });
});
