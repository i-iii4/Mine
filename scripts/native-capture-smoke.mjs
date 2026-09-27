// Real native messaging, source files and the normal scanner; no browser or app UI.
// Only new UUID-owned fixtures are written. Config, installed helper and browser
// registrations are never changed. Artifacts are retained, including app-local
// test journals because production native-host has no app-state path override.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

if (process.argv.includes('--help')) {
  console.log('node scripts/native-capture-smoke.mjs [--bundle /absolute/Mine.app] [--scanner /absolute/cold-space-audit]\nUses the already-built .app helper and scanner.\nCreates new disposable vaults under output/playwright/ plus unique test-only derived/journal directories in the normal Mine app-data root.\nDoes not launch Mine or change config, installed helper, registrations or existing vaults. Retains all evidence.');
  process.exit(0);
}
const argumentsList = process.argv.slice(2);
const argumentsMap = new Map();
for (let index = 0; index < argumentsList.length; index += 2) {
  const option = argumentsList[index];
  const value = argumentsList[index + 1];
  assert.ok(['--bundle', '--scanner'].includes(option) && !argumentsMap.has(option)
    && typeof value === 'string' && isAbsolute(value), 'Invalid arguments; see --help');
  argumentsMap.set(option, value);
}
assert.equal(process.platform, 'darwin', 'This acceptance uses the packaged macOS binaries');
assert.ok(process.env.HOME, 'Production helper requires HOME; it is never overridden');

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = argumentsMap.get('--bundle') ?? join(root, 'target/debug/bundle/macos/Mine.app');
const binaries = join(bundle, 'Contents/MacOS');
const host = join(binaries, 'native-host');
const scanner = argumentsMap.get('--scanner') ?? join(binaries, 'cold-space-audit');
const appState = join(process.env.HOME, 'Library/Application Support/com.mine.app');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await Promise.all([access(host), access(scanner)]);
const output = join(root, 'output/playwright');
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, 'native-capture-'));
const reportPath = join(run, 'report.json');
const imageBytes = await readFile(join(root, 'extension/icons/icon-16.png'));
// Read the shared resolver's compatibility generation, rather than copying its
// path rule or testing the legacy database that current components never open.
const vaultSource = await readFile(join(root, 'src-tauri/src/domain/vault.rs'), 'utf8');
const indexGeneration = vaultSource.match(/pub const INDEX_GENERATION: &str = "([^"]+)";/)?.[1];
assert.ok(indexGeneration, 'Shared index compatibility generation is missing');
const migrationSource = await readFile(join(root, 'src-tauri/src/storage/migrations.rs'), 'utf8');
const currentSchemaVersion = Number(migrationSource.match(/pub const CURRENT_SCHEMA_VERSION: i64 = (\d+);/)?.[1]);
assert.ok(Number.isSafeInteger(currentSchemaVersion) && currentSchemaVersion > 0);
const report = {
  kind: 'Native wire/disk/scanner acceptance, not browser or visible-card acceptance',
  host, host_sha256: hash(await readFile(host)),
  scanner, scanner_sha256: hash(await readFile(scanner)),
  indexGeneration, currentSchemaVersion, run, cases: [], ok: false,
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

async function holdIndexLock(path) {
  // A distinct process owns the kernel lock until explicit release. Reads and
  // subprocess launches in this test cannot accidentally retire its descriptors.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('BEGIN IMMEDIATE;');
    process.stdout.write('locked\\n');
    process.stdin.once('data', () => { database.exec('ROLLBACK;'); database.close(); process.stdin.pause(); });
  `, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Index lock owner exited before release (${code}): ${stderr.join('')}`)));
    child.stdout.once('data', chunk => {
      if (String(chunk).trim() === 'locked') resolve();
      else reject(new Error(`Unexpected lock owner reply: ${chunk}`));
    });
  });
  return child;
}

async function releaseIndexLock(child) {
  const exited = new Promise((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Index lock owner failed (${code})`)));
    child.once('error', reject);
  });
  child.stdin.end('release');
  await exited;
}

try {
  for (const mode of ['missing', 'locked', 'newer']) {
    const vaultId = `sc6-${randomUUID()}`;
    const source = join(run, mode);
    await mkdir(join(source, '.mine'), { recursive: true });
    await writeFile(join(source, '.mine/vault-id'), `${vaultId}\n`, { flag: 'wx' });
    const derived = join(appState, 'vaults', vaultId);
    const generationDirectory = join(derived, 'indexes', indexGeneration);
    const originalIndex = join(generationDirectory, 'index.db');
    const binding = hash(await realpath(source));
    const journal = join(appState, 'vaults/operations/v1', binding);
    await Promise.all([assertAbsent(derived), assertAbsent(journal)]);
    const markerPath = join(source, '.mine/vault-id');
    const markerHash = hash(await readFile(markerPath));
    const entry = { mode, source, derived, journal, originalIndex, wire: [], ok: false };
    report.cases.push(entry);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    let database;
    let indexLock;
    try {
      if (mode !== 'missing') {
        // The production host creates a structurally valid current database.
        // A sentinel-only SQLite file would be rejected and would not exercise
        // lock contention on the index actually selected by the resolver.
        const initialized = await wire({ action: 'list_channels', vault_path: source });
        entry.wire.push(initialized);
        assert.equal(initialized.response.ok, true);
        assert.equal((await readFile(join(generationDirectory, 'active-slot'), 'utf8')).trim(), '0');
        database = new DatabaseSync(originalIndex);
        assert.equal(database.prepare('PRAGMA user_version').get().user_version, currentSchemaVersion);
        database.exec('CREATE TABLE acceptance_sentinel(value TEXT);');
        database.exec("INSERT INTO acceptance_sentinel VALUES ('keep-me');");
        if (mode === 'newer') database.exec('PRAGMA user_version = 2147483647;');
        database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        entry.originalIndexSha256 = hash(await readFile(originalIndex));
        entry.originalSchemaSha256 = hash(JSON.stringify(database.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()));
        if (mode === 'locked') indexLock = await holdIndexLock(originalIndex);
        const diagnostic = await wire({ action: 'list_channels', vault_path: source });
        entry.wire.push(diagnostic);
        const selectedSlot = Number((await readFile(join(generationDirectory, 'active-slot'), 'utf8')).trim());
        if (mode === 'locked') {
          assert.equal(diagnostic.response.ok, false, 'The active current index must actually be locked');
          assert.match(diagnostic.response.error, /SQLite migration lock|database is locked/i);
          assert.equal(selectedSlot, 0, 'An environmental lock must not retire the compatible index');
          entry.indexFaultObserved = 'active current index refused writes under a real SQLite lock';
        } else {
          assert.equal(diagnostic.response.ok, true, 'A newer index must automatically select a compatible fallback');
          assert.ok(Number.isSafeInteger(selectedSlot) && selectedSlot > 0);
          entry.selectedIndex = join(generationDirectory, `recovery-${selectedSlot}`, 'index.db');
          const fallback = new DatabaseSync(entry.selectedIndex, { readOnly: true });
          try {
            assert.equal(fallback.prepare('PRAGMA user_version').get().user_version, currentSchemaVersion);
            assert.ok(fallback.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocks'").get());
          } finally { fallback.close(); }
          entry.indexFaultObserved = 'newer index preserved and compatible recovery slot selected';
        }
        assert.equal(hash(await readFile(originalIndex)), entry.originalIndexSha256);
      }

      const status = await wire({ action: 'get_status', vault_path: source });
      entry.wire.push(status);
      assert.equal(status.response.binding_id, binding);
      assert.ok(status.response.features.includes('save_operation_v1'));
      if (mode === 'missing') await assertAbsent(originalIndex);

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
        assert.equal(hash(JSON.stringify(database.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all())), entry.originalSchemaSha256);
        if (mode === 'locked') {
          assert.equal(database.prepare('PRAGMA user_version').get().user_version, currentSchemaVersion);
          assert.equal(database.prepare('SELECT COUNT(*) AS count FROM blocks').get().count, 0,
            'Source commit must not silently bypass the held index write lock');
          const contender = new DatabaseSync(originalIndex);
          try {
            assert.throws(() => contender.exec("INSERT INTO acceptance_sentinel VALUES ('must-not-commit');"), /locked/i,
              'The SQLite lock must remain held after source commit and replay');
          } finally { contender.close(); }
          await releaseIndexLock(indexLock);
          indexLock = undefined;
          entry.lockHeldThroughSourceReplay = true;
        } else {
          assert.equal(database.prepare('PRAGMA user_version').get().user_version, 2147483647);
        }
        database.close();
        database = undefined;
        entry.finalOriginalIndexSha256 = hash(await readFile(originalIndex));
        assert.equal(entry.finalOriginalIndexSha256, entry.originalIndexSha256,
          'The existing index bytes must remain untouched after its lock is released');
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
      assert.equal(hash(await readFile(markdownPath)), entry.markdown.sha256);
      assert.equal(hash(await readFile(markerPath)), markerHash);
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
      if (indexLock) await releaseIndexLock(indexLock);
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
