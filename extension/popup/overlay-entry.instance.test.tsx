// The overlay script injected into a tab that already runs it: one instance
// answers background, so a later open never mounts two editors. A script left
// behind by a reloaded extension cannot answer anymore and does not keep the
// new one out (SPEC_AUDIT_FIXES.md, Г3.1).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

// The extension runtime of one extension instance and the listeners its
// scripts registered on it. The page starts with one, before the entry loads.
const { extensionRuntime, first } = vi.hoisted(() => {
  function extensionRuntime() {
    const listeners: RuntimeListener[] = [];
    const runtime = {
      id: "mine" as string | undefined,
      getURL: (path: string) => `chrome-extension://mine/${path}`,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (listener: RuntimeListener) => { listeners.push(listener); } },
    };
    return { runtime, listeners };
  }
  const first = extensionRuntime();
  (globalThis as unknown as { chrome: unknown }).chrome = { runtime: first.runtime };
  return { extensionRuntime, first };
});

vi.mock("./OverlayShell", () => ({
  OverlayShell: () => <div data-mine-clipper-panel="" tabIndex={-1} />,
}));

import { closeClipperOverlay } from "./overlay-entry";

const overlayApi = () => (globalThis as unknown as { __mineOverlay: unknown }).__mineOverlay;
const editors = () => document.querySelectorAll("[data-mine-clipper-overlay]");

/// Run the bundle again in the same page, as a second injection does.
async function injectAgain(): Promise<void> {
  vi.resetModules();
  await import("./overlay-entry");
}

function show(listeners: RuntimeListener[]): void {
  for (const listener of listeners) listener({ action: "showClipperOverlay" }, {}, () => undefined);
}

describe("the overlay script runs once per page (SPEC_AUDIT_FIXES.md, Г3.1)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
  });

  afterEach(() => {
    act(() => closeClipperOverlay());
    for (const host of editors()) host.remove();
    vi.unstubAllGlobals();
  });

  it("injected again, it adds no second listener and keeps the page's overlay API; an open mounts one editor", async () => {
    const api = overlayApi();
    expect(first.listeners).toHaveLength(1);

    await injectAgain();

    expect(first.listeners).toHaveLength(1);
    expect(overlayApi()).toBe(api);
    await act(async () => {
      show(first.listeners);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editors()).toHaveLength(1);
  });

  it("takes over from a script whose extension was reloaded since", async () => {
    const api = overlayApi();
    const reloaded = extensionRuntime();
    // The old script stays in the page, cut off from its extension.
    first.runtime.id = undefined;
    vi.stubGlobal("chrome", { runtime: reloaded.runtime });

    await injectAgain();

    expect(reloaded.listeners).toHaveLength(1);
    expect(overlayApi()).not.toBe(api);
    await act(async () => {
      show(reloaded.listeners);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editors()).toHaveLength(1);
  });
});
