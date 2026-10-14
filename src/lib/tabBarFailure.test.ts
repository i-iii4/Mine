import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { logTabBarFailure, tabBarFailureTitle } from "./tabBarFailure";

// A failed command of the tab bar goes to Mine's log, not to any tab
// (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»).
describe("tab bar failure", () => {
  it("writes the action and why to the log", async () => {
    vi.mocked(invoke).mockClear();
    logTabBarFailure("close the tab", new Error("The window is gone."));
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin:log|log", {
      level: 4,
      message: "Could not close the tab: The window is gone.",
      location: "page",
    });
  });

  it("titles the action in words", () => {
    expect(tabBarFailureTitle("open Settings")).toBe("Could not open Settings");
  });
});
