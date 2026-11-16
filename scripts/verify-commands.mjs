// Which checks of package.json a combined command runs
// (AUDIT_CODE_QUALITY.md, О1 and О5). A check that no combined command runs
// can break and stay broken unnoticed: `test:chrome` and
// `test:selection-menu` did for seven weeks. So every check is run by
// `verify`, or by `verify:built-app`, or is named below with the reason it
// is not. The registry check binds changed files with the same rule
// (scripts/reliability-registry-check.mjs).

/** The combined command every change passes. */
export const VERIFY = 'verify';

/** The combined command of the checks that need the built app or the built
 *  clipper: `verify` builds neither. The registry binds through it only the
 *  scripts it runs itself (scripts/reliability-registry-check.mjs). */
export const BUILT_APP = 'verify:built-app';

/** Checks no combined command runs, each with its reason. */
export const NOT_RUN = {
  'test:native-capture': 'Needs a debug bundle of the app (target/debug/bundle/macos/Mine.app), which no combined command builds.',
  'test:clipper-native-built': 'The check of test:clipper-native-release with the paths it defaults to; verify:built-app runs that one.',
  'test:reliability-source': 'Builds the mine library a second time, without its default features. The test it runs, reliability_external_fixture, runs in test:rust on the fixture it makes itself.',
  'test:reliability-index-source': 'Another name of test:reliability-source.',
  'check:release-evidence': 'The first step of verify:release. It refuses until the release is accepted, and the release is deferred by the user\'s decision.',
  'verify:release': 'The release acceptance itself: the release evidence, verify and verify:built-app.',
  'verify:startup-bundle': 'Needs the release bundle of the app; no combined command builds it.',
  'test:startup:real': 'Starts the built app on the screen and measures its launch: an acceptance a person runs.',
  'test:watch': 'Vitest watching the files for a person at the keyboard; test:frontend runs the same tests once.',
};

/** A package.json script that checks: `test`, `test:*`, `check:*`, `verify`, `verify:*`. */
export function isCheck(name) {
  return /^(?:test|check|verify)(?::|$)/.test(name);
}

/** The command that runs the script `name`: VERIFY, else BUILT_APP, else null. */
export function runBy(reach, name) {
  if (reach.covers(VERIFY, name)) return VERIFY;
  if (name === BUILT_APP || reach.covers(BUILT_APP, name)) return BUILT_APP;
  return null;
}

/**
 * What is wrong with the checks of `scripts` (the package.json scripts):
 * a check no combined command runs and NOT_RUN does not explain, and an
 * entry of NOT_RUN that explains nothing any more.
 */
export function unexplainedChecks(scripts, reach, notRun = NOT_RUN) {
  const problems = [];
  for (const name of Object.keys(scripts).filter(isCheck)) {
    const by = runBy(reach, name);
    const reason = notRun[name];
    if (!by && !(typeof reason === 'string' && reason.trim())) {
      problems.push(`${name}: neither ${VERIFY} nor ${BUILT_APP} runs it, and it has no reason in NOT_RUN`);
    }
    if (by && reason !== undefined) problems.push(`${name}: ${by} runs it, its reason in NOT_RUN is stale`);
  }
  for (const name of Object.keys(notRun)) {
    if (scripts[name] === undefined) problems.push(`${name}: named in NOT_RUN, absent from package.json`);
  }
  return problems;
}
