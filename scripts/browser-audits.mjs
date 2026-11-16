#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a browser-audit port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForServer(url, child, readLogs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Vite exited before readiness.\n${readLogs()}`);
    }
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return;
    } catch {
      // The server has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready within ${STARTUP_TIMEOUT_MS} ms.\n${readLogs()}`);
}

function runAudit(script, env, onChildChange, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    onChildChange(child);
    child.once("error", (error) => {
      onChildChange(null);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      onChildChange(null);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${script} failed with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

async function stopProcess(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalTarget = process.platform === "win32" ? child.pid : -child.pid;
  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const exited = waitForExit(child);
  const timedOut = new Promise((resolve) => setTimeout(() => resolve(null), SHUTDOWN_TIMEOUT_MS));
  if (await Promise.race([exited, timedOut])) return;

  try {
    process.kill(signalTarget, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child);
}

async function main() {
  const coldSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mine-cold-space-browser-"));
  const coldSource = path.join(coldSpaceRoot, "source");
  const coldDerived = path.join(coldSpaceRoot, "derived");
  const coldPayload = path.join(coldSpaceRoot, "snapshot.json");
  fs.mkdirSync(coldSource);
  fs.mkdirSync(coldDerived);
  await runCommand("cargo", [
    "run",
    "-p",
    "mine",
    "--bin",
    "cold-space-audit",
    "--features",
    "tooling",
    "--locked",
    "--",
    coldSource,
    coldDerived,
    "2",
    "--fixture-count",
    "180",
    // A product space is cold in iCloud, not only on a local disk: one
    // picture of the fixture has its contents there, and indexing must
    // leave it there (SPEC_DEEP_AUDIT.md, Е7.8).
    "--icloud-media",
    "--browser-output",
    coldPayload,
  ]);
  const coldFirst = JSON.parse(fs.readFileSync(coldPayload, "utf8")).first.blocks;
  const inIcloud = coldFirst.filter((block) => block.media_file?.endsWith("cold-icloud-image.png"));
  if (inIcloud.length === 0 || inIcloud.some((block) => block.width != null || block.height != null)) {
    throw new Error(`The cold space has no card whose picture waits in iCloud: ${JSON.stringify(inIcloud)}`);
  }

  const port = await reserveFreePort();
  const origin = `http://${HOST}:${port}`;
  const logs = [];
  // The dev server of the audits that check behaviour, not time: the
  // sidebar reorder and the edge states.
  const server = spawn(
    "bun",
    ["run", "dev", "--", "--host", HOST, "--port", String(port), "--strictPort"],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const appendLog = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 100) logs.shift();
  };
  server.stdout.on("data", appendLog);
  server.stderr.on("data", appendLog);

  let activeAudit = null;
  let shuttingDown = false;
  const onAuditChildChange = (child) => {
    activeAudit = child;
  };
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    void Promise.all([stopProcess(activeAudit), stopProcess(server)]).finally(() => {
      fs.rmSync(coldSpaceRoot, { recursive: true, force: true });
      process.exit(exitCode);
    });
  };
  const interrupt = () => shutdown("SIGINT");
  const terminate = () => shutdown("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    await waitForServer(`${origin}/__sidebar-reorder-audit`, server, () => logs.join(""));
    // Builds its page for production and serves it itself: its frames are
    // the app's React, not the development build's.
    await runAudit("scripts/feed-scroll-audit.mjs", {}, onAuditChildChange);
    // WebKit, a recording of the page: pictures that are late while the feed
    // scrolls, which Chromium never shows.
    await runAudit("scripts/feed-images-audit.mjs", {}, onAuditChildChange);
    // Build their pages for production too: the graph's first paint, frames
    // and long tasks and the cold feed are the app's (AUDIT_PERFORMANCE.md, Пр3).
    await runAudit("scripts/graph-view-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/cold-space-browser-audit.mjs", {
      MINE_COLD_SPACE_SNAPSHOT_PATH: coldPayload,
      MINE_COLD_SPACE_ASSET_ROOT: fs.realpathSync(
        path.join(coldDerived, "cycle-1", "cache", "thumbs"),
      ),
    }, onAuditChildChange);
    await runAudit("scripts/sidebar-reorder-audit.mjs", {
      MINE_SIDEBAR_REORDER_AUDIT_URL: `${origin}/__sidebar-reorder-audit`,
    }, onAuditChildChange);
    await runAudit("scripts/edge-states-audit.mjs", {
      MINE_EDGE_STATES_AUDIT_URL: `${origin}/edge-states.html`,
    }, onAuditChildChange);
    // Start and stop a Vite of their own (audit-vite.mjs).
    await runAudit("scripts/selection-menu-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/sidebar-action-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/top-row-wrap-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/detail-image-geometry-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/settings-menu-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/card-drag-scroll-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/menu-panel-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/narrow-window-audit.mjs", {}, onAuditChildChange);
    // Builds its page for production; the Rust test of the full read builds
    // the tests optimised and runs with `bun run test:sidebar-strip`.
    await runAudit("scripts/sidebar-strip-audit.mjs", {}, onAuditChildChange, ["--skip-rust"]);
    await runAudit("scripts/reading-mode-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/editing-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/focus-ring-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/paste-feed-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/image-preview-motion-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/card-peek-motion-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/card-open-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/tooltip-motion-audit.mjs", {}, onAuditChildChange);
    await runAudit("scripts/swipe-scroller-audit.mjs", {}, onAuditChildChange);
    // The browser's measures only: the Rust test of the save's time builds
    // the tests optimised and runs with `bun run test:editing-perf`.
    await runAudit("scripts/editing-perf-audit.mjs", {}, onAuditChildChange, ["--skip-rust"]);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await stopProcess(activeAudit);
    await stopProcess(server);
    fs.rmSync(coldSpaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
