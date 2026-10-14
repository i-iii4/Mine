import { describe, expect, it, vi } from "vitest";
import { emitTo } from "@tauri-apps/api/event";
import {
  TAB_BAR_ACTION_FAILED_EVENT,
  tabBarFailureTitle,
  tabPageLabel,
  tellVisibleTabOfFailure,
} from "./tabBarFailure";

// The tab bar has no room for a notice: it sends its failure to the page of
// the visible tab of its window, which shows it (SPEC_TABS.md, «Ошибки»;
// DESIGN_SYSTEM.md, «Сбой после закрытия окна»).
describe("tab bar failure", () => {
  it("sends the failure to the page of the visible tab", async () => {
    vi.mocked(emitTo).mockClear();
    const failure = { title: tabBarFailureTitle("close the tab"), message: "The window is gone." };
    await tellVisibleTabOfFailure("0123abcd", failure);
    expect(emitTo).toHaveBeenCalledExactlyOnceWith("tab-0123abcd", "tab-bar-action-failed", failure);
    expect(TAB_BAR_ACTION_FAILED_EVENT).toBe("tab-bar-action-failed");
  });

  it("labels a tab's page as the backend does and titles the action in words", () => {
    expect(tabPageLabel("ff00")).toBe("tab-ff00");
    expect(tabBarFailureTitle("open Settings")).toBe("Could not open Settings");
  });
});
