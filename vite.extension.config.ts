import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  root: "extension/popup",
  // publicDir points to the main app's public/ so fonts resolve correctly
  publicDir: path.resolve(__dirname, "public"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "extension/dist"),
    emptyDirBeforeWrite: true,
    rollupOptions: {
      input: path.resolve(__dirname, "extension/popup/index.html"),
    },
  },
  // Exclude Tauri-specific modules from the bundle
  optimizeDeps: {
    exclude: ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
  },
});
