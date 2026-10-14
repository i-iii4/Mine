import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  OPEN_LINK_FAILED_TITLE,
  REVEAL_FAILED_TITLE,
  clearActionFailures,
  useActionFailures,
} from "./actionFailures";
import { openLinkInBrowser, revealInFinder } from "./systemActions";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));

afterEach(() => {
  act(() => clearActionFailures());
  vi.mocked(openUrl).mockReset();
  vi.mocked(revealItemInDir).mockReset();
});

// A link or a file handed to the system from a menu that closed on the press:
// its failure is the tab's notice, and the next success takes it away
// (DESIGN_SYSTEM.md, «Сбой после закрытия окна»; SPEC_DEEP_AUDIT.md, Е6.16).
describe("system actions", () => {
  it("shows a link the browser refused, and hides it once a link opens", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("No browser."));
    act(() => openLinkInBrowser("https://example.com"));
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    await waitFor(() => expect(result.current).toEqual([
      { kind: "open-link", title: OPEN_LINK_FAILED_TITLE, summary: undefined, messages: ["No browser."] },
    ]));

    vi.mocked(openUrl).mockResolvedValueOnce(undefined);
    act(() => openLinkInBrowser("https://example.org"));
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("shows a file Finder could not show, and hides it once one shows", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(revealItemInDir).mockRejectedValueOnce("The file is gone.");
    act(() => revealInFinder("/space/Cards/note.md"));
    expect(revealItemInDir).toHaveBeenCalledWith("/space/Cards/note.md");
    await waitFor(() => expect(result.current).toEqual([
      { kind: "reveal", title: REVEAL_FAILED_TITLE, summary: undefined, messages: ["The file is gone."] },
    ]));

    vi.mocked(revealItemInDir).mockResolvedValueOnce(undefined);
    act(() => revealInFinder("/space/Cards/note.md"));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
