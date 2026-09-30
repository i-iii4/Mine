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
    return <button ref={ref} type="button">Inside the clipper</button>;
  },
}));

import { closeClipperOverlay, showClipperOverlay } from "./overlay-entry";

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
