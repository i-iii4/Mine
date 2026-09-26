import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

// Diagnostic source identity only. Not a signature or a version comparator.
export function sourceBuildIdentity(root) {
  const digest = createHash('sha256');
  function visit(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`Build input must not be a symlink: ${path}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (['dist', 'generated', 'node_modules'].includes(name) || name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
        visit(join(path, name));
      }
    } else if (info.isFile()) {
      const bytes = readFileSync(path);
      const size = Buffer.alloc(8);
      size.writeBigUInt64LE(BigInt(bytes.length));
      digest.update(relative(root, path)).update('\0').update(size).update(bytes);
    }
  }
  for (const input of ['extension', 'src', 'public/fonts', 'package.json', 'bun.lock', 'bun.lockb',
    'vite.extension.config.ts', 'vite.overlay.config.ts', 'scripts/build-extension.mjs',
    'scripts/build-identity.mjs', 'scripts/build-save-core.mjs', 'mine-core/src',
    'mine-core/Cargo.toml', 'core-ffi/src', 'core-ffi/Cargo.toml', 'Cargo.lock']) {
    const path = join(root, input);
    if (existsSync(path)) visit(path);
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const commit = result.status === 0 ? result.stdout.trim() : 'source-archive';
  return { buildId: digest.digest('hex'), commit };
}
