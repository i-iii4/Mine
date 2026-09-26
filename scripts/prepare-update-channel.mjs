import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validate public release inputs without accepting private signing material. */
export function prepareUpdateChannel(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Update channel configuration must be an object');
  }
  const allowed = new Set(['endpoint', 'publicKey', 'appleSigningIdentity']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unexpected configuration field: ${key}`);
  }
  const { endpoint, publicKey, appleSigningIdentity } = input;
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new Error('Public HTTPS update endpoint is required');
  }
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid update endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || /(^|\.)example\.(com|org|net)$/.test(url.hostname)) {
    throw new Error('Endpoint must be a public HTTPS URL without credentials or a fragment');
  }
  // Tauri uses a base64-encoded minisign public-key document. Never accept a
  // secret-key document or treat a nonempty placeholder as a valid trust root.
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
    throw new Error('Base64 minisign public key is required');
  }
  const decoded = Buffer.from(publicKey, 'base64');
  if (decoded.toString('base64') !== publicKey) throw new Error('Public key encoding is not canonical');
  const lines = decoded.toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^untrusted comment:.*public key/i.test(lines[0])
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(lines[1])) {
    throw new Error('Expected a minisign public-key document, not a secret key');
  }
  const bytes = Buffer.from(lines[1], 'base64');
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString('ascii') !== 'Ed'
      || bytes.toString('base64') !== lines[1]) {
    throw new Error('Invalid minisign public-key payload');
  }
  if (typeof appleSigningIdentity !== 'string'
      || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(appleSigningIdentity)) {
    throw new Error('Apple Developer ID Application signing identity is required');
  }
  return {
    bundle: {
      createUpdaterArtifacts: true,
      macOS: { signingIdentity: appleSigningIdentity, hardenedRuntime: true },
    },
    plugins: { updater: { pubkey: publicKey, endpoints: [url.href] } },
  };
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const [input, output, ...extra] = process.argv.slice(2);
    if (!input || !output || extra.length) {
      throw new Error('Usage: node scripts/prepare-update-channel.mjs INPUT.json OUTPUT.json');
    }
    const config = prepareUpdateChannel(JSON.parse(readFileSync(input, 'utf8')));
    // Refuse overwriting a pre-existing file, including the active app config.
    writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log('Prepared configuration only. Runtime updater, certificate availability, notarization and release acceptance must still be verified.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
