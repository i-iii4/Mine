import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Overlay bundle: the in-page clipper UI injected via
// chrome.scripting.executeScript. Built as a single-file IIFE so it
// runs directly when injected — no module loader, no dynamic imports.
//
// CSS is NOT bundled here. The overlay fetches dist/assets/popup.css at
// runtime (produced by vite.extension.config.ts) and injects it into
// its Shadow DOM. This avoids running two Tailwind pipelines with
// potentially different scan results — the window and the overlay now
// share exactly the same stylesheet.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  build: {
    outDir: path.resolve(__dirname, "extension/dist"),
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "extension/popup/overlay-entry.tsx"),
      formats: ["iife"],
      name: "MineClipperOverlay",
      fileName: () => "overlay.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
  },
});
