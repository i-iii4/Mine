import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

function coldSpaceAuditPlugin(): Plugin {
  const payloadPath = process.env.MINE_COLD_SPACE_SNAPSHOT_PATH;
  const assetRoot = process.env.MINE_COLD_SPACE_ASSET_ROOT;
  return {
    name: "mine-cold-space-audit-data",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/__cold-space-snapshot") {
          if (!payloadPath) {
            response.statusCode = 404;
            response.end("cold-space payload is not configured");
            return;
          }
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(fs.readFileSync(payloadPath));
          return;
        }
        if (url.pathname !== "/__cold-space-asset") {
          next();
          return;
        }
        const requested = url.searchParams.get("path");
        if (!assetRoot || !requested) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const allowed = path.resolve(assetRoot);
        const resolved = path.resolve(requested);
        if (resolved !== allowed && !resolved.startsWith(`${allowed}${path.sep}`)) {
          response.statusCode = 403;
          response.end();
          return;
        }
        try {
          const extension = path.extname(resolved).toLowerCase();
          const contentType = extension === ".png"
            ? "image/png"
            : extension === ".webp"
              ? "image/webp"
              : "image/jpeg";
          response.setHeader("Content-Type", contentType);
          response.end(fs.readFileSync(resolved));
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), coldSpaceAuditPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      // Two webviews, two HTML entries: the main window and the settings window.
      input: {
        main: path.resolve(__dirname, "index.html"),
        settings: path.resolve(__dirname, "settings.html"),
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "extension/**/*.test.{ts,tsx}",
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
