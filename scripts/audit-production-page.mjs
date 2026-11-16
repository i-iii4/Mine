// The page of one browser audit, built for production and served by the
// audit itself (AUDIT_PERFORMANCE.md, Пр3). A dev server gives React's
// development build: its checks, StrictMode's second render of every
// component and its performance tracks, which is not what the app ships.
// A time measured on that build is the development build's, not the app's.
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  ".png": "image/png", ".wasm": "application/wasm",
};

/**
 * The source of a page's entry: one dev route alone, set up as the app's
 * entry sets the page up before it (src/main.tsx): the stored theme, motion
 * level, corners, spacing and fonts, StrictMode and the tooltip provider.
 * `assetAddress` stands in for the asset protocol: a function of a file path
 * that returns the address the page loads it from, or null for the
 * protocol's own address. It is written into the page as source, so it uses
 * nothing outside itself. `setup` is more source for the entry: what the
 * audit reads from the page's modules, which a production build does not
 * serve one by one.
 */
export function routeEntry({ module, name, assetAddress, setup = "" }) {
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import "/src/styles/global.css";
    import { TooltipProvider } from "/src/components/ui/tooltip.tsx";
    import { applyTheme, getStoredTheme } from "/src/lib/themeMode.ts";
    import { installMotionLevel } from "/src/lib/motion.ts";
    import { applyCardRadius, getStoredCardRadius } from "/src/lib/cardRadius.ts";
    import { applyDensity, getStoredDensity } from "/src/lib/density.ts";
    import { applyContentFont, applyInterfaceFont, getStoredContentFont, getStoredInterfaceFont } from "/src/lib/fontChoice.ts";
    import { ${name} } from ${JSON.stringify(module)};
    applyTheme(getStoredTheme());
    installMotionLevel();
    applyCardRadius(getStoredCardRadius());
    applyDensity(getStoredDensity());
    applyInterfaceFont(getStoredInterfaceFont());
    applyContentFont(getStoredContentFont());
    const assetAddress = ${String(assetAddress)};
    window.__TAURI_INTERNALS__ = { convertFileSrc: (filePath, protocol = "asset") => {
      const path = filePath.startsWith("//") ? filePath.slice(1) : filePath;
      return assetAddress(path) ?? protocol + "://localhost/" + encodeURIComponent(path);
    } };
    createRoot(document.getElementById("root")).render(
      React.createElement(React.StrictMode, null,
        React.createElement(TooltipProvider, null, React.createElement(${name}))));
    ${setup}`;
}

/**
 * Builds `entry` for production into a folder of the run and serves it at
 * `route` on a free loopback port. `respond(url, response)` answers the
 * audit's own data addresses and returns true when it did. Resolves to the
 * page's address, the server's origin and `close`, which stops the server
 * and removes the folder.
 */
export async function serveProductionPage({ name, route, entry, respond = () => false }) {
  const virtual = `virtual:${name}-entry`;
  const resolved = `\0${virtual}`;
  const entryPlugin = {
    name: `${name}-entry`,
    config(config) {
      config.build ??= {};
      config.build.rollupOptions = { ...(config.build.rollupOptions ?? {}), input: { page: virtual } };
    },
    resolveId(id) { return id === virtual ? resolved : undefined; },
    load(id) { return id === resolved ? entry : undefined; },
  };
  const folder = mkdtempSync(join(tmpdir(), `mine-${name}-`));
  try {
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "production",
      logLevel: "warn",
      plugins: [entryPlugin],
      build: { outDir: folder, emptyOutDir: true, manifest: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
    });
    const manifest = JSON.parse(readFileSync(join(folder, ".vite/manifest.json"), "utf8"));
    const chunk = Object.values(manifest).find((item) => item.isEntry);
    if (!chunk) throw new Error("The build has no entry");
    writeFileSync(join(folder, "page.html"), `<!doctype html><html><head><meta charset="utf-8">${(chunk.css ?? []).map((css) => `<link rel="stylesheet" href="/${css}">`).join("")}</head>`
      + `<body><div id="root"></div><script type="module" src="/${chunk.file}"></script></body></html>`);
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (respond(url, response)) return;
    const file = url.pathname === route ? "/page.html" : decodeURIComponent(url.pathname);
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
    url: `${origin}${route}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
