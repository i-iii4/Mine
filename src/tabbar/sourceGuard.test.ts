import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIRECTORY = "src/tabbar";

/** Every source file of the bar page, tests aside. */
function barSources(): Array<{ file: string; text: string }> {
  return readdirSync(DIRECTORY)
    .filter((file: string) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .map((file: string) => ({ file, text: readFileSync(join(DIRECTORY, file), "utf8") }));
}

/// A tab bar is a child page of its window (SPEC_TABS.md, В22): the global
/// `listen` hears events meant for other pages, and the window's handle in a
/// child page names the window it was created in.
describe("tab bar page boundaries", () => {
  it("has sources to check", () => {
    expect(barSources().map(({ file }) => file)).toEqual(
      expect.arrayContaining(["main.tsx", "TabBar.tsx", "useTabBarState.ts"]),
    );
  });

  it("never subscribes through the global listen or reaches for the window", () => {
    for (const { file, text } of barSources()) {
      expect(text, file).not.toMatch(/from\s+["']@tauri-apps\/api\/event["']/);
      expect(text, file).not.toMatch(/from\s+["']@tauri-apps\/api\/window["']/);
      expect(text, file).not.toMatch(/from\s+["']@tauri-apps\/api\/webviewWindow["']/);
      expect(text, file).not.toMatch(/getCurrentWindow|getCurrentWebviewWindow/);
    }
  });

  it("subscribes through its own page", () => {
    const state = readFileSync(join(DIRECTORY, "useTabBarState.ts"), "utf8");
    expect(state).toContain("getCurrentWebview()");
    expect(state).toMatch(/\.listen<T>\(/);
  });

  it("drags the window with the chrome gesture, which asks the backend (В23)", () => {
    const bar = readFileSync(join(DIRECTORY, "TabBar.tsx"), "utf8");
    expect(bar).toContain("useChromeDragGesture()");
    expect(bar).not.toContain("startDragging");
    // The drag region of Tauri starts the drag through the window's handle.
    expect(bar).not.toContain("data-tauri-drag-region");
    const hook = readFileSync("src/hooks/useChromeDragGesture.ts", "utf8");
    expect(hook).toContain("startWindowDrag()");
    expect(hook).not.toMatch(/getCurrentWindow|getCurrentWebviewWindow/);
  });

  it("guards input against stray control characters from the first moment (В80)", () => {
    const main = readFileSync(join(DIRECTORY, "main.tsx"), "utf8");
    expect(main).toContain("installControlCharGuard();");
    expect(main.indexOf("installControlCharGuard();")).toBeLessThan(main.indexOf(".render("));
  });

  it("is a page of the multi-page build, like the settings window", () => {
    const config = readFileSync("vite.config.ts", "utf8");
    expect(config).toContain('tabbar: path.resolve(__dirname, "tabbar.html")');
    const html = readFileSync("tabbar.html", "utf8");
    expect(html).toContain('src="/src/tabbar/main.tsx"');
    // The first paint is the bar's surface, the bottom panel's accent, in
    // both themes, with the token's own values (В43).
    const css = readFileSync("src/styles/global.css", "utf8");
    for (const value of ["oklch(0.9694 0 0)", "oklch(0.2 0 0)"]) {
      expect(css).toContain(`--accent: ${value};`);
      expect(html).toContain(value);
    }
    expect(html).not.toMatch(/background:\s*#[0-9a-f]{3,8}/i);
  });
});
