import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Build pipeline for the Chrome extension.
//
// Two entry points share the same React source:
//
//   1. "window"  — classic detached-window popup (dist/index.html).
//      Used as fallback on chrome:// and other service pages where
//      content scripts cannot run. Also the historical entry.
//
//   2. "overlay" — IIFE bundle injected into the active tab's content
//      script context via chrome.scripting.executeScript. Mounts the
//      same React <PopupApp /> inside a closed Shadow DOM so page styles
//      cannot leak in and our styles cannot leak out. Main path in
//      Chrome/DIA — avoids detached window UX (no title bar, no address
//      bar, no window chrome at all).
//
// The overlay bundle is produced as a single-file IIFE so content.js
// can inject it with executeScript({files: [...]}). No code splitting,
// no ES modules — content scripts don't support dynamic module imports.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  root: "extension/popup",
  publicDir: path.resolve(__dirname, "public"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "extension/dist"),
    emptyDirBeforeWrite: true,
    rollupOptions: {
      input: path.resolve(__dirname, "extension/popup/index.html"),
      output: {
        // Stable name for the CSS bundle so overlay-entry can fetch it
        // via chrome.runtime.getURL("dist/assets/popup.css"). The JS
        // bundle still gets a hash — only CSS is pinned.
        assetFileNames: (info) => {
          if (info.name?.endsWith(".css")) return "assets/popup.css";
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
  },
});
