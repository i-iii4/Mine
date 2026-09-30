// Escape during a crop from the overlay clipper, through the actual overlay
// entry, clipper panel and content-script crop in one page: Escape cancels the
// crop only, and the clipper comes back with its state instead of closing and
// mounting again from the saved draft (SPEC_AUDIT_FIXES.md, Ф6, В4.3).
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://mine/${path}`,
      sendMessage: (_message: unknown, callback?: (response: unknown) => void) => {
        callback?.(undefined);
        return Promise.resolve();
      },
      onMessage: { addListener: () => undefined },
    },
  };
});

const { state } = vi.hoisted(() => ({ state: {
  state: "main", saveMode: "app", currentType: "screenshot", articleExtractionState: "idle",
  metadata: { url: "https://a.example/story", title: "Story", selection: "", detectedType: "link", image: null },
  articleData: null, screenshotDataUrl: "data:image/jpeg;base64,AQID", capturing: false, captureError: null,
  cropSupported: true, startCropMode: () => undefined, retakeScreenshot: () => undefined,
  channels: [], selectedTags: [], saving: false, savePinned: false, canSave: true, draftReady: true,
  nativeStatusError: null, reconnecting: false, connectionChecking: false, retryConnection: () => undefined,
  draftError: null, draftLoading: false, channelsLoading: false, channelsError: null, retryChannels: () => undefined,
  save: () => Promise.resolve(undefined), setCurrentType: () => undefined, toggleTag: () => undefined, createChannel: () => undefined,
} }));
vi.mock("./hooks/useClipperState", () => ({ useClipperState: () => state }));

import { closeClipperOverlay, showClipperOverlay } from "./overlay-entry";

const contentScript = readFileSync("extension/content.js", "utf8");
const youtubeScript = readFileSync("extension/lib/youtubeSource.js", "utf8");

interface PageWindow {
  __mineOverlay: { hide: () => void };
  __mineCrop: { start: (documentUrl: string | null) => void };
}

describe("Escape during a crop from the overlay clipper (В4.3)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
    // The content script runs in the same page as the overlay entry.
    runInNewContext(`${youtubeScript}\n${contentScript}`, {
      window, document, URL, console, setTimeout, clearTimeout, Node, CustomEvent, fetch,
      chrome: (globalThis as unknown as { chrome: unknown }).chrome,
    });
  });

  afterEach(() => {
    act(() => closeClipperOverlay());
    vi.unstubAllGlobals();
  });

  function escape(): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(event); });
    return event;
  }

  it("cancels only the crop; the clipper comes back as it was", async () => {
    await act(async () => { await showClipperOverlay(); });
    const host = document.querySelector<HTMLElement>("[data-mine-clipper-overlay]")!;
    const panel = host.shadowRoot!.querySelector("[data-mine-clipper-panel]");
    expect(panel).not.toBeNull();

    // What Crop Area does in the overlay (useClipperState.startCropMode).
    const page = window as unknown as PageWindow;
    act(() => {
      page.__mineOverlay.hide();
      page.__mineCrop.start(window.location.href);
    });
    expect(host.style.display).toBe("none");
    const cropLayer = document.body.lastElementChild;
    expect(cropLayer).not.toBe(host);

    expect(escape().defaultPrevented).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(cropLayer?.isConnected).toBe(false);
    expect(document.querySelectorAll("[data-mine-clipper-overlay]")).toHaveLength(1);
    expect(document.querySelector("[data-mine-clipper-overlay]")).toBe(host);
    expect(host.style.display).toBe("");
    expect(host.shadowRoot!.querySelector("[data-mine-clipper-panel]")).toBe(panel);
  });
});
