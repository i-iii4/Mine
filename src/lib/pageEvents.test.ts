import { describe, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listenPage } from "./pageEvents";

describe("listenPage (SPEC_TABS.md, В22)", () => {
  it("subscribes through this page's own webview and hears its events", async () => {
    const handler = vi.fn();
    const stop = await listenPage<{ visible: boolean }>("tab-visibility-changed", handler);

    expect(getCurrentWebview().listen).toHaveBeenCalledWith("tab-visibility-changed", handler);
    window.dispatchEvent(new CustomEvent("tab-visibility-changed", { detail: { payload: { visible: false } } }));
    expect(handler).toHaveBeenCalledWith({ payload: { visible: false } });

    stop();
    window.dispatchEvent(new CustomEvent("tab-visibility-changed", { detail: { payload: { visible: true } } }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fails as a rejected promise outside a Tauri page", async () => {
    vi.mocked(getCurrentWebview).mockImplementationOnce(() => {
      throw new TypeError("no Tauri page");
    });
    await expect(listenPage("anything", vi.fn())).rejects.toThrow("no Tauri page");
  });
});
