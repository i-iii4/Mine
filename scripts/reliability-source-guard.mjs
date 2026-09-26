import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fixturePath = fileURLToPath(new URL('./fixtures/reliability/source-v1.json', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Snapshot every original path and byte; never follow links outside the fixture. */
export async function sourceSnapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      const key = relative(root, path).split(sep).join('/');
      if (stat.isSymbolicLink()) throw new Error(`Source symlink is forbidden: ${key}`);
      if (stat.isDirectory()) { result[key] = 'directory'; await visit(path); }
      else if (stat.isFile()) result[key] = sha256(await readFile(path));
      else throw new Error(`Unsupported source entry: ${key}`);
    }
  }
  await visit(root);
  return result;
}

export function assertSourceUnchanged(before, after) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path]);
  if (changed.length) throw new Error(`Source paths or bytes changed: ${changed.join(', ')}`);
}

/** Materialize only versioned synthetic input, never a user's space. */
export async function createFixture(root) {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (fixture.synthetic !== true) throw new Error('Only synthetic fixtures are permitted');
  for (const [name, content] of Object.entries(fixture.files)) {
    const path = resolve(root, name);
    if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Unsafe fixture path: ${name}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: 'wx' });
  }
  return fixture;
}

/** Run a real reader/rebuilder against disposable source and derived folders. */
export async function guardCommand(command, args = [], reportPath) {
  if (!command) throw new Error('An actual reader/rebuilder command is required');
  const temporary = await mkdtemp(join(tmpdir(), 'mine-reliability-'));
  const source = join(temporary, 'source');
  const derived = join(temporary, 'derived');
  await mkdir(source); await mkdir(derived);
  try {
    await createFixture(source);
    const before = await sourceSnapshot(source);
    const execution = spawnSync(command, args, {
      env: { ...process.env, MINE_RELIABILITY_SOURCE: source, MINE_RELIABILITY_DERIVED: derived },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    const after = await sourceSnapshot(source);
    assertSourceUnchanged(before, after);
    if (execution.error || execution.status !== 0 || execution.signal) {
      const reason = execution.error?.message || execution.signal || execution.stderr?.trim() || `exit ${execution.status}`;
      throw new Error(`Reader/rebuilder failed: ${reason}`);
    }
    const report = { schemaVersion: 1, scope: 'source-immutability-only', command: [command, ...args],
      fixtureSha256: sha256(await readFile(fixturePath)), exitCode: execution.status, before, after,
      environmentCases: 'pending', stdout: execution.stdout, stderr: execution.stderr };
    if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const separator = process.argv.indexOf('--');
  const options = process.argv.slice(2, separator);
  const reportAt = options.indexOf('--report');
  try {
    if (separator < 0) throw new Error('Usage: node scripts/reliability-source-guard.mjs [--report path] -- command args');
    if (reportAt >= 0 && !options[reportAt + 1]) throw new Error('Missing --report path');
    const report = await guardCommand(process.argv[separator + 1], process.argv.slice(separator + 2),
      reportAt >= 0 ? options[reportAt + 1] : undefined);
    console.log(`Source unchanged: ${Object.keys(report.before).length} paths. This does not close an acceptance scenario.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
