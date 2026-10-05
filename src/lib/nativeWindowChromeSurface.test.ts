import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useNativeWindowChromeSurface } from "./nativeWindowChromeSurface";

const commands = vi.hoisted(() => ({
  reportWindowSurface: vi.fn(async (_color: string) => {}),
}));

vi.mock("@/lib/commands", () => ({
  reportWindowSurface: commands.reportWindowSurface,
}));

describe("useNativeWindowChromeSurface (SPEC_TABS.md, В25)", () => {
  beforeEach(() => {
    commands.reportWindowSurface.mockClear();
    document.documentElement.setAttribute("data-theme", "light");
  });
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("--chrome");
  });

  it("reports the chrome colour to the backend on start and on a theme change, once per colour", async () => {
    renderHook(() => useNativeWindowChromeSurface("--chrome"));
    expect(commands.reportWindowSurface).toHaveBeenCalledWith("#fafafa");

    act(() => document.documentElement.setAttribute("data-theme", "dark"));
    await waitFor(() => expect(commands.reportWindowSurface).toHaveBeenLastCalledWith("#0f0f0f"));

    act(() => document.documentElement.style.setProperty("--chrome", "rgb(15, 15, 15)"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands.reportWindowSurface).toHaveBeenCalledTimes(2);
  });

  it("paints no window itself", () => {
    renderHook(() => useNativeWindowChromeSurface("--chrome"));
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("logs a refused report instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    commands.reportWindowSurface.mockRejectedValueOnce(new Error("refused"));
    renderHook(() => useNativeWindowChromeSurface("--chrome"));
    await waitFor(() => {
      expect(error).toHaveBeenCalledWith("Could not report the window surface colour:", expect.any(Error));
    });
    error.mockRestore();
  });
});
