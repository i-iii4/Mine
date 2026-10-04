import { act, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown;

// The entry listens for runtime messages as soon as it loads.
const { runtimeListeners } = vi.hoisted(() => {
  const runtimeListeners: RuntimeListener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://mine/${path}`,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (listener: RuntimeListener) => { runtimeListeners.push(listener); } },
    },
  };
  return { runtimeListeners };
});

vi.mock("./OverlayShell", () => ({
  OverlayShell: function OverlayShellStub({ edits }: { edits: { changed: boolean } }) {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => ref.current?.focus(), []);
    return (
      <div data-mine-clipper-panel="" tabIndex={-1}>
        <button ref={ref} type="button">Inside the clipper</button>
        {/* What the editor does on any edit: title, collections, type. */}
        <button type="button" onClick={() => { edits.changed = true; }}>Make an edit</button>
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

  // Escape and the close after Save close through closeClipperOverlay.
  describe("when a second open replaces the editor (SPEC_AUDIT_FIXES.md, Д1.3)", () => {
    it("returns focus to the page field the first editor took it from", async () => {
      await open();
      const host = await open();
      expect(document.querySelectorAll("[data-mine-clipper-overlay]")).toHaveLength(1);
      expect(document.activeElement).toBe(host);

      act(() => closeClipperOverlay());

      expect(document.activeElement).toBe(pageField);
    });

    it("returns focus to the page field the first editor took it from after a hide lost the keyboard", async () => {
      const first = await open();
      hideClipperOverlay();
      (first.shadowRoot!.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);

      const host = await open();
      expect(document.activeElement).toBe(host);
      act(() => closeClipperOverlay());

      expect(document.activeElement).toBe(pageField);
    });

    it("returns focus to the page field that had it when the second open came", async () => {
      await open();
      const elsewhere = document.createElement("input");
      document.body.appendChild(elsewhere);
      elsewhere.focus();

      const host = await open();
      expect(document.activeElement).toBe(host);
      act(() => closeClipperOverlay());

      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });
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

describe("a pending extension update sees a clipper that is still mounting (SPEC_AUDIT_FIXES.md, В4.6)", () => {
  /// What the tab answers background before it reloads the extension.
  function answersOpen(): boolean {
    let answer: unknown;
    for (const listener of runtimeListeners) {
      listener({ action: "mineClipperIsOpen" }, {}, (response) => { answer = response; });
    }
    return (answer as { open?: unknown } | undefined)?.open === true;
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
  });

  afterEach(() => {
    act(() => closeClipperOverlay());
    vi.unstubAllGlobals();
  });

  it("answers open from the start of the mount, and closed once the clipper closes", async () => {
    expect(answersOpen()).toBe(false);
    let opening: Promise<void> = Promise.resolve();
    act(() => { opening = showClipperOverlay(); });
    expect(document.querySelector("[data-mine-clipper-overlay]")).toBeNull();
    expect(answersOpen()).toBe(true);

    await act(async () => { await opening; });
    expect(answersOpen()).toBe(true);
    act(() => closeClipperOverlay());
    expect(answersOpen()).toBe(false);
  });

  it("answers open when a clipper opened again closes the previous one to mount anew", async () => {
    await act(async () => { await showClipperOverlay(); });
    const answeredOnClose: boolean[] = [];
    const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (message: { action?: string }) => Promise<void> } } }).chrome.runtime;
    const send = runtime.sendMessage;
    // Background asks every tab the moment the previous overlay reports closed.
    runtime.sendMessage = (message) => {
      if (message.action === "mineClipperClosed") answeredOnClose.push(answersOpen());
      return Promise.resolve();
    };
    try {
      await act(async () => { await showClipperOverlay(); });
    } finally {
      runtime.sendMessage = send;
    }
    expect(answeredOnClose).toEqual([true]);
  });
});

describe("one editor per tab (SPEC_AUDIT_FIXES.md, Г3.1)", () => {
  const editors = () => document.querySelectorAll("[data-mine-clipper-overlay]");
  /// What background asks the tab, the way it asks: through every listener.
  function ask(action: string): unknown {
    let answer: unknown;
    for (const listener of runtimeListeners) {
      listener({ action }, {}, (response) => { answer = response; });
    }
    return answer;
  }
  /// The close button, Escape and Save close through the page's overlay API.
  const closeButton = () => (globalThis as unknown as { __mineOverlay: { close: () => void } }).__mineOverlay.close();

  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
  });

  afterEach(() => {
    act(() => closeClipperOverlay());
    vi.unstubAllGlobals();
  });

  it("mounts one editor for two opens that arrive before the first mount finishes, and its close leaves none", async () => {
    await act(async () => {
      ask("showClipperOverlay");
      ask("showClipperOverlay");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editors()).toHaveLength(1);

    act(() => closeButton());
    expect(editors()).toHaveLength(0);
    expect(ask("mineClipperIsOpen")).toEqual({ open: false });
  });

  it("does not show an editor whose mount a close overtook", async () => {
    await act(async () => {
      ask("showClipperOverlay");
      expect(ask("mineClipperIsOpen")).toEqual({ open: true });
      closeButton();
      expect(ask("mineClipperIsOpen")).toEqual({ open: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editors()).toHaveLength(0);
    expect(ask("mineClipperIsOpen")).toEqual({ open: false });
  });

  it("opens the editor anew once the previous one finished mounting", async () => {
    await act(async () => { await showClipperOverlay(); });
    const first = editors()[0];
    await act(async () => { await showClipperOverlay(); });
    expect(editors()).toHaveLength(1);
    expect(editors()[0]).not.toBe(first);
  });
});

describe("a clip with edits is not lost to a stray click or a repeated launch (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч10, Ч11)", () => {
  let pageField: HTMLInputElement;

  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve({ text: () => Promise.resolve("") }));
    pageField = document.createElement("input");
    document.body.appendChild(pageField);
  });

  afterEach(() => {
    closeClipperOverlay();
    pageField.remove();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  /// Open the clipper and wait for its click-outside listener.
  async function open(freshMaterial?: boolean): Promise<HTMLElement> {
    await act(async () => {
      await showClipperOverlay(freshMaterial);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return document.querySelector<HTMLElement>("[data-mine-clipper-overlay]")!;
  }

  function edit(host: HTMLElement) {
    act(() => {
      [...host.shadowRoot!.querySelectorAll("button")].find((button) => button.textContent === "Make an edit")!.click();
    });
  }

  function clickPage() {
    act(() => {
      pageField.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 600, clientY: 600 }));
    });
  }

  it("closes on a click outside while the clip has no edits (Т7)", async () => {
    await open();
    clickPage();
    expect(document.querySelector("[data-mine-clipper-overlay]")).toBeNull();
  });

  it("stays open on a click outside once the clip has an edit (Т7)", async () => {
    const host = await open();
    edit(host);
    clickPage();
    expect(document.querySelector("[data-mine-clipper-overlay]")).toBe(host);
  });

  it("keeps the clip with edits on a repeated launch without new material and gives it the keyboard (Т8)", async () => {
    const host = await open();
    edit(host);
    pageField.focus();
    const again = await open(false);
    expect(again).toBe(host);
    expect(document.querySelectorAll("[data-mine-clipper-overlay]")).toHaveLength(1);
    expect(document.activeElement).toBe(host);
  });

  it("starts a new clip for a launch with new material (Т8)", async () => {
    const host = await open();
    edit(host);
    const fresh = await open(true);
    expect(fresh).not.toBe(host);
    expect(document.querySelectorAll("[data-mine-clipper-overlay]")).toHaveLength(1);
  });

  it("starts a new clip on a repeated launch when the clip has no edits", async () => {
    const host = await open();
    const fresh = await open(false);
    expect(fresh).not.toBe(host);
  });

  it("starts a new clip when the page shows another address since", async () => {
    const host = await open();
    edit(host);
    window.history.pushState({}, "", "/another-post");
    const fresh = await open(false);
    expect(fresh).not.toBe(host);
  });

  it("reads new material from the launch message; a message without it starts a new clip", async () => {
    const host = await open();
    edit(host);
    await act(async () => { runtimeListeners.forEach((listener) => listener({ action: "showClipperOverlay", freshMaterial: false }, {}, () => undefined)); });
    expect(document.querySelector("[data-mine-clipper-overlay]")).toBe(host);
    await act(async () => {
      runtimeListeners.forEach((listener) => listener({ action: "showClipperOverlay" }, {}, () => undefined));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("[data-mine-clipper-overlay]")).not.toBe(host);
  });

  it("closes a clip with edits when the person closes it, and the next opening is a new clip (Т9)", async () => {
    const host = await open();
    edit(host);
    act(() => closeClipperOverlay());
    expect(document.querySelector("[data-mine-clipper-overlay]")).toBeNull();
    const reopened = await open(false);
    expect(reopened).not.toBe(host);
  });
});
