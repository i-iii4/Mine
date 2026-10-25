import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCRIPT = readFileSync("public/tab-first-frame.js", "utf8");

type TauriInternals = { invoke: (command: string) => Promise<unknown> };
type TabWindow = Window & { __TAURI_INTERNALS__?: TauriInternals };

/** Runs the script as the page's head does, before its own script. */
function runScript() {
  // The script is the page's own file, run in its place on this document.
  new Function(SCRIPT)();
}

/// A new tab waits unseen for its first frame (SPEC_TABS.md, В26). The page's
/// script reports that frame itself; when it does not run at all, the frame
/// after the document's load reports it instead.
describe("tab-first-frame.js", () => {
  const tabWindow = window as TabWindow;
  let invoke: ReturnType<typeof vi.fn<(command: string) => Promise<unknown>>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    invoke = vi.fn<(command: string) => Promise<unknown>>(() => Promise.resolve());
    tabWindow.__TAURI_INTERNALS__ = { invoke };
    delete document.documentElement.dataset.appStarted;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete tabWindow.__TAURI_INTERNALS__;
    delete document.documentElement.dataset.appStarted;
  });

  it("tells the backend two frames after the load when the page's script did not run", () => {
    runScript();
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersToNextFrame();
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(invoke).toHaveBeenCalledWith("tab_painted");
  });

  it("stands aside when the page's script runs and reports its own frame", () => {
    runScript();
    document.documentElement.dataset.appStarted = "";
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does nothing outside the app", () => {
    delete tabWindow.__TAURI_INTERNALS__;
    runScript();
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is loaded by the tab's page before its own script", () => {
    const html = readFileSync("index.html", "utf8");
    const first = html.indexOf('<script src="/tab-first-frame.js"></script>');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(html.indexOf('type="module"'));
  });
});
