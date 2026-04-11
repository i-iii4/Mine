import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Overlay bundle: the in-page clipper UI injected via
// chrome.scripting.executeScript. Built as a single-file IIFE so it
// runs directly when injected — no module loader, no dynamic imports.
//
// The CSS (global.css → popup-layout.css → Tailwind) is NOT emitted as
// a separate file. Vite's `build.cssCodeSplit: false` + the library
// mode settings below cause CSS to be included directly in the JS
// bundle, which the overlay entry then injects into a <style> element
// inside its Shadow DOM root.

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    emptyOutDir: false, // keep dist/index.html from the other build
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, "extension/popup/overlay-entry.tsx"),
      formats: ["iife"],
      name: "MineClipperOverlay",
      fileName: () => "overlay.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: "overlay-[name][extname]",
      },
    },
  },
  optimizeDeps: {
    exclude: ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
  },
});
