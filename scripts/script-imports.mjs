// The imports of the files in scripts/, read from the sources
// (AUDIT_CODE_QUALITY.md, О4). No compiler reads a script: an import of a
// file that was moved or deleted shows only when the script runs, and a
// script that nothing runs keeps it for weeks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, join, relative, sep } from 'node:path';
import ts from 'typescript';

const SCRIPT_EXTENSIONS = ['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx'];
// What an import without an extension may name, as Vite resolves it.
const RESOLVED_EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.jsx', '/index.ts', '/index.tsx'];
// An import written inside a string: the entry of a page the script builds.
const WRITTEN_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*(["'])(\/[^"'\s]+)\1/g;

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** The script files under `directory`, as paths from `root`. */
export function scriptFiles(root, directory = 'scripts') {
  const found = [];
  const visit = folder => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (SCRIPT_EXTENSIONS.includes(extname(entry.name))) found.push(path.split(sep).join('/'));
    }
  };
  visit(directory);
  return found.sort();
}

/**
 * The imports of one script: `code` are the modules the script itself
 * loads (`import`, `export … from`, `import()` of a literal), `written` are
 * the imports it writes into a page's entry as text, by the site's root.
 */
export function importsOf(path, text) {
  const kind = { '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX, '.ts': ts.ScriptKind.TS }[extname(path)] ?? ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const code = [];
  const written = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      code.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      code.push(node.arguments[0].text);
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(WRITTEN_IMPORT)) written.push(match[2]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { code, written };
}

/** The package a bare specifier names: `react-dom/client` is `react-dom`. */
function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The imports of the scripts under `root` that name nothing: a file that
 * does not exist, or a package that package.json does not declare. An
 * import written into a page is checked when its first folder is one of the
 * repository's, since the page may also ask its server for other addresses.
 * The strings of a test file are left alone: they are the sources of the
 * made-up repositories the test builds.
 */
export function unresolvedImports(root, files = scriptFiles(root)) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
  const resolves = base => RESOLVED_EXTENSIONS.some(extension => isFile(base + extension));
  const problems = [];
  for (const path of files) {
    const { code, written } = importsOf(path, readFileSync(join(root, path), 'utf8'));
    for (const specifier of code) {
      const bare = specifier.replace(/[?#].*$/, '');
      if (bare.startsWith('./') || bare.startsWith('../')) {
        if (!resolves(join(root, dirname(path), bare))) problems.push(`${path}: imports ${specifier}, which is not a file`);
      } else if (bare.startsWith('/')) {
        if (!resolves(join(root, bare))) problems.push(`${path}: imports ${specifier}, which is not a file`);
      } else if (!isBuiltin(bare) && !declared.has(packageName(bare))) {
        problems.push(`${path}: imports ${specifier}, a package package.json does not declare`);
      }
    }
    for (const specifier of /\.test\.[a-z]+$/.test(path) ? [] : written) {
      const bare = specifier.replace(/[?#].*$/, '');
      const first = relative(root, join(root, bare)).split(sep)[0];
      if (existsSync(join(root, first)) && !resolves(join(root, bare))) {
        problems.push(`${path}: writes an import of ${specifier} into a page, which is not a file`);
      }
    }
  }
  return problems;
}
