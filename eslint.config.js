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
      "extension/",
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
);
