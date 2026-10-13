// A home of its own for the clipper helper a check runs (SPEC_DEEP_AUDIT.md,
// Н12, Е5.17). The helper keeps its derived stores, save journals, config and
// log under $HOME, so a check that ran it with the person's HOME left test
// spaces in ~/Library/Application Support/com.mine.app (`clipper-lifecycle-*`,
// `sc6-*`). With this home everything it writes stays in the run folder.
import { join } from 'node:path';

/** The helper's home inside `run`, where its app data goes, and the
 *  environment to start it with: `env` with HOME replaced. */
export function disposableAppHome(run, env = process.env) {
  const home = join(run, 'home');
  return {
    home,
    appState: join(home, 'Library/Application Support/com.mine.app'),
    env: { ...env, HOME: home },
  };
}
