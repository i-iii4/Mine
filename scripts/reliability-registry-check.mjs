// Registry check (SPEC_SYSTEM_RELIABILITY.md, INV-01): compares the
// reliability registry with the sources. It runs no test. It checks that every
// requirement heading exists, that every named command runs the tests it is
// named with, that every test imports, reads or launches each path bound to it
// (scripts/test-reach.mjs), and that every changed file is bound that way.
// Whether the tests pass is the business of their own commands.
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256, fixturePath } from './reliability-source-guard.mjs';
import { prepareUpdateChannel } from './prepare-update-channel.mjs';
import { createReach } from './test-reach.mjs';
import { SAFARI_MIRRORS, verifyExtensionMirrors } from './verify-extension-mirrors.mjs';

export const repository = fileURLToPath(new URL('../', import.meta.url));
export const registryPath = fileURLToPath(new URL('./fixtures/reliability/registry.json', import.meta.url));
export const PRINCIPLES = Array.from({ length: 11 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`);
export const ACCEPTANCE = Array.from({ length: 24 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`);
export const LEVELS = ['core', 'integration', 'built-components', 'installed-release'];
const STATUSES = new Set(['pending', 'passed', 'failed', 'skipped', 'flaky']);
const COMPONENTS = ['application', 'host', 'extension', 'cli'];
const HEX = /^[a-f0-9]{64}$/;

function requireCondition(condition, message) { if (!condition) throw new Error(message); }
function exactIds(items, ids, name) {
  requireCondition(Array.isArray(items), `${name}: expected an array`);
  const actual = items.map(item => item.id);
  requireCondition(new Set(actual).size === actual.length && ids.length === actual.length &&
    ids.every(id => actual.includes(id)), `${name}: mandatory IDs missing, duplicated or unknown`);
}

async function localFile(root, path) {
  requireCondition(typeof path === 'string' && path.length > 0 && !path.includes('://'), `Expected local evidence path: ${path}`);
  const absolute = resolve(root, path);
  const canonical = await realpath(absolute);
  requireCondition(canonical.startsWith(`${await realpath(root)}${sep}`), `Evidence escapes repository: ${path}`);
  return canonical;
}

/** Artifacts and generated reports can reside outside the checkout; only read them. */
async function evidencePath(root, path) {
  requireCondition(typeof path === 'string' && path.length > 0 && !path.includes('://'), 'Expected explicit local artifact or report');
  return realpath(resolve(root, path));
}

/** Bind bundles to every path, link target and file byte, not just their name. */
export async function artifactDigest(path) {
  const metadata = await lstat(path);
  if (metadata.isFile()) return sha256(await readFile(path));
  requireCondition(metadata.isDirectory(), 'Artifact must be a file or bundle directory');
  const entries = {};
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const child = resolve(directory, name);
      const key = `${prefix}${name}`;
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) entries[key] = { link: await readlink(child) };
      else if (stat.isDirectory()) { entries[key] = { directory: true }; await visit(child, `${key}/`); }
      else if (stat.isFile()) entries[key] = { sha256: sha256(await readFile(child)) };
      else throw new Error(`Unsupported artifact entry: ${key}`);
    }
  }
  await visit(path);
  return sha256(JSON.stringify(entries));
}

/** Heading lines of a Markdown document, outside fenced code. */
export function markdownHeadings(source) {
  const headings = new Set();
  let fence = null;
  for (const line of source.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence && /^#{1,6} \S/.test(line)) headings.add(line.trimEnd());
  }
  return headings;
}

/** `path#heading`, where the heading is one whole heading line of the file:
 *  a word that merely occurs in it, or the start of a heading, is not one. */
async function validateReference(root, reference) {
  requireCondition(typeof reference === 'string' && reference.includes('#'), `Missing requirement reference: ${reference}`);
  const separator = reference.indexOf('#');
  const path = reference.slice(0, separator);
  const heading = reference.slice(separator + 1);
  const source = await readFile(await localFile(root, path), 'utf8');
  requireCondition(markdownHeadings(source).has(heading), `Requirement heading missing: ${reference}`);
}

/** The one format of the registry file: two-space JSON and a final newline. */
export function verifyRegistryFormat(text) {
  requireCondition(text === `${JSON.stringify(JSON.parse(text), null, 2)}\n`,
    'registry.json is not in its format: JSON.stringify(registry, null, 2) and a final newline');
}

// Files whose change changes what the product or its checks do. Styles,
// pages and shell scripts count as much as code (SPEC_AUDIT_FIXES.md, А10.4).
const BEHAVIOR = /\.(?:rs|tsx?|mjs|js|json|toml|swift|css|html|sh)$/;
export function isBehaviorPath(path) {
  return BEHAVIOR.test(path) && !/(?:^|\/)(?:package-lock|bun\.lock)/.test(path);
}

/**
 * Every claim of the change coverage holds: the command runs each test, and
 * each path is imported, read or launched by one of the tests itself. A path
 * cannot be covered by naming it next to a test that never touches it, and a
 * directory cannot cover files added to it later.
 */
async function validateChangeCoverage(registry, root, packageJson, reach) {
  requireCondition(registry.changeCoverage?.length > 0, 'No contract coverage for changes');
  const problems = [];
  for (const [index, coverage] of registry.changeCoverage.entries()) {
    const label = `changeCoverage[${index}] ${coverage.requirement}`;
    try { await validateReference(root, coverage.requirement); } catch (error) { problems.push(`${label}: ${error.message}`); }
    if (!packageJson.scripts[coverage.command]) problems.push(`${label}: no package.json script ${coverage.command}`);
    if (!(coverage.paths?.length > 0)) problems.push(`${label}: no paths`);
    if (!(coverage.tests?.length > 0)) problems.push(`${label}: no tests`);
    const running = [];
    for (const test of coverage.tests ?? []) {
      try { await localFile(root, test); } catch { problems.push(`${label}: test does not exist: ${test}`); continue; }
      let runs = false;
      try { runs = packageJson.scripts[coverage.command] !== undefined && reach.commandRuns(coverage.command, test); } catch (error) { problems.push(`${label}: ${error.message}`); continue; }
      if (runs) running.push(test);
      else problems.push(`${label}: ${coverage.command} does not run ${test}`);
    }
    for (const path of coverage.paths ?? []) {
      if (path.endsWith('/')) { problems.push(`${label}: a directory would cover files no test touches: ${path}`); continue; }
      try { await localFile(root, path); } catch { problems.push(`${label}: path does not exist: ${path}`); continue; }
      if (!running.some(test => reach.executes(test, path))) problems.push(`${label}: no test of the entry imports, reads or launches ${path}`);
    }
  }
  requireCondition(problems.length === 0, `Registry claims that do not hold (${problems.length}):\n${problems.slice(0, 50).join('\n')}${problems.length > 50 ? `\n… and ${problems.length - 50} more` : ''}`);
}

/**
 * A case label of the reliability fixture is only a name. The fixture is
 * covered when the registry binds it to a test that reads it and checks each
 * required case in its own branch, a match arm or a switch case on the label,
 * the way storage/db.rs, reliability_fixture_cases_have_their_behavior, does
 * (SPEC_DEEP_AUDIT.md, Е7.8). Whether the branches pass is that test's command.
 */
async function verifyFixtureBehavior(registry, root, reach, requiredCases) {
  const fixture = relative(root, fixturePath).split(sep).join('/');
  const tests = [...new Set(registry.changeCoverage.filter(entry => entry.paths.includes(fixture))
    .flatMap(entry => entry.tests).filter(test => reach.executes(test, fixture)))];
  requireCondition(tests.length > 0, `The reliability fixture is bound to no test that reads it: ${fixture}`);
  const sources = await Promise.all(tests.map(async test => readFile(await localFile(root, test), 'utf8')));
  const escape = id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unchecked = requiredCases.filter(id => !sources.some(source =>
    new RegExp(`"${escape(id)}"\\s*(?:=>|\\|)|case\\s+(["'])${escape(id)}\\1\\s*:`).test(source)));
  requireCondition(unchecked.length === 0,
    `Fixture cases no test bound to ${fixture} checks in a branch of their own (${tests.join(', ')}): ${unchecked.join(', ')}`);
}

export async function validateRegistry(registry, root = repository, reach = createReach(root)) {
  requireCondition(registry.schemaVersion === 1, 'Unknown registry schema');
  exactIds(registry.principles, PRINCIPLES, 'principles');
  exactIds(registry.acceptance, ACCEPTANCE, 'acceptance');
  exactIds(registry.levels, LEVELS, 'levels');
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const entry of [...registry.principles, ...registry.acceptance, ...registry.levels]) {
    requireCondition(STATUSES.has(entry.result), `${entry.id}: unknown result`);
    requireCondition(typeof entry.behavior === 'string' && entry.behavior.trim(), `${entry.id}: missing observable behavior`);
    requireCondition(typeof entry.pendingReason === 'string' || entry.result !== 'pending', `${entry.id}: unexplained pending result`);
    await validateReference(root, entry.requirement);
    requireCondition(Array.isArray(entry.tests) && entry.tests.length > 0, `${entry.id}: no test or review owner`);
    for (const test of entry.tests) await localFile(root, test);
    requireCondition(packageJson.scripts[entry.command], `${entry.id}: launch command missing: ${entry.command}`);
    requireCondition(entry.levels?.length > 0 && entry.levels.every(level => LEVELS.includes(level)), `${entry.id}: missing verification level`);
    requireCondition(entry.result !== 'passed' || entry.evidence?.length > 0, `${entry.id}: a declaration is not passing evidence`);
  }
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const requiredCases = ['plain-markdown', 'unknown-properties', 'malformed-frontmatter', 'unicode', 'spaces',
    'nested-folders', 'duplicate-basenames', 'relative-links', 'obsidian-links', 'collections', 'multiple-media',
    'missing-attachment', 'unavailable-cloud-file'];
  requireCondition(fixture.version === registry.fixtureVersion && fixture.synthetic === true &&
    requiredCases.every(id => fixture.cases.includes(id)), 'Versioned fixture coverage incomplete');
  await validateChangeCoverage(registry, root, packageJson, reach);
  await verifyFixtureBehavior(registry, root, reach, requiredCases);
  return registry;
}

/** Check committed production dependencies, independently of registry declarations. */
export async function verifyModuleBoundaries(root = repository) {
  async function visit(directory, forbidden) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path, forbidden);
      else if (entry.name.endsWith('.rs')) {
        const code = (await readFile(path, 'utf8')).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
        requireCondition(!forbidden.test(code), `Forbidden module dependency: ${path}`);
      }
    }
  }
  await visit(resolve(root, 'src-tauri/src/domain'), /(?:crate|super)\s*::\s*(?:storage|commands)\b|use\s+crate\s*::\s*\{[^;]*\b(?:storage|commands)\b/);
  await visit(resolve(root, 'src-tauri/src/storage'), /(?:crate|super)\s*::\s*commands\b|use\s+crate\s*::\s*\{[^;]*\bcommands\b/);
}

/**
 * Every changed behavior file is named by the change coverage, whose claims
 * `validateRegistry` holds true. Three kinds of change have nothing a test
 * could execute, and are counted apart: a deleted file (the files that used
 * it changed too and are checked), a file that only declares (TypeScript
 * types, Rust `mod` and `use`: the compilers check it), and a Safari mirror,
 * which this check compares byte for byte with its bound source.
 */
export function verifyChangeCoverage(registry, paths, {
  exists = path => existsSync(join(repository, path)),
  declarationsOnly = path => path.endsWith('.d.ts'),
  explain = null,
} = {}) {
  const listed = new Set(registry.changeCoverage.flatMap(item => item.paths));
  const mirrors = new Map(SAFARI_MIRRORS.map(item => [item.mirror, item.source]));
  const result = { checked: [], deleted: [], declarations: [], mirrors: [] };
  const unbound = [];
  for (const path of paths.filter(isBehaviorPath)) {
    if (!exists(path)) result.deleted.push(path);
    else if (listed.has(path)) result.checked.push(path);
    else if (mirrors.has(path) && listed.has(mirrors.get(path))) result.mirrors.push(path);
    else if (declarationsOnly(path)) result.declarations.push(path);
    else unbound.push(path);
  }
  const notes = unbound.length && explain ? explain(unbound) : new Map();
  requireCondition(unbound.length === 0, `Changed files with no requirement and no test that imports, reads or launches them (${unbound.length}):\n${
    unbound.map(path => (notes.get(path) ? `${path}: ${notes.get(path)}` : path)).join('\n')}`);
  return result;
}

/**
 * The revision this branch grew from: the explicit `--base`, else where it
 * meets its upstream, else where it meets origin/main. Comparing with HEAD
 * saw only uncommitted edits, so committed work passed unchecked (А10.4).
 */
export function changeBase(root, requested, execute = spawnSync) {
  for (const candidate of requested ? [requested] : ['@{upstream}', 'origin/main']) {
    const base = execute('git', ['merge-base', 'HEAD', candidate], { cwd: root, encoding: 'utf8' });
    if (base.status === 0 && base.stdout.trim()) return base.stdout.trim();
  }
  throw new Error(requested
    ? `Cannot find the base revision: ${requested}`
    : 'Cannot find the base revision: pass --base <revision>');
}

/**
 * After a push the automatic base is HEAD itself, so pushed commits are not
 * compared. Say so instead of passing silently (SPEC_AUDIT_FIXES.md, Б6.3).
 */
export function automaticBaseNotice(paths, requested) {
  if (requested || paths.length > 0) return null;
  return 'No changes since the upstream revision: pushed commits are not compared. Pass --base <revision> to check them.';
}

/** Every path changed since `base`: commits, staged and unstaged edits, new files. */
export function changedPaths(root, base, execute = spawnSync) {
  const changed = execute('git', ['diff', '--name-only', base], { cwd: root, encoding: 'utf8' });
  requireCondition(changed.status === 0, 'Cannot inspect changed behavior');
  const untracked = execute('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  requireCondition(untracked.status === 0, 'Cannot inspect new behavior');
  return [...new Set(`${changed.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean))];
}

async function evidenceJson(root, entry) {
  requireCondition(entry?.path && HEX.test(entry.sha256), 'Missing hashed evidence');
  const bytes = await readFile(await evidencePath(root, entry.path));
  requireCondition(sha256(bytes) === entry.sha256, `Evidence changed: ${entry.path}`);
  return JSON.parse(bytes);
}

function verifyReportArtifacts(report, artifacts, id) {
  requireCondition(report.artifactIds?.length > 0 && report.artifacts?.length > 0, `${id}: artifact linkage missing`);
  for (const artifactId of report.artifactIds) {
    const actual = artifacts.find(item => item.id === artifactId);
    const observed = report.artifacts.find(item => item.id === artifactId);
    requireCondition(actual && observed && ['sha256', 'version', 'buildId', 'commit', 'installedBundleSha256']
      .every(key => observed[key] === actual[key]), `${id}: report belongs to different artifact bytes or build: ${artifactId}`);
  }
}

/** Release evidence is accepted only for current bytes and a clean commit. */
export async function verifyRelease(registry, root = repository, options = {}) {
  await validateRegistry(registry, root, options.reach);
  const incomplete = [...registry.principles, ...registry.acceptance, ...registry.levels].filter(item => item.result !== 'passed');
  requireCondition(!incomplete.length, `Release blocked. Missing successful evidence: ${incomplete.map(item => `${item.id} (${item.result})`).join(', ')}`);
  const release = registry.release;
  requireCondition(release && /^[a-f0-9]{40}$/.test(release.commit), 'Release commit missing');
  const execute = options.execute ?? spawnSync;
  const head = execute('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  requireCondition(head.status === 0 && head.stdout.trim() === release.commit, 'Evidence belongs to a different commit');
  const status = execute('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  requireCondition(status.status === 0 && !status.stdout.trim(), 'Release evidence requires an unchanged working tree');
  requireCondition(release.environment?.os && release.environment?.browser && release.environment?.architecture, 'Environment not recorded');
  requireCondition(release.fixtureSha256 === sha256(await readFile(fixturePath)), 'Fixture changed after acceptance');
  const channelConfiguration = await evidenceJson(root, release.channelConfiguration);
  const trustedConfiguration = prepareUpdateChannel({
    endpoint: channelConfiguration.plugins?.updater?.endpoints?.[0],
    publicKey: channelConfiguration.plugins?.updater?.pubkey,
    appleSigningIdentity: channelConfiguration.bundle?.macOS?.signingIdentity,
  });
  const trustedPublicKey = Buffer.from(trustedConfiguration.plugins.updater.pubkey, 'base64').toString('utf8').trim().split(/\r?\n/)[1];
  const artifacts = release.artifacts;
  requireCondition(Array.isArray(artifacts) && new Set(artifacts.map(item => item.id)).size === artifacts.length, 'Artifact IDs missing or duplicated');
  for (const component of COMPONENTS) requireCondition(artifacts.some(item => item.component === component && item.role === 'candidate'), `Candidate artifact missing: ${component}`);
  requireCondition(artifacts.some(item => item.role === 'baseline') && artifacts.some(item => item.role === 'previous') &&
    artifacts.some(item => item.role === 'defective'), 'B0, previous and defective artifacts required');
  for (const artifact of artifacts) {
    requireCondition(HEX.test(artifact.sha256) && artifact.version && artifact.buildId && artifact.commit && artifact.channel, `Artifact identity incomplete: ${artifact.id}`);
    if (artifact.role === 'candidate') requireCondition(artifact.commit === release.commit, `Candidate commit mismatch: ${artifact.id}`);
    const path = await evidencePath(root, artifact.path);
    requireCondition(await artifactDigest(path) === artifact.sha256, `Artifact bytes changed: ${artifact.id}`);
    if (artifact.component === 'application' && artifact.role !== 'defective') {
      const bundle = await evidencePath(root, artifact.installedBundle);
      requireCondition(HEX.test(artifact.installedBundleSha256) && await artifactDigest(bundle) === artifact.installedBundleSha256,
        `Installed bundle bytes are not bound to evidence: ${artifact.id}`);
      for (const [command, args] of [['codesign', ['--verify', '--deep', '--strict', bundle]], ['spctl', ['--assess', '--type', 'execute', bundle]]]) {
        const verification = execute(command, args, { encoding: 'utf8' });
        requireCondition(verification.status === 0, `Signature/notarization verification failed: ${artifact.id}: ${command}`);
      }
    }
    if (artifact.component === 'application' && artifact.role === 'candidate') {
      const signature = await evidencePath(root, artifact.updateSignature);
      const encodedSignature = await readFile(signature, 'utf8');
      requireCondition(HEX.test(artifact.updateSignatureSha256) && sha256(encodedSignature) === artifact.updateSignatureSha256,
        'Updater signature bytes changed or missing');
      const signatureDocument = Buffer.from(encodedSignature.trim(), 'base64');
      requireCondition(signatureDocument.toString('base64') === encodedSignature.trim() &&
        /^untrusted comment:/m.test(signatureDocument.toString('utf8')) && /^trusted comment:/m.test(signatureDocument.toString('utf8')),
      'Expected a base64 Tauri minisign signature document');
      const temporary = await mkdtemp(join(tmpdir(), 'mine-signature-verify-'));
      try {
        const decodedSignature = join(temporary, 'signature.minisig');
        await writeFile(decodedSignature, signatureDocument, { flag: 'wx' });
        const verification = execute('minisign', ['-Vm', path, '-P', trustedPublicKey, '-x', decodedSignature], { encoding: 'utf8' });
        requireCondition(verification.status === 0, 'Actual updater signature verification failed or verifier unavailable');
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
  for (const entry of [...registry.principles, ...registry.acceptance, ...registry.levels]) {
    requireCondition(entry.evidence?.length > 0, `${entry.id}: missing execution reports`);
    for (const reference of entry.evidence) {
      const report = await evidenceJson(root, reference);
      requireCondition(report.commit === release.commit && report.fixtureSha256 === release.fixtureSha256, `${entry.id}: stale report`);
      requireCondition(report.status === 'passed' && report.exitCode === 0 && report.skipped === 0 && report.failed === 0 && report.flaky === 0, `${entry.id}: failed, skipped or unstable execution`);
      requireCondition(report.executedIds?.includes(entry.id) && report.assertions?.length > 0 && report.command?.length > 0,
        `${entry.id}: execution or behavior assertions missing`);
      verifyReportArtifacts(report, artifacts, entry.id);
      requireCondition(report.kind === 'automatic' || (report.kind === 'manual' && report.reviewer && report.observation), `${entry.id}: automatic/manual evidence unclear`);
      if (entry.id === 'installed-release') requireCondition(report.processPaths?.length > 0 && report.operations?.includes('relaunch'), 'Installed process and relaunch evidence missing');
      if (entry.id === 'A04' || entry.id === 'A05') requireCondition(report.artifactIds.some(id => artifacts.find(item => item.id === id)?.role === 'previous') &&
        report.artifactIds.some(id => artifacts.find(item => item.id === id)?.role === 'candidate'), `${entry.id}: two real releases required`);
    }
  }
  const defect = await evidenceJson(root, release.originalDefect);
  requireCondition(defect.status === 'reproduced' && defect.fixtureSha256 === release.fixtureSha256 && defect.command?.length > 0 && defect.observedFailure &&
    defect.artifactIds?.some(id => artifacts.find(item => item.id === id)?.role === 'defective'), 'Original defect not reproduced on old artifact');
  verifyReportArtifacts(defect, artifacts, 'original-defect');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const registryArgument = process.argv.indexOf('--registry');
    requireCondition(registryArgument < 0 || process.argv[registryArgument + 1], 'Missing --registry path');
    const text = await readFile(registryArgument < 0 ? registryPath : resolve(process.argv[registryArgument + 1]), 'utf8');
    verifyRegistryFormat(text);
    const registry = JSON.parse(text);
    const reach = createReach(repository);
    await validateRegistry(registry, repository, reach); await verifyModuleBoundaries();
    if (process.argv.includes('--release')) await verifyRelease(registry);
    const baseArgument = process.argv.indexOf('--base');
    requireCondition(baseArgument < 0 || process.argv[baseArgument + 1], 'Missing --base revision');
    const requestedBase = baseArgument < 0 ? undefined : process.argv[baseArgument + 1];
    const paths = changedPaths(repository, changeBase(repository, requestedBase));
    // For a file that fails, name the tests that do execute it, or say there is none.
    const explain = unbound => {
      const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repository, encoding: 'utf8' });
      const scripts = Object.keys(JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).scripts);
      const found = reach.testsExecuting(unbound, listed.stdout.split('\n').filter(Boolean), scripts.filter(name => name.startsWith('test:')));
      return new Map(unbound.map(path => [path, found.get(path)?.length
        ? `executed by ${found.get(path).map(item => `${item.test} (${item.command})`).join(', ')}`
        : 'no test executes it']));
    };
    const { checked, deleted, declarations, mirrors } = verifyChangeCoverage(registry, paths,
      { declarationsOnly: path => reach.declarationsOnly(path), explain });
    const notice = automaticBaseNotice(paths, requestedBase);
    if (notice) console.warn(notice);
    await verifyExtensionMirrors();
    // Say what was compared, and that no test ran: the tests pass or fail in
    // their own commands (SPEC_DEEP_AUDIT.md, Е7.7).
    console.log(process.argv.includes('--release')
      ? 'Release evidence matches the registry. No test was run.'
      : [`Registry check passed, no test was run: ${checked.length} changed files are bound to a requirement and to a test that imports, reads or launches them.`,
        mirrors.length ? `${mirrors.length} Safari mirrors equal their bound sources.` : '',
        declarations.length ? `${declarations.length} changed files only declare types or modules: the compilers check them.` : '',
        deleted.length ? `${deleted.length} deleted files have nothing to bind.` : ''].filter(Boolean).join('\n'));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
