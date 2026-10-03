import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import config from "../../eslint.config.js";

// The rule that keeps tab pages and tab bars on their own events and off
// stale window handles (SPEC_TABS.md, В22), checked against the project's
// own ESLint configuration.

const PROJECT_ROOT = "/project";
const linter = new Linter({ cwd: PROJECT_ROOT });

function restrictedImports(code: string, file: string): string[] {
  return linter
    .verify(code, config, { filename: `${PROJECT_ROOT}/${file}` })
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

const FORBIDDEN = [
  "import { listen } from \"@tauri-apps/api/event\";\nvoid listen;\n",
  "import { once } from \"@tauri-apps/api/event\";\nvoid once;\n",
  "import { getCurrentWindow } from \"@tauri-apps/api/window\";\nvoid getCurrentWindow;\n",
  "import { getCurrentWebviewWindow } from \"@tauri-apps/api/webviewWindow\";\nvoid getCurrentWebviewWindow;\n",
  "import * as events from \"@tauri-apps/api/event\";\nvoid events;\n",
];

describe("the lint rule of tab pages (SPEC_TABS.md, В22)", () => {
  it.each(FORBIDDEN)("forbids in tab and tab bar code: %s", (code) => {
    expect(restrictedImports(code, "src/components/Example.tsx")).toHaveLength(1);
    expect(restrictedImports(code, "src/tabbar/Example.tsx")).toHaveLength(1);
  });

  it("allows the page's own subscription, events without a listener and type imports", () => {
    const code = [
      "import { getCurrentWebview } from \"@tauri-apps/api/webview\";",
      "import { emit, type UnlistenFn } from \"@tauri-apps/api/event\";",
      "export const stop: UnlistenFn | null = null;",
      "void getCurrentWebview; void emit;",
      "",
    ].join("\n");
    expect(restrictedImports(code, "src/components/Example.tsx")).toEqual([]);
  });

  it("leaves the settings window and tests their window handles", () => {
    const code = FORBIDDEN[0]!;
    expect(restrictedImports(code, "src/settings/Example.tsx")).toEqual([]);
    expect(restrictedImports(code, "src/components/Example.test.tsx")).toEqual([]);
  });
});
