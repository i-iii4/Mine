import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { clearActionFailures, useActionFailures } from "./actionFailures";
import { COPY_LINK_FAILED_TITLE, COPY_PATH_FAILED_TITLE, copyTextToClipboard } from "./clipboard";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

afterEach(() => {
  act(() => clearActionFailures());
  vi.mocked(writeText).mockReset();
  vi.mocked(invoke).mockClear();
});

function logged(): string[] {
  return vi.mocked(invoke).mock.calls
    .filter(([command]) => command === "plugin:log|log")
    .map(([, args]) => String((args as { message: string }).message));
}

// Copy Path and Copy Link write through the native clipboard; a write that
// fails goes to the log under the caller's words, and the screen shows
// nothing (SPEC_DEEP_AUDIT.md, «Решения пользователя 14.10.2026»).
describe("copyTextToClipboard", () => {
  it("writes the text through the native clipboard", async () => {
    vi.mocked(writeText).mockResolvedValueOnce(undefined);
    act(() => copyTextToClipboard("/space/Cards/note.md", COPY_PATH_FAILED_TITLE));
    expect(writeText).toHaveBeenCalledWith("/space/Cards/note.md");
    await Promise.resolve();
    expect(logged()).toEqual([]);
  });

  it("logs a failed write under the caller's words and shows no notice", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(writeText).mockRejectedValueOnce(new Error("The clipboard is busy."));
    act(() => copyTextToClipboard("https://example.com", COPY_LINK_FAILED_TITLE));
    await waitFor(() => expect(logged()).toEqual(["Could not copy the link: The clipboard is busy."]));
    expect(result.current).toEqual([]);
  });
});
