import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256, fixturePath } from './reliability-source-guard.mjs';
import { prepareUpdateChannel } from './prepare-update-channel.mjs';
import { verifyExtensionMirrors } from './verify-extension-mirrors.mjs';

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

async function validateReference(root, reference) {
  requireCondition(typeof reference === 'string', 'Missing requirement reference');
  const separator = reference.indexOf('#');
  const path = reference.slice(0, separator);
  const heading = reference.slice(separator + 1);
  const source = await readFile(await localFile(root, path), 'utf8');
  requireCondition(heading && source.includes(heading), `Requirement heading missing: ${reference}`);
}

export async function validateRegistry(registry, root = repository) {
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
  requireCondition(registry.changeCoverage?.length > 0, 'No contract coverage for changes');
  for (const coverage of registry.changeCoverage) {
    requireCondition(coverage.paths?.length > 0, 'Empty change coverage');
    await validateReference(root, coverage.requirement);
    for (const test of coverage.tests ?? []) await localFile(root, test);
    requireCondition(coverage.tests?.length > 0 && packageJson.scripts[coverage.command], 'Change coverage lacks an executable check');
  }
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

export function verifyChangeCoverage(registry, paths) {
  const behaviorPaths = paths.filter(path => /\.(?:rs|tsx?|mjs|js|json|toml|swift)$/.test(path) &&
    !/(?:^|\/)(?:package-lock|bun\.lock)/.test(path));
  for (const path of behaviorPaths) {
    requireCondition(registry.changeCoverage.some(item => item.paths.some(candidate =>
      candidate.endsWith('/') ? path.startsWith(candidate) : path === candidate)),
    `Behavior change has no requirement and check: ${path}`);
  }
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
  await validateRegistry(registry, root);
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
    const registry = JSON.parse(await readFile(registryArgument < 0 ? registryPath : resolve(process.argv[registryArgument + 1]), 'utf8'));
    await validateRegistry(registry); await verifyModuleBoundaries();
    if (process.argv.includes('--release')) await verifyRelease(registry);
    const changed = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repository, encoding: 'utf8' });
    requireCondition(changed.status === 0, 'Cannot inspect changed behavior');
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repository, encoding: 'utf8' });
    requireCondition(untracked.status === 0, 'Cannot inspect new behavior');
    verifyChangeCoverage(registry, `${changed.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean));
    await verifyExtensionMirrors();
    console.log(process.argv.includes('--release') ? 'Release evidence verified.' : 'Registry and module boundaries verified. Release acceptance remains separate.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
