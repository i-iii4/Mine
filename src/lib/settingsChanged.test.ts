import { beforeEach, describe, expect, it, vi } from "vitest";

const emitted = vi.hoisted(() => [] as Array<{ event: string; payload: unknown }>);
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (event: string, payload: unknown) => { emitted.push({ event, payload }); }),
}));

import {
  SETTINGS_CHANGED_EVENT,
  adoptSettingsChange,
  broadcastSettingsChange,
} from "./settingsChanged";
import { getStoredHoverCollectionPills, HOVER_COLLECTION_PILLS_STORAGE_KEY } from "./hoverCollectionPills";

describe("settings changes across windows", () => {
  beforeEach(() => {
    emitted.length = 0;
    localStorage.clear();
  });

  it("carries the stored value with the key", () => {
    localStorage.setItem(HOVER_COLLECTION_PILLS_STORAGE_KEY, "false");
    broadcastSettingsChange(HOVER_COLLECTION_PILLS_STORAGE_KEY);
    expect(emitted).toEqual([
      { event: SETTINGS_CHANGED_EVENT, payload: { key: HOVER_COLLECTION_PILLS_STORAGE_KEY, value: "false" } },
    ]);
  });

  it("a window whose storage has not caught up reads the new value", () => {
    // The main window still holds the old value: the write from the settings
    // window has not reached its WebKit process yet.
    localStorage.setItem(HOVER_COLLECTION_PILLS_STORAGE_KEY, "true");
    adoptSettingsChange({ key: HOVER_COLLECTION_PILLS_STORAGE_KEY, value: "false" });
    expect(getStoredHoverCollectionPills()).toBe(false);
  });

  it("follows a removal and ignores senders without a value", () => {
    localStorage.setItem("mine.example", "x");
    adoptSettingsChange({ key: "mine.example" });
    expect(localStorage.getItem("mine.example")).toBe("x");
    adoptSettingsChange({ key: "mine.example", value: null });
    expect(localStorage.getItem("mine.example")).toBeNull();
  });
});
