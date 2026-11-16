// AUDIT_CODE_QUALITY.md, О4: every import of a script names a file or a
// declared package.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { importsOf, scriptFiles, unresolvedImports } from './script-imports.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every import in scripts/ names an existing file or a declared package', () => {
  const files = scriptFiles(root);
  // A check, a page a check shows, and a utility a person runs by hand.
  for (const kind of ['scripts/browser-audits.mjs', 'scripts/fixtures/selection-menu.jsx', 'scripts/import-arena.ts']) {
    assert.ok(files.includes(kind), `${kind} is read`);
  }
  assert.deepEqual(unresolvedImports(root, files), []);
});

test('an import of a missing file or of an undeclared package is reported, wherever it is written', () => {
  const repository = mkdtempSync(join(tmpdir(), 'mine-script-imports-'));
  try {
    const files = {
      'package.json': JSON.stringify({ dependencies: { react: '1' }, devDependencies: { '@scope/tool': '1' } }),
      'src/page.tsx': 'export const Page = null;\n',
      'scripts/helper.mjs': 'export const helper = 1;\n',
      'scripts/good.mjs': [
        "import { readFileSync } from 'node:fs';",
        "import path from 'path';",
        "import React from 'react';",
        "import { client } from 'react/client';",
        "import tool from '@scope/tool/part';",
        "import { helper } from './helper.mjs';",
        "export { helper as again } from './helper.mjs';",
        "const later = await import('./helper.mjs');",
        "const entry = `import { Page } from \"/src/page.tsx\"; import other from \"/src/page\"; fetch(\"/__data\");`;",
        "const address = 'import from \"/not-a-folder/x.js\"';",
      ].join('\n'),
      'scripts/bad.mjs': [
        "import { gone } from './gone.mjs';",
        "export { gone as again } from '../missing.mjs';",
        "const later = await import('./later.mjs');",
        "import left from 'left-pad';",
        "import part from '@scope/other/part';",
        "const entry = `import { Page } from \"/src/moved.tsx\";`;",
        "const lazy = { load: () => 'import(\"/src/lazy.tsx\")' };",
      ].join('\n'),
      'scripts/fixtures/page.jsx': "import { Page } from '../../src/page';\nimport { Gone } from '../../src/gone';\nexport const shown = <Page />;\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
    assert.deepEqual(scriptFiles(repository), ['scripts/bad.mjs', 'scripts/fixtures/page.jsx', 'scripts/good.mjs', 'scripts/helper.mjs']);
    assert.deepEqual(unresolvedImports(repository), [
      'scripts/bad.mjs: imports ./gone.mjs, which is not a file',
      'scripts/bad.mjs: imports ../missing.mjs, which is not a file',
      'scripts/bad.mjs: imports ./later.mjs, which is not a file',
      'scripts/bad.mjs: imports left-pad, a package package.json does not declare',
      'scripts/bad.mjs: imports @scope/other/part, a package package.json does not declare',
      'scripts/bad.mjs: writes an import of /src/moved.tsx into a page, which is not a file',
      'scripts/bad.mjs: writes an import of /src/lazy.tsx into a page, which is not a file',
      'scripts/fixtures/page.jsx: imports ../../src/gone, which is not a file',
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('an import inside a comment is not an import', () => {
  assert.deepEqual(importsOf('a.mjs', "// import x from './gone.mjs';\n/* import('./gone.mjs') */\nexport const a = 1;\n"), { code: [], written: [] });
});
