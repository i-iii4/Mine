// A decoded preview names the media it came from when the request named its
// state, so the backend writes it only while the card still takes its
// preview from that file, unchanged (SPEC_DEEP_AUDIT.md, Е2.20;
// SPEC_THUMBNAILS.md).
import { invoke } from "@tauri-apps/api/core";
import { renderHook, waitFor } from "@testing-library/react";
import type { ThumbUpgradeInput } from "@/lib/thumbUpgradePlan";
import { useThumbnailUpgrade } from "./useThumbnailUpgrade";

const DECODED = new Uint8Array([1, 2, 3]);

// The worker decodes in the browser; here it answers every request with the
// same bytes.
vi.mock("@/workers/thumbWorker?worker", () => ({
  default: class FakeThumbWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    postMessage(request: { id?: string; slug?: string; type?: string }) {
      if (request.type === "cancel" || request.id === undefined) return;
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, slug: request.slug, ok: true, bytes: DECODED.buffer } }));
    }
    terminate() {}
  },
}));

function backlog(requests: ThumbUpgradeInput[]) {
  vi.mocked(invoke).mockImplementation(async (command: string) =>
    (command === "list_pending_thumb_upgrades" ? requests : null) as never);
}

function savedThumbHeaders(): Record<string, Record<string, string>> {
  const saved: Record<string, Record<string, string>> = {};
  for (const [command, , options] of vi.mocked(invoke).mock.calls) {
    if (command !== "save_thumb") continue;
    const headers = (options as { headers: Record<string, string> }).headers;
    saved[decodeURIComponent(headers["x-slug"]!)] = headers;
  }
  return saved;
}

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
});

describe("useThumbnailUpgrade", () => {
  it("names the decoded media and its state when the request named them, and nothing otherwise", async () => {
    backlog([
      { slug: "named", mediaPath: "/space/Media/named.jpg", kind: "image", revision: "r-41" },
      { slug: "older", mediaPath: "/space/Media/older.jpg", kind: "image" },
    ]);

    const { unmount } = renderHook(() => useThumbnailUpgrade(true));

    await waitFor(() => expect(Object.keys(savedThumbHeaders()).sort()).toEqual(["named", "older"]));
    const saved = savedThumbHeaders();
    expect(saved.named).toEqual({
      "x-slug": "named",
      "x-media-path": encodeURIComponent("/space/Media/named.jpg"),
      "x-media-revision": "r-41",
    });
    expect(saved.older).toEqual({ "x-slug": "older" });
    const bytes = vi.mocked(invoke).mock.calls.find(([command]) => command === "save_thumb")![1];
    expect(bytes).toEqual(DECODED);
    unmount();
  });

  it("asks for nothing while it is off", async () => {
    backlog([{ slug: "named", mediaPath: "/space/Media/named.jpg", kind: "image", revision: "r-41" }]);

    const { unmount } = renderHook(() => useThumbnailUpgrade(false));
    await Promise.resolve();

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    unmount();
  });
});
