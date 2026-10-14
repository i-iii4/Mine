import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { logFailure } from "./appLog";

// A failure the person has nothing to do about goes to Mine's log
// (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»).
describe("logFailure", () => {
  it("writes a warning with what failed and why through the app's logger", async () => {
    vi.mocked(invoke).mockClear();
    logFailure("Could not copy the path", new Error("The clipboard is busy."));
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin:log|log", {
      level: 4,
      message: "Could not copy the path: The clipboard is busy.",
      location: "page",
    });
  });

  it("leaves the line to the console when the log cannot be reached", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce(new Error("not allowed"));
    logFailure("Could not open Settings", "no window");
    await vi.waitFor(() => expect(console).toHaveBeenCalledWith("Could not open Settings: no window", expect.any(Error)));
    console.mockRestore();
  });

  // The pages may write to the log only with the logger's permission.
  it("is allowed to the tab pages, the tab bars and the settings window", () => {
    const capability = JSON.parse(
      readFileSync(resolve(__dirname, "../../src-tauri/capabilities/default.json"), "utf8"),
    ) as { webviews: string[]; permissions: string[] };
    expect(capability.permissions).toContain("log:allow-log");
    expect(capability.webviews).toEqual(["tab-*", "tabbar-*", "settings"]);
  });
});
