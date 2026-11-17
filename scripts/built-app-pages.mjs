// The app's pages as the app ships them, for the audits that act as a person
// does: `vite build` with the repository's own config, every HTML entry
// (a tab, the tab bar, the menu panel, the outside window, the settings
// window), served from a folder of the run on a free loopback port. A dev
// server gives React's development build, StrictMode's second render and
// its checks, which is not what the person runs (AUDIT_PERFORMANCE.md, Пр3).
//
// The backend is a stand-in the audit installs in each page
// (`scripts/app-backend-stand-in.mjs`); the asset protocol is the server's
// `/__asset?path=` address, which the audit answers (`respond`).
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HOST = "127.0.0.1";
const root = fileURLToPath(new URL("..", import.meta.url));
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".wasm": "application/wasm",
};

/** The page of each kind, by the address the audit opens. */
export const PAGES = {
  tab: "/",
  tabBar: "/tabbar.html",
  menuPanel: "/menu-panel.html",
  outsideWindow: "/outside-window.html",
  settings: "/settings.html",
};

/**
 * Builds the app for production into a folder of the run and serves it.
 * `respond(url, response)` answers the audit's own addresses (the asset
 * protocol) and returns true when it did. Resolves to the server's origin
 * and `close`, which stops the server and removes the folder.
 */
export async function serveBuiltApp({ name, respond = () => false }) {
  const folder = mkdtempSync(join(tmpdir(), `mine-${name}-`));
  try {
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "production",
      logLevel: "warn",
      build: { outDir: folder, emptyOutDir: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
    });
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (respond(url, response)) return;
    const file = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const path = normalize(join(folder, file));
    if (!path.startsWith(`${folder}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(response);
  });
  await new Promise((listening) => server.listen(0, HOST, listening));
  const origin = `http://${HOST}:${server.address().port}`;
  return {
    origin,
    close: async () => {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
