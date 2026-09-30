import { act, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The entry listens for runtime messages as soon as it loads.
vi.hoisted(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://mine/${path}`,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: () => undefined },
    },
  };
});

vi.mock("./OverlayShell", () => ({
  OverlayShell: function OverlayShellStub() {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => ref.current?.focus(), []);
    return (
      <div data-mine-clipper-panel="" tabIndex={-1}>
        <button ref={ref} type="button">Inside the clipper</button>
      </div>
    );
  },
}));

import { closeClipperOverlay, hideClipperOverlay, resumeClipperOverlay, showClipperOverlay } from "./overlay-entry";

describe("clipper overlay hands the keyboard back (А6.12)", () => {
  let pageField: HTMLInputElement;

  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
    pageField = document.createElement("input");
    document.body.appendChild(pageField);
    pageField.focus();
  });

  afterEach(() => {
    closeClipperOverlay();
    pageField.remove();
    vi.unstubAllGlobals();
  });

  async function open(): Promise<HTMLElement> {
    await act(async () => {
      await showClipperOverlay();
    });
    return document.querySelector<HTMLElement>("[data-mine-clipper-overlay]")!;
  }

  it("returns focus to what had it on the page when the clipper closes with the keyboard inside", async () => {
    const host = await open();
    expect(document.activeElement).toBe(host);

    act(() => closeClipperOverlay());

    expect(document.querySelector("[data-mine-clipper-overlay]")).toBeNull();
    expect(document.activeElement).toBe(pageField);
  });

  it("leaves focus alone when it already moved to the page", async () => {
    await open();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    act(() => closeClipperOverlay());

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("clipper overlay keeps the keyboard across a screenshot (Б4.9)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
  });

  afterEach(() => {
    closeClipperOverlay();
    vi.unstubAllGlobals();
  });

  async function openWithKeyboardInside(): Promise<{ host: HTMLElement; shadow: ShadowRoot; button: HTMLButtonElement }> {
    await act(async () => {
      await showClipperOverlay();
    });
    const host = document.querySelector<HTMLElement>("[data-mine-clipper-overlay]")!;
    const shadow = host.shadowRoot!;
    const button = shadow.querySelector("button")!;
    expect(shadow.activeElement).toBe(button);
    return { host, shadow, button };
  }

  // A hidden host loses the keyboard to the page in a browser; jsdom does not
  // apply display:none to focus, so the blur is made explicit.
  function hideAndLoseKeyboard(shadow: ShadowRoot) {
    hideClipperOverlay();
    (shadow.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
  }

  it("gives the keyboard back to the control that had it", async () => {
    const { host, shadow, button } = await openWithKeyboardInside();
    hideAndLoseKeyboard(shadow);
    // The page hides every Mine layer again right before the capture.
    hideClipperOverlay();

    await act(async () => {
      await resumeClipperOverlay();
    });

    expect(host.style.display).toBe("");
    expect(document.activeElement).toBe(host);
    expect(shadow.activeElement).toBe(button);
  });

  it("gives the keyboard to the panel when that control is gone", async () => {
    const { host, shadow, button } = await openWithKeyboardInside();
    hideAndLoseKeyboard(shadow);
    button.remove();

    await act(async () => {
      await resumeClipperOverlay();
    });

    expect(document.activeElement).toBe(host);
    expect(shadow.activeElement).toBe(shadow.querySelector("[data-mine-clipper-panel]"));
  });

  it("leaves the keyboard on the page when it was there before the hide", async () => {
    const { shadow } = await openWithKeyboardInside();
    const pageField = document.createElement("input");
    document.body.appendChild(pageField);
    pageField.focus();
    hideClipperOverlay();

    await act(async () => {
      await resumeClipperOverlay();
    });

    expect(document.activeElement).toBe(pageField);
    expect(shadow.activeElement).toBeNull();
    pageField.remove();
  });
});
