import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALLED, LSREGISTER, installLocalApp } from './install-local-app.mjs';

function fakeSystem({ running = [], installed = true, quits = true, verifies = true } = {}) {
  const files = new Set(['/build/Mine.app', ...(installed ? [INSTALLED] : [])]);
  const calls = [];
  return {
    calls,
    files,
    trash: '/Users/me/.Trash',
    now: () => new Date(2026, 8, 29, 14, 5, 9),
    exists: (path) => files.has(path),
    move: (from, to) => { calls.push(['move', from, to]); files.delete(from); files.add(to); },
    waitUntilQuit: () => quits,
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === '/usr/bin/pgrep') return { status: running.includes(args[1]) ? 0 : 1 };
      if (command === '/usr/bin/ditto') files.add(args[1]);
      if (command === '/usr/bin/codesign') return { status: verifies ? 0 : 1, stderr: 'invalid' };
      return { status: 0, stderr: '' };
    },
  };
}

test('the previous copy goes to the Trash and only the installed copy stays registered', () => {
  const system = fakeSystem();
  const report = installLocalApp('/build/Mine.app', system);
  assert.equal(report.previous, '/Users/me/.Trash/Mine-2026-09-29-140509.app');
  assert.ok(system.files.has(INSTALLED));
  assert.ok(system.files.has(report.previous));
  const lsregister = system.calls.filter(([command]) => command === LSREGISTER);
  assert.deepEqual(lsregister, [[LSREGISTER, '-u', '/build/Mine.app'], [LSREGISTER, '-f', INSTALLED]]);
  // Nothing is ever parked inside /Applications.
  assert.ok(system.calls.every(([command, , to]) => command !== 'move' || !to.startsWith('/Applications/')));
});

test('a running media download stops the install before Mine quits', () => {
  const system = fakeSystem({ running: ['yt-dlp'] });
  assert.throws(() => installLocalApp('/build/Mine.app', system), /media download is running/);
  assert.ok(!system.calls.some(([command]) => command === '/usr/bin/osascript'));
  assert.ok(system.files.has(INSTALLED));
});

test('Mine that does not quit keeps its installed copy', () => {
  const system = fakeSystem({ quits: false });
  assert.throws(() => installLocalApp('/build/Mine.app', system), /did not quit/);
  assert.ok(!system.calls.some(([command]) => command === 'move'));
});

test('a copy that fails verification is reported', () => {
  const system = fakeSystem({ verifies: false });
  assert.throws(() => installLocalApp('/build/Mine.app', system), /signature verification/);
});
