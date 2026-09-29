// Install a locally built Mine.app as the one copy macOS opens.
//
// Earlier installs by hand left previous bundles beside the installed one,
// some under hidden names in /Applications, and the build output stayed
// registered with LaunchServices. macOS then opened any of them for
// "Open Mine" and for Spotlight. This script is the only install path: the
// previous copy goes to the Trash, the build output is unregistered, and
// nothing else is left where macOS looks for applications.
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALLED = '/Applications/Mine.app';
export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const BUSY_HELPERS = ['yt-dlp', 'video-mux-helper'];

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Install `bundle` over /Applications/Mine.app. Every system effect goes through `system`. */
export function installLocalApp(bundle, system) {
  bundle = resolve(bundle);
  if (!system.exists(bundle)) throw new Error(`No built bundle at ${bundle}`);
  // Quitting Mine mid-download would lose a video the person asked for.
  for (const helper of BUSY_HELPERS) {
    if (system.run('/usr/bin/pgrep', ['-x', helper]).status === 0) {
      throw new Error(`A media download is running (${helper}); install after it finishes`);
    }
  }
  system.run('/usr/bin/osascript', ['-e', 'quit app "Mine"']);
  if (!system.waitUntilQuit()) throw new Error('Mine did not quit; the installed copy was left in place');
  let previous = null;
  if (system.exists(INSTALLED)) {
    previous = join(system.trash, `Mine-${stamp(system.now())}.app`);
    system.move(INSTALLED, previous);
  }
  const copied = system.run('/usr/bin/ditto', [bundle, INSTALLED]);
  if (copied.status !== 0) throw new Error(`Copy failed: ${copied.stderr}`);
  const verified = system.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', INSTALLED]);
  if (verified.status !== 0) throw new Error(`Installed copy failed signature verification: ${verified.stderr}`);
  // Only the installed copy stays a candidate for "Open Mine" and Spotlight.
  system.run(LSREGISTER, ['-u', bundle]);
  system.run(LSREGISTER, ['-f', INSTALLED]);
  return { installed: INSTALLED, previous, unregistered: bundle };
}

function realSystem() {
  return {
    trash: join(homedir(), '.Trash'),
    now: () => new Date(),
    exists: existsSync,
    move: renameSync,
    run: (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 }),
    waitUntilQuit: () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (spawnSync('/usr/bin/pgrep', ['-f', '/Applications/Mine.app/Contents/MacOS/mine']).status !== 0) return true;
        spawnSync('/bin/sleep', ['0.5']);
      }
      return false;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const bundle = args.find((arg) => !arg.startsWith('--')) ?? 'target/release/bundle/macos/Mine.app';
    const report = installLocalApp(bundle, realSystem());
    console.log(JSON.stringify(report, null, 2));
    if (args.includes('--open')) spawnSync('/usr/bin/open', [INSTALLED]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
