// Real native messaging, source files and the normal scanner; no browser or app UI.
// Only new UUID-owned fixtures are written. Config, installed helper and browser
// registrations are never changed. Artifacts are retained, including app-local
// test journals because production native-host has no app-state path override.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

if (process.argv.includes('--help')) {
  console.log('node scripts/native-capture-smoke.mjs\nUses the already-built .app helper and scanner.\nCreates new disposable vaults under output/playwright/ plus unique test-only derived/journal directories in the normal Mine app-data root.\nDoes not launch Mine or change config, installed helper, registrations or existing vaults. Retains all evidence.');
  process.exit(0);
}
assert.equal(process.argv.length, 2, 'No arguments accepted; see --help');
assert.equal(process.platform, 'darwin', 'This acceptance uses the packaged macOS binaries');
assert.ok(process.env.HOME, 'Production helper requires HOME; it is never overridden');

const root = fileURLToPath(new URL('..', import.meta.url));
const binaries = join(root, 'target/debug/bundle/macos/Mine.app/Contents/MacOS');
const host = join(binaries, 'native-host');
const scanner = join(binaries, 'cold-space-audit');
const appState = join(process.env.HOME, 'Library/Application Support/com.mine.app');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await Promise.all([access(host), access(scanner)]);
const output = join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, 'native-capture-'));
const reportPath = join(run, 'report.json');
const imageBytes = await readFile(join(root, 'extension/icons/icon-16.png'));
const report = {
  kind: 'Native wire/disk/scanner acceptance, not browser or visible-card acceptance',
  host, host_sha256: hash(await readFile(host)),
  scanner, scanner_sha256: hash(await readFile(scanner)),
  run, cases: [], ok: false,
};

function execute(binary, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {
      cwd: root, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${binary}: ${error.message}\n${stderr.toString()}`));
      else resolve({ stdout, stderr: stderr.toString() });
    });
    child.stdin.end(input);
  });
}

async function wire(request) {
  const body = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  // Every call starts a fresh production process; lookup/replay cannot use RAM
  // left by the save. The launch origin is not forged and no ACK is requested.
  const { stdout, stderr } = await execute(host, [], Buffer.concat([header, body]));
  assert.ok(stdout.length >= 4, 'Host must emit a native message');
  assert.equal(stdout.readUInt32LE(0), stdout.length - 4, 'Exactly one complete response');
  const response = JSON.parse(stdout.subarray(4).toString('utf8'));
  // The upload token is not used by this test and must not enter its artifacts.
  delete response.upload_token;
  return { request, response, stderr };
}

async function assertAbsent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' }, `Refuse existing fixture target: ${path}`);
}

try {
  for (const mode of ['missing', 'locked', 'newer']) {
    const vaultId = `sc6-${randomUUID()}`;
    const source = join(run, mode);
    await mkdir(join(source, '.mine'), { recursive: true });
    await writeFile(join(source, '.mine/vault-id'), `${vaultId}\n`, { flag: 'wx' });
    const derived = join(appState, 'vaults', vaultId);
    const binding = hash(await realpath(source));
    const journal = join(appState, 'vaults/operations/v1', binding);
    await Promise.all([assertAbsent(derived), assertAbsent(journal)]);
    const entry = { mode, source, derived, journal, wire: [], ok: false };
    report.cases.push(entry);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    let database;
    try {
      if (mode !== 'missing') {
        // Both directories are fresh UUID targets checked above, never existing
        // user indexes. A held SQLite transaction supplies the real OS lock.
        await mkdir(derived);
        database = new DatabaseSync(join(derived, 'index.db'));
        database.exec('PRAGMA journal_mode = WAL; CREATE TABLE acceptance_sentinel(value TEXT);');
        database.exec("INSERT INTO acceptance_sentinel VALUES ('keep-me');");
        if (mode === 'locked') database.exec('BEGIN IMMEDIATE;');
        else database.exec('PRAGMA user_version = 2147483647;');
        const diagnostic = await wire({ action: 'list_channels', vault_path: source });
        entry.wire.push(diagnostic);
        assert.equal(diagnostic.response.ok, false, 'The index failure must actually be present');
        assert.match(diagnostic.response.error, mode === 'locked'
          ? /SQLite migration lock|database is locked/i : /newer/i);
      }

      const status = await wire({ action: 'get_status', vault_path: source });
      entry.wire.push(status);
      assert.equal(status.response.binding_id, binding);
      assert.ok(status.response.features.includes('save_operation_v1'));
      if (mode === 'missing') await assertAbsent(join(derived, 'index.db'));

      const blockType = mode === 'missing' ? 'article' : mode === 'locked' ? 'link' : 'image';
      const request = {
        action: 'save_block', vault_path: source,
        operation_id: `capture-${mode}`, binding_id: binding,
        block_type: blockType, title: `SC6 ${mode}`, tags: [],
        saved_at: '2026-08-31T12:00:00Z',
        url: 'https://example.com/native-acceptance',
        body: blockType === 'article' ? '# SC6 article\n\nNative acceptance text.' : '',
        ...(blockType === 'image' ? { image_url: `data:image/png;base64,${imageBytes.toString('base64')}` } : {}),
      };
      const saved = await wire(request);
      entry.wire.push(saved);
      assert.equal(saved.response.outcome, 'committed');
      assert.equal(saved.response.ok, true);
      const markdownPath = join(source, `${saved.response.slug}.md`);
      const markdown = await readFile(markdownPath);
      assert.match(markdown.toString(), /2026-08-31T12:00:00Z/);
      entry.markdown = { path: markdownPath, sha256: hash(markdown) };

      const lookup = await wire({ action: 'get_save_operation', vault_path: source,
        operation_id: request.operation_id, binding_id: binding });
      const replay = await wire({ ...request, operation_mode: 'resume' });
      entry.wire.push(lookup, replay);
      assert.equal(lookup.response.outcome, 'committed');
      assert.equal(lookup.response.slug, saved.response.slug);
      assert.equal(replay.response.outcome, 'committed');
      assert.equal(replay.response.slug, saved.response.slug);
      assert.equal(hash(await readFile(markdownPath)), entry.markdown.sha256);

      if (database) {
        assert.equal(database.prepare('SELECT value FROM acceptance_sentinel').get().value, 'keep-me');
        if (mode === 'locked') database.exec('ROLLBACK;');
        else assert.equal(database.prepare('PRAGMA user_version').get().user_version, 2147483647);
        database.close();
        database = undefined;
      }

      // Use the normal Rust reconcile + preview + projection path twice from
      // fresh derived stores. This proves recovery from source, not GUI rendering.
      const auditRoot = join(run, `${mode}-scanner`);
      await mkdir(auditRoot);
      const auditResult = await execute(scanner, [source, auditRoot, '2', '--full']);
      const audit = JSON.parse(auditResult.stdout.toString());
      await writeFile(join(run, `${mode}-scanner.json`), auditResult.stdout, { flag: 'wx' });
      assert.equal(audit.source_unchanged, true);
      assert.equal(audit.stable_after_reopen, true);
      assert.equal(audit.stable_after_cache_reset, true);
      for (const cycle of audit.cycles) {
        assert.equal(cycle.settled.source_markdown, 1);
        assert.equal(cycle.settled.content_rows, 1);
        assert.equal(cycle.settled.rows[0].slug, saved.response.slug);
        assert.equal(cycle.settled.rows[0].block_type, blockType);
      }
      if (blockType === 'image') {
        const media = join(source, audit.cycles[0].settled.rows[0].media_file);
        assert.equal(hash(await readFile(media)), hash(imageBytes));
        entry.media = { path: media, sha256: hash(imageBytes) };
      }
      entry.scanner = { cycles: audit.cycles.length, source_unchanged: true,
        stable_after_reopen: true, stable_after_cache_reset: true, content_rows: 1 };
      entry.ok = true;
      console.log(`${mode}: committed, durable lookup/replay, exact files, two scanner cycles`);
    } finally {
      database?.close();
    }
  }
  report.ok = true;
} catch (error) {
  report.error = error.stack ?? error.message;
  throw error;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, report: reportPath }));
}
