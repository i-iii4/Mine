// The runner of `test:browser`'s audits (SPEC_GRID_LAYOUT_READINESS.md,
// «Browser Acceptance Harness»; user's decision of 17.11.2026): every audit
// runs to the end, a failed one does not stop the next, and the summary names
// every failed audit with the first line of its error. `browser-audits.mjs`
// prepares the run and lists the audits.
import { spawn } from "node:child_process";
import process from "node:process";

// The first line of an audit's error: a line of stderr that starts with an
// error's name, `AssertionError [ERR_ASSERTION]: …` or `Error: …`.
const ERROR_HEAD = /^(?:[A-Z][\w$]*)?Error(?: \[[A-Z_]+\])?: /;
// The line Node closes an uncaught error with.
const NODE_VERSION_LINE = /^Node\.js v\d/;

function outputLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** What a failed audit reports first: the line naming its error, else its
 *  first `FAIL` line, else the last line of its stderr, else how it exited. */
export function failureLine(stdout, stderr, exit) {
  const errors = outputLines(stderr);
  const named = errors.find((line) => ERROR_HEAD.test(line));
  if (named) return named;
  const failed = [...errors, ...outputLines(stdout)].find((line) => /^FAIL\b/.test(line));
  if (failed) return failed;
  const last = errors.filter((line) => !NODE_VERSION_LINE.test(line)).at(-1);
  if (last) return last;
  return `exit code=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`;
}

/** The summary after the last audit: every failed one with its first line. */
export function failureReport(failures) {
  if (failures.length === 0) return "";
  const lines = failures.map(({ script, line }) => `  ${script}: ${line}`);
  return `${failures.length} browser audit(s) failed:\n${lines.join("\n")}`;
}

/**
 * Runs audits one after another to the end: a failed audit is written down
 * and the next one starts. An audit's output goes on to `stdout` and
 * `stderr` as it comes; it is kept to name its error. `onChildChange` hears
 * the audit running now, which an interrupt stops. After `stop(exitCode)` no
 * further audit starts. `finish` prints the summary and gives the run's exit
 * code: 1 when an audit failed, 0 when none did, and an interrupted run's
 * own code without a summary, which the interrupt does not owe.
 */
export function createAuditRunner({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const failures = [];
  let stoppedWith = null;
  function runAudit(script, env = {}, onChildChange = () => {}, args = []) {
    if (stoppedWith !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        detached: process.platform !== "win32",
        stdio: ["inherit", "pipe", "pipe"],
      });
      onChildChange(child);
      const output = { stdout: "", stderr: "" };
      child.stdout.on("data", (chunk) => {
        output.stdout += chunk;
        stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output.stderr += chunk;
        stderr.write(chunk);
      });
      let settled = false;
      const settle = (line) => {
        if (settled) return;
        settled = true;
        onChildChange(null);
        if (line !== null) failures.push({ script, line });
        resolve();
      };
      child.once("error", (error) => settle(error.message));
      // `close`, not `exit`: the output is read to its end before the error
      // is named.
      child.once("close", (code, signal) => {
        settle(code === 0 ? null : failureLine(output.stdout, output.stderr, { code, signal }));
      });
    });
  }
  return {
    runAudit,
    failures,
    stop(exitCode) {
      stoppedWith ??= exitCode;
    },
    finish() {
      if (stoppedWith !== null) return stoppedWith;
      if (failures.length === 0) return 0;
      stderr.write(`\n${failureReport(failures)}\n`);
      return 1;
    },
  };
}
