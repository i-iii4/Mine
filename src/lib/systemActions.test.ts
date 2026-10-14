import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { clearActionFailures, useActionFailures } from "./actionFailures";
import { openLinkInBrowser, revealInFinder } from "./systemActions";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));

afterEach(() => {
  act(() => clearActionFailures());
  vi.mocked(openUrl).mockReset();
  vi.mocked(revealItemInDir).mockReset();
  vi.mocked(invoke).mockClear();
});

function logged(): string[] {
  return vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "plugin:log|log")
    .map(([, args]) => String((args as { message: string }).message));
}

// A link or a file handed to the system: a failure is rare and leaves the
// person nothing to do, so it goes to the log and the screen shows nothing
// (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»).
describe("system actions", () => {
  it("logs a link the browser refused and shows no notice", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("No browser."));
    act(() => openLinkInBrowser("https://example.com"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    await waitFor(() => expect(logged()).toEqual(["Could not open the link https://example.com: No browser."]));
    expect(result.current).toEqual([]);
  });

  it("logs a file Finder could not show and shows no notice", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(revealItemInDir).mockRejectedValueOnce("The file is gone.");
    act(() => revealInFinder("/space/Cards/note.md"));
    expect(revealItemInDir).toHaveBeenCalledWith("/space/Cards/note.md");
    await waitFor(() => expect(logged()).toEqual(["Could not reveal in Finder /space/Cards/note.md: The file is gone."]));
    expect(result.current).toEqual([]);
  });
});
