import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_APP = 'target/release/bundle/macos/Mine.app';
const WINDOW_P95_BUDGET_MS = 500;
const CARDS_P95_BUDGET_MS = 1_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function milestone(lines, name) {
  const line = lines.find((entry) => entry.includes(`milestone=${name}`));
  const elapsed = line?.match(/launch_elapsed_ms=(\d+)/)?.[1];
  return elapsed === undefined ? null : Number(elapsed);
}

function eventElapsed(lines, scope, message) {
  const line = lines.find((entry) => entry.includes(`[${scope}] ${message}`));
  const elapsed = line?.match(/launch_elapsed_ms=(\d+)/)?.[1];
  return elapsed === undefined ? null : Number(elapsed);
}

export function parseStartupTrace(text) {
  const lines = text.split('\n').filter(Boolean);
  const launchId = lines[0]?.match(/launch_id=([^ ]+)/)?.[1] ?? null;
  return {
    launchId,
    windowShellMs: eventElapsed(lines, 'window', 'created'),
    frontendShellPaintedMs: milestone(lines, 'window_shell_painted'),
    firstCardsMs: milestone(lines, 'first_cards_painted'),
    interactiveMs: milestone(lines, 'interactive'),
    maintenanceStartMs: eventElapsed(lines, 'startup_maintenance', 'start'),
  };
}

function percentile(values, percentileValue) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return ordered[index];
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForTrace(tracePath, timeoutMs, expectedLaunchPrefix) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (existsSync(tracePath)) {
      last = readFileSync(tracePath, 'utf8');
      const parsed = parseStartupTrace(last);
      if (
        parsed.launchId !== null
        && parsed.launchId.startsWith(expectedLaunchPrefix)
        && parsed.windowShellMs !== null
        && parsed.firstCardsMs !== null
        && parsed.interactiveMs !== null
        && parsed.maintenanceStartMs !== null
      ) return parsed;
    }
    await wait(25);
  }
  throw new Error(`startup trace did not reach first_cards_painted:\n${last}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once('exit', onExit);
  });
}

async function stopOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForExit(child, 2_000);
  child.kill('SIGTERM');
  if (await gracefulExit) return;
  const forcedExit = waitForExit(child, 2_000);
  child.kill('SIGKILL');
  if (!await forcedExit) throw new Error(`Mine process ${child.pid} did not stop`);
}

async function runOnce(executable, tracePath) {
  const child = spawn(executable, [], { stdio: 'ignore' });
  try {
    return await waitForTrace(tracePath, 15_000, `${child.pid}-`);
  } finally {
    await stopOwnedProcess(child);
    await wait(250);
  }
}

async function main() {
  const appPath = resolve(argument('--app', DEFAULT_APP));
  const runs = Number(argument('--runs', '10'));
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  const executable = join(appPath, 'Contents/MacOS/mine');
  if (!existsSync(executable)) throw new Error(`Mine executable is missing: ${executable}`);

  const existing = spawnSync('pgrep', ['-x', 'mine'], { encoding: 'utf8' });
  if (existing.status === 0) {
    throw new Error(`Close the existing Mine process before acceptance (PID ${existing.stdout.trim()})`);
  }

  const tracePath = join(homedir(), 'Library/Application Support/com.mine.app/startup-trace.log');
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    const result = await runOnce(executable, tracePath);
    results.push(result);
    console.log(
      `run ${index + 1}/${runs}: shell=${result.windowShellMs}ms frontend=${result.frontendShellPaintedMs}ms cards=${result.firstCardsMs}ms`,
    );
  }

  const shell = results.map((result) => result.windowShellMs);
  const cards = results.map((result) => result.firstCardsMs);
  const blockingMaintenance = results.filter(
    (result) => result.maintenanceStartMs < result.firstCardsMs,
  );
  const summary = {
    runs,
    shell: { p50: percentile(shell, 50), p95: percentile(shell, 95), max: Math.max(...shell) },
    cards: { p50: percentile(cards, 50), p95: percentile(cards, 95), max: Math.max(...cards) },
    blockingMaintenanceRuns: blockingMaintenance.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.shell.p95 > WINDOW_P95_BUDGET_MS) {
    throw new Error(`window shell p95 ${summary.shell.p95}ms exceeds ${WINDOW_P95_BUDGET_MS}ms`);
  }
  if (summary.cards.p95 > CARDS_P95_BUDGET_MS) {
    throw new Error(`first cards p95 ${summary.cards.p95}ms exceeds ${CARDS_P95_BUDGET_MS}ms`);
  }
  if (summary.blockingMaintenanceRuns !== 0) {
    throw new Error(`maintenance started before cards in ${summary.blockingMaintenanceRuns} runs`);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && basename(process.argv[1]) === basename(scriptPath)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
