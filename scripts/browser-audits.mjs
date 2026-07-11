#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
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

function runAudit(script, env, onChildChange) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
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
  const port = await reserveFreePort();
  const origin = `http://${HOST}:${port}`;
  const logs = [];
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
      process.exit(exitCode);
    });
  };
  const interrupt = () => shutdown("SIGINT");
  const terminate = () => shutdown("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    await waitForServer(`${origin}/__feed-scroll-audit`, server, () => logs.join(""));
    await runAudit("scripts/feed-scroll-audit.mjs", {
      MINE_FEED_SCROLL_AUDIT_URL: `${origin}/__feed-scroll-audit`,
    }, onAuditChildChange);
    await runAudit("scripts/graph-view-audit.mjs", {
      MINE_GRAPH_AUDIT_URL: `${origin}/__graph-audit`,
    }, onAuditChildChange);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await stopProcess(activeAudit);
    await stopProcess(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
