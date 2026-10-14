import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  COPY_LINK_FAILED_TITLE,
  COPY_PATH_FAILED_TITLE,
  clearActionFailures,
  useActionFailures,
} from "./actionFailures";
import { copyTextToClipboard } from "./clipboard";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

afterEach(() => {
  act(() => clearActionFailures());
  vi.mocked(writeText).mockReset();
});

// Copy Path and Copy Link write through the native clipboard; a write that
// fails is the tab's notice under the title the caller gives, and the next
// copy that succeeds takes it away (DESIGN_SYSTEM.md, «Сбой после закрытия
// окна»; SPEC_DEEP_AUDIT.md, Е6.16).
describe("copyTextToClipboard", () => {
  it("writes the text through the native clipboard", async () => {
    vi.mocked(writeText).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useActionFailures());
    act(() => copyTextToClipboard("/space/Cards/note.md", COPY_PATH_FAILED_TITLE));
    expect(writeText).toHaveBeenCalledWith("/space/Cards/note.md");
    await Promise.resolve();
    expect(result.current).toEqual([]);
  });

  it("shows a failed write under the caller's title, and hides it after a copy succeeds", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(writeText).mockRejectedValueOnce(new Error("The clipboard is busy."));
    act(() => copyTextToClipboard("https://example.com", COPY_LINK_FAILED_TITLE));
    await waitFor(() => expect(result.current).toEqual([
      { kind: "copy", title: COPY_LINK_FAILED_TITLE, summary: undefined, messages: ["The clipboard is busy."] },
    ]));

    vi.mocked(writeText).mockResolvedValueOnce(undefined);
    act(() => copyTextToClipboard("https://example.com", COPY_LINK_FAILED_TITLE));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
