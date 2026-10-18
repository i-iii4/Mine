import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/",
      "build/",
      "node_modules/",
      "src-tauri/",
      // Clipper build output: the popup bundle and the save core glue.
      "extension/dist/",
      "extension/generated/",
      // Vendored Defuddle release, one minified third-party UMD bundle.
      "extension/lib/defuddle.js",
      "safari-extension/",
      "scripts/",
      "target/",
      "output/playwright/",
      // Any sibling cargo target dir: diagnostic or profiling builds land
      // beside target/ and are full of generated bundles, not source.
      "target-*/",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
      // A card's proportion is measured or it is unknown; there is no third
      // option, and a number written here invents one. Every regression in this
      // area so far has been a plausible-looking literal in exactly this
      // position: `?? 1` states a square nobody measured, `?? (16 / 9)` states
      // a shape that disagreed with the height the layout had already reserved.
      //
      // Falling back to the shared PROVISIONAL_MEDIA_ASPECT is allowed and is
      // the point: it is one named value, read by both the reserving and the
      // painting side, so the two cannot drift apart.
      // See SPEC_CARD_MEDIA_GEOMETRY.md.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "LogicalExpression[operator='??'][left.property.name=/^(primaryAspectRatio|aspectRatio)$/][right.type='Literal']",
          message:
            "Do not substitute a number for an unmeasured aspect ratio. Use PROVISIONAL_MEDIA_ASPECT, or handle null as its own state.",
        },
        {
          selector:
            "LogicalExpression[operator='??'][left.property.name=/^(primaryAspectRatio|aspectRatio)$/][right.type='BinaryExpression']",
          message:
            "Do not substitute a computed ratio for an unmeasured aspect ratio. Use PROVISIONAL_MEDIA_ASPECT so the reserved height and the painted shape read one value.",
        },
      ],
    },
  },
  {
    // The clipper's service worker and content scripts are classic scripts.
    // tsc checks every name they use against the declarations of the browser,
    // the chrome.* API and the clipper's own globals (tsconfig.extension.json,
    // checkJs); no-undef knows none of them and would only repeat that check
    // badly, as typescript-eslint advises for type-checked code.
    files: ["extension/**/*.js"],
    languageOptions: { sourceType: "script" },
    rules: { "no-undef": "off" },
  },
  {
    // Tab pages and tab bars are child pages of a window (SPEC_TABS.md, В22).
    // A global `listen` hears events meant for other tabs, and the window
    // handles go stale once a tab moves into another window: the window label
    // is written into the page once, when it is created. Pages subscribe
    // through `listenPage` (src/lib/pageEvents.ts) and ask the backend for
    // window actions. The settings window is an ordinary window and keeps
    // them; tests mock these modules.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/settings/**", "src/test/**", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tauri-apps/api/event",
              importNames: ["listen", "once"],
              message: "Subscribe through listenPage from @/lib/pageEvents: a page hears only its own events (SPEC_TABS.md, В22).",
            },
            {
              name: "@tauri-apps/api/window",
              importNames: ["getCurrentWindow"],
              message: "A tab page names a stale window after it moves. Ask the backend: startWindowDrag, reportWindowSurface (SPEC_TABS.md, В22, В23).",
            },
            {
              name: "@tauri-apps/api/webviewWindow",
              importNames: ["getCurrentWebviewWindow"],
              message: "A tab is a child page of its window. Use getCurrentWebview from @tauri-apps/api/webview (SPEC_TABS.md, В22).",
            },
          ],
        },
      ],
    },
  },
  {
    // The reading pipeline is shared: the open card draws an article with it
    // and a future editor would draw the same article (SPEC_READING_MODE.md,
    // Ч13). It knows neither React, nor Tauri, nor the app's components; the
    // elements that draw it live in src/components/reading. This block
    // replaces the one above for these files, and forbids all it forbids.
    files: ["src/lib/reading/**/*.ts"],
    ignores: ["src/lib/reading/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "src/lib/reading stays free of React; elements go in src/components/reading (SPEC_READING_MODE.md, Ч13)." },
          ],
          patterns: [
            { group: ["react/*", "react-dom", "react-dom/*"], message: "src/lib/reading stays free of React (SPEC_READING_MODE.md, Ч13)." },
            { group: ["@tauri-apps/*"], message: "src/lib/reading stays free of Tauri; the host asks the backend (SPEC_READING_MODE.md, Ч13)." },
            { group: ["@/components", "@/components/*"], message: "src/lib/reading knows no component of the app (SPEC_READING_MODE.md, Ч13)." },
          ],
        },
      ],
    },
  },
  {
    // The editor's modules keep the reading pipeline's boundary
    // (SPEC_EDITING.md, Л0.5): syntax, presentation, line endings, the write
    // queue and the reload difference know neither React, nor Tauri, nor the
    // app's components; the editor's elements live in src/components/editing.
    // This block replaces the tab pages' one for these files, and forbids
    // all it forbids.
    files: ["src/lib/editing/**/*.ts"],
    ignores: ["src/lib/editing/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: "src/lib/editing stays free of React; elements go in src/components/editing (SPEC_EDITING.md, Л0.5)." },
          ],
          patterns: [
            { group: ["react/*", "react-dom", "react-dom/*"], message: "src/lib/editing stays free of React (SPEC_EDITING.md, Л0.5)." },
            { group: ["@tauri-apps/*"], message: "src/lib/editing stays free of Tauri; the host asks the backend (SPEC_EDITING.md, Л0.5)." },
            { group: ["@/components", "@/components/*"], message: "src/lib/editing knows no component of the app (SPEC_EDITING.md, Л0.5)." },
          ],
        },
      ],
    },
  },
);
