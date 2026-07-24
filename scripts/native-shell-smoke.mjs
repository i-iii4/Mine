import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP_EXECUTABLE = join(
  ROOT,
  "target/debug/bundle/macos/Mine.app/Contents/MacOS/mine",
);
const outputPath = join(
  tmpdir(),
  `mine-native-shell-smoke-${process.pid}-${Date.now()}.json`,
);

if (process.platform !== "darwin") {
  throw new Error("native-shell smoke currently requires macOS WKWebView");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code} signal ${signal ?? "none"}`));
      }
    });
  });
}

async function waitForReport(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Mine exited before publishing the smoke report (${child.exitCode})`);
    }
    try {
      return JSON.parse(await readFile(outputPath, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for native-shell IPC report at ${outputPath}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let appProcess;
try {
  if (process.env.MINE_NATIVE_SMOKE_SKIP_BUILD !== "1") {
    await run("bunx", ["tauri", "build", "--debug", "--bundles", "app"]);
  }

  appProcess = spawn(APP_EXECUTABLE, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      MINE_NATIVE_SMOKE_OUTPUT: outputPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  appProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  appProcess.stdout.on("data", (chunk) => stderr.push(String(chunk)));

  const report = await waitForReport(appProcess, 30_000).catch((error) => {
    throw new Error(`${error.message}\n${stderr.join("").slice(-8_000)}`);
  });
  if (report.status !== "ok") {
    throw new Error(`native command failed through IPC: ${report.status}`);
  }
  if (!String(report.location).includes("mine-native-shell-smoke=1")) {
    throw new Error(`native WebView did not load the smoke route: ${report.location}`);
  }
  if (!String(report.user_agent).includes("AppleWebKit")) {
    throw new Error(`expected a WKWebView user agent, received: ${report.user_agent}`);
  }

  console.log(JSON.stringify({
    ok: true,
    transport: "tauri-ipc",
    shell: "macos-wkwebview",
    vaultPath: report.vault_path,
  }));
} finally {
  if (appProcess) await stop(appProcess);
  await rm(outputPath, { force: true });
}
