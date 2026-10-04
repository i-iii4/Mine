// A crop belongs to the editor that started it. In the overlay the crop runs
// on the page and reports back with an in-page event that every editor of the
// tab hears; only the editor whose crop it is takes the frame, and an editor
// that closes cancels its crop (SPEC_AUDIT_FIXES.md, Ф6, Г3.3).
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The overlay runs in the page's content-script world: no chrome.tabs.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: () => undefined,
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
      lastError: undefined,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    },
  };
});

vi.mock("../lib/messaging", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/messaging")>(),
  sendToNative: async () => ({ ok: false, error: "No helper" }),
  getClipperLaunch: async () => null,
  extractMetadata: async () => ({
    url: window.location.href, documentUrl: window.location.href, title: "Page", description: "", image: null,
    author: null, ogType: null, favicon: null, selection: "", detectedType: "image",
    imageToSave: "https://example.com/photo.jpg", isArticle: false,
  }),
}));
vi.mock("../lib/standalone", () => ({
  getStandaloneStatus: async () => ({ configured: true, folderName: "Mine", permission: "granted", bindingId: "browser-folder" }),
  standaloneListChannels: async () => ({ ok: true, channels: [] }),
  standaloneCreateChannel: async () => ({ ok: true }),
  chooseStandaloneFolder: async () => ({ configured: false }),
  regrantStandaloneAccess: async () => ({ configured: false }),
  openStandaloneSetup: async () => ({ ok: true }),
  canPickFolderHere: () => false,
}));
vi.mock("../lib/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/protocol")>(),
  negotiateWidgetProtocol: async () => undefined,
}));

import { useClipperState } from "./useClipperState";

const frameA = "data:image/jpeg;base64,AQID";
const frameOther = "data:image/jpeg;base64,BAUG";

interface CropApi {
  start: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

describe("a crop belongs to the editor that started it (SPEC_AUDIT_FIXES.md, Г3.3)", () => {
  let crop: CropApi;

  beforeEach(() => {
    crop = { start: vi.fn(), cancel: vi.fn() };
    const page = globalThis as unknown as { __mineCrop: CropApi; __mineOverlay: { hide: () => void; show: () => void } };
    page.__mineCrop = crop;
    page.__mineOverlay = { hide: vi.fn(), show: vi.fn() };
  });

  afterEach(() => {
    const page = globalThis as unknown as Record<string, unknown>;
    delete page.__mineCrop;
    delete page.__mineOverlay;
  });

  async function openEditor() {
    const editor = renderHook(() => useClipperState());
    await waitFor(() => expect(editor.result.current.cropSupported).toBe(true));
    await waitFor(() => expect(editor.result.current.state).toBe("main"));
    return editor;
  }

  /// What content.js dispatches in the page when a crop ends.
  function cropEnds(detail: Record<string, unknown>) {
    act(() => { window.dispatchEvent(new CustomEvent("mine-crop-result", { detail })); });
  }

  async function startCrop(editor: Awaited<ReturnType<typeof openEditor>>): Promise<string> {
    await act(async () => { await editor.result.current.startCropMode(); });
    const call = crop.start.mock.calls.at(-1);
    expect(call?.[0]).toBe(window.location.href);
    expect(typeof call?.[1]).toBe("string");
    return call?.[1] as string;
  }

  it("a second editor ignores the first editor's crop; the first takes it", async () => {
    const first = await openEditor();
    const cropId = await startCrop(first);
    const second = await openEditor();

    cropEnds({ cropId, dataUrl: frameA, screenshotId: "crop-a" });

    expect(second.result.current.screenshotDataUrl).toBeNull();
    expect(first.result.current.screenshotDataUrl).toBe(frameA);
  });

  it("ignores a result of another crop or of none, and takes its own once", async () => {
    const editor = await openEditor();
    const cropId = await startCrop(editor);

    cropEnds({ cropId: "another editor's crop", dataUrl: frameOther, screenshotId: "crop-x" });
    cropEnds({ dataUrl: frameOther, screenshotId: "crop-y" });
    cropEnds({ cropId: "another editor's crop", error: "This tab shows another page than the one Mine opened for." });
    expect(editor.result.current.screenshotDataUrl).toBeNull();
    expect(editor.result.current.captureError).toBeNull();

    cropEnds({ cropId, dataUrl: frameA, screenshotId: "crop-a" });
    expect(editor.result.current.screenshotDataUrl).toBe(frameA);
    cropEnds({ cropId, dataUrl: frameOther, screenshotId: "crop-again" });
    expect(editor.result.current.screenshotDataUrl).toBe(frameA);
  });

  it("cancels its crop when it closes, so the editor opened next never receives it", async () => {
    const first = await openEditor();
    const cropId = await startCrop(first);

    // A new opening closes the hidden editor and mounts another.
    first.unmount();
    expect(crop.cancel).toHaveBeenCalledWith(cropId);
    const second = await openEditor();
    cropEnds({ cropId, dataUrl: frameA, screenshotId: "crop-a" });
    expect(second.result.current.screenshotDataUrl).toBeNull();
  });
});
