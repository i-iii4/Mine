import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cfgHolds, createReach, globPattern, rustTokens } from './test-reach.mjs';

// A small repository: a Cargo workspace, Vitest, node tests and checkers.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mine-test-reach-'));
  const files = {
    'package.json': JSON.stringify({ scripts: {
      'test:node': 'node --test scripts/tool.test.mjs',
      'test:front': 'vitest run',
      'test:front-one': 'vitest run src/a',
      'test:rust': 'node scripts/wrap.mjs cargo test --workspace --all-targets --features extra --locked',
      'test:rust-plain': 'cargo test --workspace --all-targets --locked',
      'test:rust-named': 'cargo test -p demo --lib only_this',
      'test:audit': 'node scripts/audit.mjs',
      'test:all': 'bun run test:node && bun run test:front',
      'build': 'tsc -b && vite build',
      'lint': 'eslint .',
    } }),
    'vite.config.ts': 'export default { test: { include: ["src/**/*.test.{ts,tsx}"] } };\n',
    'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n',
    'tsconfig.app.json': '{ "extends": "./tsconfig.base.json", "include": ["src"] }\n',
    'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }\n',
    'eslint.config.js': 'export default [];\n',
    'Cargo.toml': '[workspace]\nmembers = ["demo"]\n',
    'demo/Cargo.toml': '[package]\nname = "demo"\n\n[features]\ndefault = []\nextra = []\n',
    'demo/build.rs': 'fn main() {}\n',
    'demo/src/lib.rs': [
      'pub mod engine;',
      'pub mod helpers;',
      '#[cfg(feature = "extra")]',
      'pub mod gated;',
      '#[cfg(feature = "absent")]',
      'pub mod never;',
      'pub mod declared;',
    ].join('\n'),
    'demo/src/engine.rs': [
      '// mod commented_out; use crate::never::Ghost;',
      'pub fn run() -> u8 { let text = r#"mod raw_string; crate::never::x"#; let c = \'{\'; text.len() as u8 + c as u8 }',
      'pub fn label<\'a>(value: &\'a str) -> &\'a str { value }',
      '#[cfg(test)]',
      'mod tests;',
    ].join('\n'),
    'demo/src/engine/tests.rs': [
      'use super::*;',
      'use crate::helpers::{self as h};',
      '#[test]',
      'fn runs() { assert_eq!(run(), h::one() + 122); let _ = include_str!("../../fixtures/sample.json"); }',
      '#[test]',
      'fn reads() { let _ = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/read.json")); let _ = concat!(env!("OUT_DIR"), "/fixtures/elsewhere.json"); let _ = "/fixtures/plain.json"; }',
    ].join('\n'),
    'demo/src/helpers.rs': 'pub fn one() -> u8 { 1 }\n',
    'demo/src/gated.rs': '#[test]\nfn gated() {}\n',
    'demo/src/never.rs': '#[test]\nfn never() {}\n',
    'demo/src/declared.rs': 'pub mod inner;\npub use inner::Thing;\n',
    'demo/src/declared/inner.rs': 'pub struct Thing;\n',
    'demo/fixtures/sample.json': '{}\n',
    'demo/fixtures/read.json': '{}\n',
    'demo/fixtures/elsewhere.json': '{}\n',
    'demo/fixtures/plain.json': '{}\n',
    'demo/tests/outside.rs': 'use demo::helpers::one;\n#[test]\nfn outside() { assert_eq!(one(), 1); }\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/a.test.ts': [
      "import { a } from './a';",
      "import type { B } from './b';",
      "import { type C } from './c';",
      "import { mocked } from './mocked';",
      "import { partial } from './partial';",
      "import './style.css';",
      "import raw from './raw.css?raw';",
      "vi.mock('./mocked', () => ({ mocked: 1 }));",
      "vi.mock('./partial', async (importOriginal) => ({ ...(await importOriginal()) }));",
      "const shown = `${'origin'}/page.html`;",
      "const read = 'src/data.json';",
      "const named = { 'src/named.json': 1 };",
      "readFileSync('src/other.json');",
      "const libs = ['one', 'two'].map((name) => readFileSync(`src/lib/${name}.js`, 'utf8'));",
      "for (const file of ['three.js', ...(flag ? ['four.js'] : [])]) readFileSync(`src/lib/${file}`);",
      "const guessed = ['five'].map((name) => readFileSync(`src/lib/${prefix}${name}.js`));",
      "const computed = [prefix, 'six'].map((name) => readFileSync(`src/lib/${name}.js`));",
      'test("a", () => {});',
    ].join('\n'),
    'src/b.ts': 'export type B = 1;\n',
    'src/c.ts': 'export type C = 1;\nexport const used = 1;\n',
    'src/mocked.ts': 'export const mocked = 0;\n',
    'src/partial.ts': 'export const partial = 0;\n',
    'src/style.css': 'a {}\n',
    'src/raw.css': 'b {}\n',
    'src/data.json': '{}\n',
    'src/other.json': '{}\n',
    'src/named.json': '{}\n',
    'src/lib/one.js': '1;\n',
    'src/lib/two.js': '2;\n',
    'src/lib/three.js': '3;\n',
    'src/lib/four.js': '4;\n',
    'src/lib/five.js': '5;\n',
    'src/lib/six.js': '6;\n',
    'src/types.ts': 'export interface Shape { side: number }\nexport type Pair = [number, number];\n',
    'page.html': '<html></html>\n',
    'scripts/tool.mjs': 'export const tool = 1;\n',
    'scripts/tool.test.mjs': "import { tool } from './tool.mjs';\nconst cli = new URL('./cli.mjs', import.meta.url);\n",
    'scripts/cli.mjs': 'console.log(1);\n',
    'scripts/wrap.mjs': 'import { spawnSync } from "node:child_process";\nspawnSync(process.argv[2], process.argv.slice(3));\n',
    'scripts/audit.mjs': "import { spawn } from 'node:child_process';\nspawn(process.execPath, ['scripts/step.mjs']);\nspawn('cargo', ['run', '-p', 'demo', '--bin', 'tool', '--', process.cwd()]);\nconst page = \"import '/src/a.ts';\";\n",
    'scripts/step.mjs': 'console.log(1);\n',
    'demo/src/bin/tool.rs': 'fn main() { println!("{}", demo::helpers::one()); }\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('a script test executes what it imports, reads or launches, and not what it mocks away or only types', () => {
  const root = fixture();
  try {
    const reach = createReach(root);
    // A template over a list of literal names reads each of them.
    for (const path of ['src/a.ts', 'src/partial.ts', 'src/raw.css', 'page.html', 'src/data.json', 'src/other.json', 'src/a.test.ts',
      'src/lib/one.js', 'src/lib/two.js', 'src/lib/three.js', 'src/lib/four.js']) {
      assert.equal(reach.executes('src/a.test.ts', path), true, path);
    }
    // An import of types alone is erased before the test runs.
    // A property name names a file, it does not read one.
    // A template with another substitution, or a list with a computed
    // element, names nothing that can be told without running the test.
    for (const path of ['src/b.ts', 'src/c.ts', 'src/mocked.ts', 'src/style.css', 'src/types.ts', 'src/named.json', 'src/lib/five.js', 'src/lib/six.js']) {
      assert.equal(reach.executes('src/a.test.ts', path), false, path);
    }
    assert.equal(reach.executes('scripts/tool.test.mjs', 'scripts/tool.mjs'), true);
    assert.equal(reach.executes('scripts/tool.test.mjs', 'scripts/cli.mjs'), true);
    assert.equal(reach.executes('scripts/tool.test.mjs', 'scripts/step.mjs'), false);
    // Launching a Cargo binary executes its root file; what that file uses is
    // one step further and does not count.
    assert.equal(reach.executes('scripts/audit.mjs', 'demo/src/bin/tool.rs'), true);
    assert.equal(reach.executes('scripts/audit.mjs', 'demo/src/helpers.rs'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a Rust test executes the modules it names, its parent through super, and included files, but not text in comments or strings', () => {
  const root = fixture();
  try {
    const reach = createReach(root);
    const testFile = 'demo/src/engine/tests.rs';
    assert.equal(reach.executes(testFile, 'demo/src/engine.rs'), true);
    assert.equal(reach.executes(testFile, 'demo/src/helpers.rs'), true);
    assert.equal(reach.executes(testFile, 'demo/fixtures/sample.json'), true);
    assert.equal(reach.executes(testFile, 'demo/fixtures/read.json'), true);
    // Only the manifest directory of `concat!` anchors a leading slash in the
    // crate: another directory, or a bare string, names no file of it.
    assert.equal(reach.executes(testFile, 'demo/fixtures/elsewhere.json'), false);
    assert.equal(reach.executes(testFile, 'demo/fixtures/plain.json'), false);
    assert.equal(reach.executes(testFile, 'demo/src/never.rs'), false);
    assert.equal(reach.executes('demo/src/engine.rs', 'demo/src/never.rs'), false);
    assert.equal(reach.executes('demo/tests/outside.rs', 'demo/src/helpers.rs'), true);
    assert.equal(reach.executes('demo/tests/outside.rs', 'demo/src/engine.rs'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a command runs only the tests it selects', () => {
  const root = fixture();
  try {
    const reach = createReach(root);
    assert.equal(reach.commandRuns('test:node', 'scripts/tool.test.mjs'), true);
    assert.equal(reach.commandRuns('test:node', 'src/a.test.ts'), false);
    assert.equal(reach.commandRuns('test:front', 'src/a.test.ts'), true);
    assert.equal(reach.commandRuns('test:front', 'scripts/tool.test.mjs'), false);
    assert.equal(reach.commandRuns('test:front-one', 'src/a.test.ts'), true);
    assert.equal(reach.commandRuns('test:all', 'scripts/tool.test.mjs'), true);
    // Through a wrapper script, with the feature that compiles `gated`.
    assert.equal(reach.commandRuns('test:rust', 'demo/src/engine/tests.rs'), true);
    assert.equal(reach.commandRuns('test:rust', 'demo/src/gated.rs'), true);
    assert.equal(reach.commandRuns('test:rust', 'demo/tests/outside.rs'), true);
    assert.equal(reach.commandRuns('test:rust', 'scripts/wrap.mjs'), true);
    assert.equal(reach.commandRuns('test:rust-plain', 'demo/src/gated.rs'), false);
    assert.equal(reach.commandRuns('test:rust-plain', 'demo/src/never.rs'), false);
    // A file without tests runs nothing under `cargo test`.
    assert.equal(reach.commandRuns('test:rust-plain', 'demo/src/helpers.rs'), false);
    // Cargo reads the manifest and runs the build script.
    assert.equal(reach.commandRuns('test:rust-plain', 'demo/build.rs'), true);
    assert.equal(reach.commandRuns('test:rust-plain', 'demo/Cargo.toml'), true);
    // A name filter may skip any test of a file: none is taken as run.
    assert.equal(reach.commandRuns('test:rust-named', 'demo/src/engine/tests.rs'), false);
    assert.equal(reach.commandRuns('test:audit', 'scripts/step.mjs'), true);
    assert.equal(reach.commandRuns('test:audit', 'demo/src/bin/tool.rs'), true);
    // A product module the check loads into a page is executed by the check,
    // not run as a test that could vouch for its own imports.
    assert.equal(reach.executes('scripts/audit.mjs', 'src/a.ts'), true);
    assert.equal(reach.commandRuns('test:audit', 'src/a.ts'), false);
    assert.equal(reach.commandRuns('build', 'tsconfig.app.json'), true);
    assert.equal(reach.commandRuns('build', 'tsconfig.base.json'), true);
    assert.equal(reach.commandRuns('lint', 'eslint.config.js'), true);
    assert.equal(reach.commandRuns('lint', 'tsconfig.json'), false);
    assert.throws(() => reach.commandRuns('missing', 'src/a.test.ts'), /No package.json script/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the tests that execute a file are found for a failing registry check', () => {
  const root = fixture();
  try {
    const reach = createReach(root);
    const found = reach.testsExecuting(['src/a.ts', 'src/b.ts'], ['src/a.test.ts', 'scripts/tool.test.mjs', 'src/a.ts'], ['test:node', 'test:front']);
    assert.deepEqual(found.get('src/a.ts'), [{ test: 'src/a.test.ts', command: 'test:front' }]);
    assert.deepEqual(found.get('src/b.ts'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('files that only declare types or modules are told apart from code', () => {
  const root = fixture();
  try {
    const reach = createReach(root);
    assert.equal(reach.declarationsOnly('src/types.ts'), true);
    assert.equal(reach.declarationsOnly('src/b.ts'), true);
    assert.equal(reach.declarationsOnly('src/c.ts'), false);
    assert.equal(reach.declarationsOnly('demo/src/declared.rs'), true);
    assert.equal(reach.declarationsOnly('demo/src/lib.rs'), true);
    assert.equal(reach.declarationsOnly('demo/src/helpers.rs'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Rust tokens skip comments and keep strings, characters and lifetimes apart', () => {
  const tokens = rustTokens('/* mod a; /* nested */ */ let s = r#"mod b;"#; let c = \'"\'; fn f<\'a>() {} // mod c;\nmod d;');
  const identifiers = tokens.filter(token => token.type === 'ident').map(token => token.value);
  assert.deepEqual(identifiers, ['let', 's', 'let', 'c', 'fn', 'f', 'mod', 'd']);
  assert.deepEqual(tokens.filter(token => token.type === 'string').map(token => token.value), ['mod b;']);
});

test('cfg predicates follow the checking machine and refuse unknown names', () => {
  const features = new Set(['desktop']);
  assert.equal(cfgHolds({ op: 'all', items: [{ name: 'test' }, { name: 'target_os', value: 'macos' }] }, { test: true, features }), true);
  assert.equal(cfgHolds({ op: 'not', items: [{ name: 'feature', value: 'desktop' }] }, { test: true, features }), false);
  assert.equal(cfgHolds({ name: 'target_os', value: 'ios' }, { test: true, features }), false);
  assert.throws(() => cfgHolds({ name: 'tokio_unstable' }, { test: true, features }), /Unknown cfg predicate/);
});

test('globs match the way Vitest includes match', () => {
  const pattern = globPattern('src/**/*.test.{ts,tsx}');
  assert.equal(pattern.test('src/a.test.ts'), true);
  assert.equal(pattern.test('src/deep/b.test.tsx'), true);
  assert.equal(pattern.test('src/a.ts'), false);
  assert.equal(pattern.test('extension/a.test.ts'), false);
});
