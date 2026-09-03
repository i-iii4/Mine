import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const EXTENSION_PAYLOAD_ENTRIES = [
  'manifest.json',
  'background.js',
  'content.js',
  'dist',
  'generated/save-core',
  'icons',
  'lib',
];

export function extensionIdFromManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new Error(`Extension key is missing from ${manifestPath}`);
  }
  return createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

function copyPayload(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of EXTENSION_PAYLOAD_ENTRIES) {
    const sourcePath = join(source, entry);
    if (!existsSync(sourcePath)) {
      throw new Error(`Extension payload is incomplete: ${sourcePath} is missing`);
    }
    cpSync(sourcePath, join(destination, entry), {
      recursive: true,
      filter: path => !basename(path).includes('.test.'),
    });
  }
}

export function replaceExtensionPayload(source, destination) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const transaction = join(parent, `.clipper-extension-${randomUUID()}`);
  const staged = join(transaction, 'new');
  const previous = join(transaction, 'previous');
  mkdirSync(transaction);
  try {
    copyPayload(source, staged);
    const expectedId = extensionIdFromManifest(join(source, 'manifest.json'));
    const stagedId = extensionIdFromManifest(join(staged, 'manifest.json'));
    if (stagedId !== expectedId) {
      throw new Error(`Staged extension identity changed from ${expectedId} to ${stagedId}`);
    }
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return expectedId;
  } finally {
    rmSync(transaction, { recursive: true, force: true });
  }
}
