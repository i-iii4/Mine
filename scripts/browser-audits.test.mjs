// SPEC_GRID_LAYOUT_READINESS.md, «Browser Acceptance Harness»: `test:browser`
// runs every audit to the end, a failed one does not stop the next, and the
// summary names every failed audit with the first line of its error (user's
// decision of 17.11.2026).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAuditRunner, failureLine, failureReport } from './browser-audit-runner.mjs';

/** A sink for the audits' output, which the runner passes on as it comes. */
function sink() {
  const sink = { text: '', write(chunk) { sink.text += chunk; } };
  return sink;
}

function auditFolder(t) {
  const folder = mkdtempSync(join(tmpdir(), 'mine-browser-audits-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const log = join(folder, 'ran.log');
  const audit = (name, body) => {
    const script = join(folder, `${name}-audit.mjs`);
    writeFileSync(script, `import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name}\n`)});
${body}
`);
    return script;
  };
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { audit, ran };
}

test('a failed audit does not stop the next one, and the summary names every failed audit', async t => {
  const { audit, ran } = auditFolder(t);
  const first = audit('first', `assert.equal(1, 2, 'the first audit: the panel beside the content');`);
  const second = audit('second', `console.log('PASS second');`);
  const third = audit('third', `console.log('FAIL the third audit: the menu under the pointer'); process.exitCode = 1;`);
  const fourth = audit('fourth', `console.error('the fourth audit: the window stayed blank'); process.exit(1);`);
  const stdout = sink(), stderr = sink();
  const { runAudit, failures, finish } = createAuditRunner({ stdout, stderr });

  for (const script of [first, second, third, fourth]) await runAudit(script, {});
  assert.equal(finish(), 1);

  assert.deepEqual(ran(), ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(failures, [
    { script: first, line: 'AssertionError [ERR_ASSERTION]: the first audit: the panel beside the content' },
    { script: third, line: 'FAIL the third audit: the menu under the pointer' },
    { script: fourth, line: 'the fourth audit: the window stayed blank' },
  ]);
  assert.equal(failureReport(failures), [
    '3 browser audit(s) failed:',
    `  ${first}: AssertionError [ERR_ASSERTION]: the first audit: the panel beside the content`,
    `  ${third}: FAIL the third audit: the menu under the pointer`,
    `  ${fourth}: the fourth audit: the window stayed blank`,
  ].join('\n'));
  // Each audit's own output still reaches the run's log, and the summary
  // closes it.
  assert.match(stdout.text, /PASS second/);
  assert.match(stderr.text, /the fourth audit: the window stayed blank/);
  assert.ok(stderr.text.endsWith(`\n${failureReport(failures)}\n`), stderr.text);
});

test('every audit passing exits 0 with no summary', async t => {
  const { audit, ran } = auditFolder(t);
  const stderr = sink();
  const { runAudit, failures, finish } = createAuditRunner({ stdout: sink(), stderr });
  await runAudit(audit('one', `console.log('PASS one');`), {});
  await runAudit(audit('two', `console.log('PASS two');`), {});
  assert.equal(finish(), 0);
  assert.deepEqual(ran(), ['one', 'two']);
  assert.deepEqual(failures, []);
  assert.equal(failureReport(failures), '');
  assert.doesNotMatch(stderr.text, /failed/);
});

test('after an interrupt no further audit starts, and the run exits with the interrupt\'s code and no summary', async t => {
  const { audit, ran } = auditFolder(t);
  const stderr = sink();
  const { runAudit, stop, finish } = createAuditRunner({ stdout: sink(), stderr });
  await runAudit(audit('before', `process.exit(1);`), {});
  stop(130);
  await runAudit(audit('later', ''), {});
  assert.deepEqual(ran(), ['before']);
  assert.equal(finish(), 130);
  assert.doesNotMatch(stderr.text, /browser audit\(s\) failed/);
});

test('the first line of an error: its name, else FAIL, else the last line of stderr, else the exit', () => {
  const uncaught = [
    'file:///audit.mjs:3',
    'assert.equal(1, 2, "margins");',
    '       ^',
    '',
    'AssertionError [ERR_ASSERTION]: margins',
    '    at file:///audit.mjs:3:8',
    '',
    'Node.js v22.0.0',
  ].join('\n');
  assert.equal(failureLine('', uncaught, { code: 1, signal: null }), 'AssertionError [ERR_ASSERTION]: margins');
  assert.equal(failureLine('', 'TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.\n    at x', { code: 1, signal: null }),
    'TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.');
  assert.equal(failureLine('PASS a\nFAIL b: the row\n', 'a note\n', { code: 1, signal: null }), 'FAIL b: the row');
  assert.equal(failureLine('', 'measuring again\nthe frame is late\n\nNode.js v22.0.0\n', { code: 1, signal: null }), 'the frame is late');
  assert.equal(failureLine('PASS a\n', '', { code: null, signal: 'SIGKILL' }), 'exit code=null signal=SIGKILL');
});
