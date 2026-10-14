// The Vite of one browser audit, started and stopped by the audit itself
// (SPEC_DEEP_AUDIT.md, Е7.10). It listens on a free loopback port, so a dev
// server the person runs keeps its own, and its dependency cache lives in a
// temporary folder: an audit's extra plugins change Vite's config hash, and a
// shared cache would be rebuilt under a running dev server.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const HOST = '127.0.0.1';
const root = fileURLToPath(new URL('..', import.meta.url));

/** How long an audit waits for its first rendered page. A fresh audit Vite
 *  transforms the app's modules and optimizes its dependencies on that first
 *  request, which on a busy machine outlasts Playwright's default 30 s. */
export const COLD_START_MS = 120_000;

/** A port nothing listens on now. Vite reads port 0 as its default port, so
 *  the audit asks the system for a free one first. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('The system gave no free port'));
      });
    });
  });
}

/** Starts Vite over the repository with `plugins` added. Resolves to the
 *  server's origin and `close`, which stops it and removes its cache. */
export async function startAuditVite(plugins = []) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'mine-audit-vite-'));
  const removeCache = () => rmSync(cacheDir, { recursive: true, force: true });
  let server;
  try {
    const port = await freePort();
    server = await createServer({
      root,
      cacheDir,
      plugins,
      clearScreen: false,
      logLevel: 'warn',
      server: { host: HOST, port, strictPort: true, hmr: false, open: false },
    });
    await server.listen();
    return {
      origin: `http://${HOST}:${port}`,
      async close() {
        try {
          await server.close();
        } finally {
          removeCache();
        }
      },
    };
  } catch (error) {
    await server?.close();
    removeCache();
    throw error;
  }
}
