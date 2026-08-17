// The mode decision (О2): the app when its host answers, the granted folder
// when it does not. These tests kill the host and watch which road a save
// takes — the payload must reach the standalone engine, not the native bridge.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const { sendToNative, standalone } = vi.hoisted(() => ({
  sendToNative: vi.fn(),
  standalone: {
    getStandaloneStatus: vi.fn(),
    standaloneSave: vi.fn(),
    standaloneListChannels: vi.fn(),
    standaloneCreateChannel: vi.fn(),
    chooseStandaloneFolder: vi.fn(),
    regrantStandaloneAccess: vi.fn(),
    canPickFolderHere: () => true,
  },
}));

vi.mock("../lib/messaging", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/messaging")>();
  return {
    ...original,
    sendToNative: (...args: unknown[]) => sendToNative(...args),
    getContextMenuData: async () => null,
    extractMetadata: async () => ({ url: "https://example.com", title: "Page" }),
  };
});

vi.mock("../lib/standalone", () => standalone);

// The hook reads `chrome` at module scope, so the global must exist before the
// import below evaluates — hoisted, like the mocks.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).chrome = {};
});

import { useClipperState } from "./useClipperState";

function mockChrome() {
  Object.assign((globalThis as Record<string, unknown>).chrome as object, {
    action: { setBadgeText: vi.fn() },
    storage: {
      session: {
        get: vi.fn(async () => ({})),
        remove: vi.fn(),
      },
    },
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      lastError: undefined,
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://example.com", title: "Page" }]),
      sendMessage: vi.fn((_id: number, _msg: unknown, cb?: (r: unknown) => void) => cb?.(null)),
      get: vi.fn(async () => ({ url: "https://example.com" })),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChrome();
});

describe("standalone mode decision", () => {
  it("saves through the granted folder when the host is silent", async () => {
    sendToNative.mockImplementation(async (payload: { action: string }) => {
      if (payload.action === "get_status") return { ok: false, error: "Native host not installed" };
      return { ok: false, error: "unexpected native call: " + payload.action };
    });
    standalone.getStandaloneStatus.mockResolvedValue({
      configured: true,
      folderName: "Mine",
      permission: "granted",
    });
    standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [] });
    standalone.standaloneSave.mockResolvedValue({ ok: true, slug: "Page" });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.state).toBe("main"));
    await waitFor(() => expect(result.current.saveMode).toBe("standalone"));
    expect(result.current.standaloneFolder).toBe("Mine");
    // The app's absence is a mode, not an error banner.
    expect(result.current.nativeStatusError).toBeNull();

    // A page without a detected type defaults to a screenshot clip; this
    // test saves the link itself.
    act(() => {
      result.current.setCurrentType("link");
    });

    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.save();
    });

    expect(outcome).toEqual({ ok: true });
    expect(standalone.standaloneSave).toHaveBeenCalledTimes(1);
    const payload = standalone.standaloneSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.action).toBe("save_block");
    expect(payload.url).toBe("https://example.com");
    // Nothing besides the status probe may touch the dead host.
    const nativeActions = sendToNative.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(nativeActions.every((action) => action === "get_status")).toBe(true);
  });

  it("asks for a folder instead of erroring when nothing is configured", async () => {
    sendToNative.mockResolvedValue({ ok: false, error: "Native host not installed" });
    standalone.getStandaloneStatus.mockResolvedValue({ configured: false });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.saveMode).toBe("unconfigured"));
    expect(result.current.nativeStatusError).toContain("Native host");

    standalone.chooseStandaloneFolder.mockResolvedValue({
      configured: true,
      folderName: "Clips",
      permission: "granted",
    });
    standalone.standaloneListChannels.mockResolvedValue({ ok: true, channels: [] });

    await act(async () => {
      await result.current.chooseFolder();
    });

    expect(result.current.saveMode).toBe("standalone");
    expect(result.current.standaloneFolder).toBe("Clips");
    expect(result.current.nativeStatusError).toBeNull();
  });

  it("keeps the native road untouched when the host answers", async () => {
    sendToNative.mockImplementation(async (payload: { action: string }) => {
      if (payload.action === "get_status") return { ok: true, features: [] };
      if (payload.action === "list_known_vaults") {
        return { ok: true, vaults: ["/v"], current: "/v" };
      }
      if (payload.action === "list_channels") return { ok: true, channels: [] };
      return { ok: true };
    });

    const { result } = renderHook(() => useClipperState());
    await waitFor(() => expect(result.current.state).toBe("main"));

    expect(result.current.saveMode).toBe("app");
    expect(standalone.standaloneSave).not.toHaveBeenCalled();
  });
});
