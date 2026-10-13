// Background learns whether the overlay opened from its answer: an overlay
// that could not open answers so, and background opens the clipper window
// instead (SPEC_DEEP_AUDIT.md, Е3.8, Е3.12; SPEC_CLIPPER.md, «Запуск
// клиппера»).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

const { runtimeListeners } = vi.hoisted(() => {
  const runtimeListeners: RuntimeListener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "mine",
      getURL: (path: string) => `chrome-extension://mine/${path}`,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (listener: RuntimeListener) => { runtimeListeners.push(listener); } },
    },
    storage: { local: { get: async () => ({}) } },
  };
  return { runtimeListeners };
});

vi.mock("./OverlayShell", () => ({
  OverlayShell: () => <div data-mine-clipper-panel="" tabIndex={-1} />,
}));

import { closeClipperOverlay } from "./overlay-entry";

const editors = () => document.querySelectorAll("[data-mine-clipper-overlay]");

/// Background's open, the way it asks: the answer and when it came.
function open(): { answer: Promise<unknown>; answered: () => boolean } {
  let settle: (value: unknown) => void = () => undefined;
  let answered = false;
  const answer = new Promise((resolve) => { settle = resolve; });
  for (const listener of runtimeListeners) {
    listener({ action: "showClipperOverlay", freshMaterial: true }, {}, (response) => { answered = true; settle(response); });
  }
  return { answer, answered: () => answered };
}

afterEach(() => {
  act(() => closeClipperOverlay());
  for (const host of editors()) host.remove();
  vi.unstubAllGlobals();
});

describe("the overlay answers an open once it knows the outcome", () => {
  it("refuses when its stylesheet cannot be read, and reads it again at the next open", async () => {
    // What Chromium does to a content script's request for a file the
    // extension does not offer the page: the request fails (checked on a
    // file:// page in Chromium 148 without a window, 13.10.2026).
    const fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetch);
    const refused = open();
    await act(async () => { await refused.answer; });
    expect(await refused.answer).toMatchObject({ ok: false });
    expect(editors()).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(":root{--x:1}") })));
    const opened = open();
    await act(async () => { await opened.answer; });
    expect(await opened.answer).toEqual({ ok: true });
    expect(editors()).toHaveLength(1);
  });

  it("answers only once the editor is on the page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve("") })));
    const opened = open();
    expect(opened.answered()).toBe(false);
    await act(async () => { await opened.answer; });
    expect(await opened.answer).toEqual({ ok: true });
    expect(editors()).toHaveLength(1);
  });

  it("refuses on a document without an HTML body, such as an SVG or XML page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve("") })));
    const body = document.body;
    body.remove();
    try {
      const refused = open();
      await act(async () => { await refused.answer; });
      expect(await refused.answer).toMatchObject({ ok: false });
      expect(editors()).toHaveLength(0);
    } finally {
      document.documentElement.appendChild(body);
    }
  });
});
