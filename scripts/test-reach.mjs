// What a test executes and what a package.json command runs, read from the
// sources without running anything (SPEC_SYSTEM_RELIABILITY.md, INV-01;
// SPEC_DEEP_AUDIT.md, Е7.7). A test executes a path when the test itself
// imports, includes, reads or launches it: an import that is not mocked away,
// a Rust module the test names, `include_str!`, a file path in a string. Only
// direct links count: a module the test reaches through another module is
// not executed by that test for the registry, so a registry entry cannot be
// satisfied by naming a test that merely happens to load everything.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import ts from 'typescript';

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// Vitest does not process stylesheets unless asked: importing one runs nothing.
// Reading it as text does.
const TEXT_QUERY = /[?&](?:raw|inline|url)\b/;
const VITE_CONFIG = 'vite.config.ts';
// The Vitest defaults the project does not override.
const VITEST_EXCLUDE = ['**/node_modules/**', '**/dist/**'];
// The machine the checks run on: macOS on Apple silicon (CLAUDE.md, «Environment»).
const TARGET = { target_os: 'macos', target_family: 'unix', target_arch: 'aarch64', unix: true, windows: false, debug_assertions: true };

function toPosix(path) { return path.split(sep).join('/'); }

function inside(root, absolute) {
  const path = relative(root, absolute);
  return path && !path.startsWith('..') && !isAbsolute(path) ? toPosix(path) : null;
}

function isFile(absolute) {
  try { return statSync(absolute).isFile(); } catch { return false; }
}

/** `**`, `*`, `?` and `{a,b}` of a glob as one anchored expression. */
export function globPattern(glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      pattern += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else if (character === '{') {
      const end = glob.indexOf('}', index);
      pattern += `(?:${glob.slice(index + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      index = end;
    } else pattern += character.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

// ---------------------------------------------------------------------------
// JavaScript and TypeScript

function scriptKind(path) {
  switch (extname(path)) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function stringArgument(node, index = 0) {
  const argument = node.arguments?.[index];
  return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : null;
}

function isImportMetaUrl(node) {
  return node && ts.isPropertyAccessExpression(node) && node.name.text === 'url'
    && ts.isMetaProperty(node.expression) && node.expression.name.text === 'meta';
}

/** The strings an array literal can hold: its string elements, and those of
 *  an array or a choice of arrays spread into it. Null when an element is
 *  computed, so nothing is guessed. */
function literalStrings(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalStrings(node.whenTrue);
    const whenFalse = literalStrings(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (!ts.isArrayLiteralExpression(node)) return null;
  const values = [];
  for (const element of node.elements) {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) values.push(element.text);
    else if (ts.isSpreadElement(element)) {
      const spread = literalStrings(element.expression);
      if (!spread) return null;
      values.push(...spread);
    } else return null;
  }
  return values;
}

/** Imports, mocks and strings of one script, before resolution. */
function scriptSyntax(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const loads = [];
  const urls = [];
  const mocks = [];
  const actual = [];
  const strings = [];
  const cargo = [];
  // Module specifiers follow the import rules above, not the string rule.
  const specifiers = new Set();
  // A template whose every substitution is `name`, written once for each
  // value `name` takes: `extension/lib/${name}.js` over `['a', 'b']`.
  function expandTemplates(body, name, values) {
    function find(node) {
      if (ts.isTemplateExpression(node) && node.templateSpans.every(span => ts.isIdentifier(span.expression) && span.expression.text === name)) {
        for (const value of values) strings.push(node.head.text + node.templateSpans.map(span => value + span.literal.text).join(''));
      }
      ts.forEachChild(node, find);
    }
    find(body);
  }
  function visit(node) {
    // A list of literal names walked by `map`, `flatMap` or `forEach`, or by
    // `for … of`: the callback or the loop names a file for each of them.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['map', 'flatMap', 'forEach'].includes(node.expression.name.text)) {
      const values = literalStrings(node.expression.expression);
      const callback = node.arguments[0];
      if (values && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        && callback.parameters[0] && ts.isIdentifier(callback.parameters[0].name)) {
        expandTemplates(callback.body, callback.parameters[0].name.text, values);
      }
    }
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)
      && node.initializer.declarations.length === 1 && ts.isIdentifier(node.initializer.declarations[0].name)) {
      const values = literalStrings(node.expression);
      if (values) expandTemplates(node.statement, node.initializer.declarations[0].name.text, values);
    }
    // `spawn('cargo', ['run', '--bin', …])` and the like launch a Cargo target.
    // An argument computed at run time stays a placeholder.
    if (ts.isCallExpression(node) && stringArgument(node) === 'cargo' && node.arguments[1]
      && ts.isArrayLiteralExpression(node.arguments[1])) {
      cargo.push(node.arguments[1].elements.map(element => (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element) ? element.text : '\u0000')));
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifiers.add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.arguments[0] && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && ['vi', 'jest'].includes(node.expression.expression.text)))) specifiers.add(node.arguments[0]);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = clause && (clause.isTypeOnly || (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)));
      if (!typeOnly) loads.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      loads.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const specifier = stringArgument(node);
      if (specifier !== null) {
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) loads.push(specifier);
        else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && ['vi', 'jest'].includes(callee.expression.text)) {
          const method = callee.name.text;
          if (method === 'mock' || method === 'doMock') {
            // A factory that asks for the original module runs it.
            const factory = node.arguments[1]?.getText(source) ?? '';
            mocks.push({ specifier, keepsOriginal: /\bimport(?:Original|Actual)\b|\brequireActual\b/.test(factory) });
          } else if (method === 'importActual' || method === 'requireActual') actual.push(specifier);
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
      && isImportMetaUrl(node.arguments?.[1])) {
      const specifier = stringArgument(node);
      if (specifier !== null) urls.push(specifier);
    }
    // A property name is a name, not a file the script reads: the keys of a
    // fixture written to a temporary folder name files of that folder.
    const propertyName = node.parent && (ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent)) && node.parent.name === node;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !specifiers.has(node) && !propertyName) strings.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const declarationsOnly = source.statements.every(statement => ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)
    || (ts.isExportDeclaration(statement) && statement.isTypeOnly)
    || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword));
  return { loads, urls, mocks, actual, strings, cargo, declarationsOnly };
}

// ---------------------------------------------------------------------------
// Rust

/** Tokens of Rust source without comments: identifiers, strings, punctuation. */
export function rustTokens(text) {
  const tokens = [];
  const length = text.length;
  let index = 0;
  const word = /[A-Za-z0-9_]/;
  while (index < length) {
    const character = text[index];
    const next = text[index + 1];
    if (/\s/.test(character)) { index++; continue; }
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < length && depth > 0) {
        if (text[index] === '/' && text[index + 1] === '*') { depth++; index += 2; } else if (text[index] === '*' && text[index + 1] === '/') { depth--; index += 2; } else index++;
      }
      continue;
    }
    const previousIsWord = index > 0 && word.test(text[index - 1]);
    const raw = previousIsWord ? null : /^(?:b|c)?r(#*)"/.exec(text.slice(index, index + 64));
    if (raw) {
      const start = index + raw[0].length;
      const close = `"${raw[1]}`;
      const end = text.indexOf(close, start);
      tokens.push({ type: 'string', value: text.slice(start, end < 0 ? length : end) });
      index = end < 0 ? length : end + close.length;
      continue;
    }
    if (character === '"' || (!previousIsWord && (character === 'b' || character === 'c') && next === '"')) {
      let cursor = character === '"' ? index + 1 : index + 2;
      let value = '';
      while (cursor < length && text[cursor] !== '"') {
        if (text[cursor] === '\\') { value += text[cursor + 1] === '"' ? '"' : text.slice(cursor, cursor + 2); cursor += 2; } else value += text[cursor++];
      }
      tokens.push({ type: 'string', value });
      index = cursor + 1;
      continue;
    }
    if (character === "'") {
      // A character literal, or a lifetime or label.
      if (next === '\\') {
        const end = text.indexOf("'", index + 3);
        tokens.push({ type: 'char' });
        index = end < 0 ? length : end + 1;
        continue;
      }
      const width = (text.codePointAt(index + 1) ?? 0) > 0xffff ? 2 : 1;
      if (text[index + 1 + width] === "'") {
        tokens.push({ type: 'char' });
        index += 2 + width;
        continue;
      }
      let cursor = index + 1;
      while (cursor < length && word.test(text[cursor])) cursor++;
      tokens.push({ type: 'lifetime' });
      index = cursor;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let cursor = index;
      while (cursor < length && word.test(text[cursor])) cursor++;
      let value = text.slice(index, cursor);
      if (value === 'r' && text[cursor] === '#' && /[A-Za-z_]/.test(text[cursor + 1] ?? '')) {
        const start = cursor + 1;
        cursor = start;
        while (cursor < length && word.test(text[cursor])) cursor++;
        value = text.slice(start, cursor);
      }
      tokens.push({ type: 'ident', value });
      index = cursor;
      continue;
    }
    if (/[0-9]/.test(character)) {
      const number = /^[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9_]+)?[A-Za-z0-9_]*/.exec(text.slice(index, index + 64));
      tokens.push({ type: 'number' });
      index += number[0].length;
      continue;
    }
    if (character === ':' && next === ':') { tokens.push({ type: 'punct', value: '::' }); index += 2; continue; }
    tokens.push({ type: 'punct', value: character });
    index++;
  }
  return tokens;
}

function matching(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === open) depth++;
    else if (tokens[index].value === close && --depth === 0) return index;
  }
  return tokens.length - 1;
}

/** `cfg(...)` predicate tokens as a tree, or null for another attribute. */
function cfgOf(attribute) {
  if (attribute[0]?.value !== 'cfg' || attribute[1]?.value !== '(') return null;
  let index = 2;
  function predicate() {
    const name = attribute[index++]?.value;
    if (['not', 'any', 'all'].includes(name) && attribute[index]?.value === '(') {
      index++;
      const items = [];
      while (attribute[index] && attribute[index].value !== ')') {
        items.push(predicate());
        if (attribute[index]?.value === ',') index++;
      }
      index++;
      return { op: name, items };
    }
    if (attribute[index]?.value === '=') {
      const value = attribute[index + 1]?.value;
      index += 2;
      return { name, value };
    }
    return { name };
  }
  return predicate();
}

/** Whether `cfg` holds under `config`: `{ test, features }` on the checking machine. */
export function cfgHolds(cfg, config) {
  if (cfg.op === 'not') return !cfgHolds(cfg.items[0], config);
  if (cfg.op === 'any') return cfg.items.some(item => cfgHolds(item, config));
  if (cfg.op === 'all') return cfg.items.every(item => cfgHolds(item, config));
  if (cfg.name === 'test' && cfg.value === undefined) return config.test;
  if (cfg.name === 'feature') return config.features.has(cfg.value);
  if (cfg.value === undefined && typeof TARGET[cfg.name] === 'boolean') return TARGET[cfg.name];
  if (cfg.value !== undefined && typeof TARGET[cfg.name] === 'string') return TARGET[cfg.name] === cfg.value;
  throw new Error(`Unknown cfg predicate: ${cfg.name}${cfg.value === undefined ? '' : ` = "${cfg.value}"`}`);
}

/** Expand `use` trees into paths: `a::{b, c::*}` gives `a::b` and the glob `a::c`. */
function useTree(tokens, index, prefix, out) {
  const segments = [...prefix];
  if (tokens[index]?.value === '::') index++;
  for (;;) {
    const token = tokens[index];
    if (token?.value === '*') { out.push({ segments, glob: true }); return index + 1; }
    if (token?.value === '{') {
      index++;
      while (index < tokens.length && tokens[index].value !== '}') {
        index = useTree(tokens, index, segments, out);
        if (tokens[index]?.value === ',') index++;
      }
      return index + 1;
    }
    if (token?.type !== 'ident') return index + 1;
    index++;
    // `a::{self}` names `a` itself; a leading `self::` stays a relative path.
    const itself = token.value === 'self' && segments.length > 0 && tokens[index]?.value !== '::';
    if (!itself) segments.push(token.value);
    if (tokens[index]?.value === '::') { index++; continue; }
    let alias = null;
    if (tokens[index]?.value === 'as') { alias = tokens[index + 1]?.value ?? null; index += 2; }
    out.push({ segments, alias });
    return index;
  }
}

const ITEM_KEYWORDS = new Set(['fn', 'struct', 'enum', 'impl', 'trait', 'const', 'static', 'type', 'union', 'macro_rules']);

/** Module declarations, `use` paths, other paths, strings and tests of one Rust file. */
function rustSyntax(text) {
  const tokens = rustTokens(text);
  const facts = { modules: [], uses: [], paths: [], strings: [], manifestPaths: [], tests: 0, innerCfgs: [], declarationsOnly: true };
  const scopes = [];
  let attributes = [];
  const scope = () => scopes.filter(item => item.module).map(item => item.module);
  const scopeAttributes = () => scopes.filter(item => item.module).flatMap(item => item.attributes);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'string') {
      facts.strings.push(token.value);
      // `concat!(env!("CARGO_MANIFEST_DIR"), "/path")`: a path from the
      // directory of the crate's manifest, the way a test names its files.
      const before = tokens.slice(Math.max(0, index - 9), index).map(item => (item.type === 'string' ? `"${item.value}"` : item.value));
      if (before.join(' ') === 'concat ! ( env ! ( "CARGO_MANIFEST_DIR" ) ,') facts.manifestPaths.push(token.value);
      continue;
    }
    if (token.value === '#') {
      const inner = tokens[index + 1]?.value === '!';
      const open = index + (inner ? 2 : 1);
      if (tokens[open]?.value === '[') {
        const end = matching(tokens, open, '[', ']');
        const attribute = tokens.slice(open + 1, end);
        for (const item of attribute) if (item.type === 'string') facts.strings.push(item.value);
        if (inner) {
          const cfg = cfgOf(attribute);
          if (cfg && scopes.length === 0) facts.innerCfgs.push(cfg);
        } else attributes.push(attribute);
        // `#[test]`, or a runner's `#[tokio::test]`.
        if (!inner && attribute.at(-1)?.value === 'test' && (attribute.length === 1 || attribute.at(-2)?.value === '::')) facts.tests++;
        index = end;
        continue;
      }
    }
    if (token.type === 'ident' && token.value === 'mod' && tokens[index + 1]?.type === 'ident') {
      const name = tokens[index + 1].value;
      const after = tokens[index + 2]?.value;
      if (after === ';') {
        facts.modules.push({ name, scope: scope(), attributes: [...scopeAttributes(), ...attributes] });
        attributes = [];
        index += 2;
        continue;
      }
      if (after === '{') {
        scopes.push({ module: name, attributes });
        attributes = [];
        index += 2;
        continue;
      }
    }
    if (token.type === 'ident' && token.value === 'use') {
      const paths = [];
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor].value !== ';') {
        cursor = useTree(tokens, cursor, [], paths);
        if (tokens[cursor]?.value === ',') cursor++;
      }
      for (const path of paths) facts.uses.push({ ...path, scope: scope() });
      attributes = [];
      index = cursor;
      continue;
    }
    // Anything but module declarations, `use` and visibility is code.
    if (!(token.type === 'ident' && ['pub', 'crate', 'super', 'self', 'in'].includes(token.value))
      && !['(', ')', '::', ';'].includes(token.value)) facts.declarationsOnly = false;
    if (token.value === '{') { scopes.push({ module: null }); attributes = []; continue; }
    if (token.value === '}') { scopes.pop(); attributes = []; continue; }
    if (token.value === ';' || (token.type === 'ident' && ITEM_KEYWORDS.has(token.value))) { attributes = []; continue; }
    if (token.type === 'ident' && tokens[index + 1]?.value === '::' && tokens[index - 1]?.value !== '::') {
      const segments = [token.value];
      let cursor = index + 1;
      while (tokens[cursor]?.value === '::' && tokens[cursor + 1]?.type === 'ident') {
        segments.push(tokens[cursor + 1].value);
        cursor += 2;
      }
      facts.paths.push({ segments, scope: scope() });
      index = cursor - 1;
    }
  }
  return facts;
}

// The subset of TOML the workspace manifests use: tables, arrays of tables,
// strings, booleans and arrays of strings.
function cargoManifest(text) {
  const manifest = {};
  let table = manifest;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const array = /^\[\[([^\]]+)\]\]$/.exec(line);
    const plain = /^\[([^\]]+)\]$/.exec(line);
    if (array || plain) {
      const keys = (array ?? plain)[1].split('.').map(key => key.trim().replace(/^"|"$/g, ''));
      let parent = manifest;
      for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
      const last = keys.at(-1);
      if (array) { parent[last] ??= []; table = {}; parent[last].push(table); } else table = parent[last] ??= {};
      continue;
    }
    const assignment = /^("?[\w.-]+"?)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    let value = assignment[2];
    if (value.startsWith('[')) {
      while (!value.includes(']') && index + 1 < lines.length) value += ` ${lines[++index].replace(/(^|\s)#.*$/, '').trim()}`;
      table[assignment[1].replace(/"/g, '')] = [...value.matchAll(/"([^"]*)"/g)].map(match => match[1]);
    } else if (value.startsWith('"')) table[assignment[1].replace(/"/g, '')] = value.slice(1, value.indexOf('"', 1));
    else if (value === 'true' || value === 'false') table[assignment[1].replace(/"/g, '')] = value === 'true';
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Commands

function shellWords(step) {
  const words = [];
  for (const match of step.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

const WRAPPED_PROGRAMS = new Set(['cargo', 'node', 'bun', 'bunx', 'npm', 'vitest']);
// The scripts of checks live in scripts/.
const CHECK_SCRIPT = /^scripts\/.+\.(?:mjs|cjs|js|sh)$/;

function shellSteps(command) {
  return command.split(/&&|\|\||;|\|/).map(step => step.trim()).filter(Boolean);
}

export function createReach(root) {
  const files = new Map();
  const read = path => {
    if (!files.has(path)) files.set(path, readFileSync(join(root, path), 'utf8'));
    return files.get(path);
  };
  const packageJson = JSON.parse(read('package.json'));

  /** A path mentioned in a string: relative to the file, the package or the repository. */
  function mentionedPaths(path, strings, bases) {
    const found = new Set();
    for (const text of strings) {
      for (const raw of new Set([text.trim(), ...text.split(/[\s"'`(),;=<>]+/)])) {
        const token = raw.replace(/[?#].*$/, '').replace(/^file:\/\//, '');
        if (!token || !/\.[A-Za-z0-9]+$/.test(token) || token.length > 300) continue;
        // A leading slash is the root of the site Vite serves. Rust's
        // `concat!(env!("CARGO_MANIFEST_DIR"), "/…")` is read apart, in `rustSyntax`.
        const candidates = token.startsWith('/')
          ? [join(root, token.slice(1))]
          : [join(root, dirname(path), token), ...bases.map(base => join(root, base, token))];
        for (const candidate of candidates) {
          const relativePath = inside(root, candidate);
          if (relativePath && relativePath !== path && isFile(candidate)) found.add(relativePath);
        }
      }
    }
    return found;
  }

  function resolveSpecifier(from, specifier) {
    const bare = specifier.replace(/\?.*$/, '');
    let base;
    if (bare.startsWith('./') || bare.startsWith('../')) base = join(root, dirname(from), bare);
    else if (bare.startsWith('@/')) base = join(root, 'src', bare.slice(2));
    else if (bare.startsWith('/')) base = join(root, bare.slice(1));
    else return null;
    const candidates = [base, ...SCRIPT_EXTENSIONS.map(extension => base + extension),
      ...SCRIPT_EXTENSIONS.map(extension => join(base, `index${extension}`))];
    // TypeScript sources imported under the name of their output.
    const script = /\.(m?)jsx?$/.exec(base);
    if (script) candidates.push(base.replace(/\.(m?)jsx?$/, `.${script[1]}ts`), base.replace(/\.(m?)jsx?$/, `.${script[1]}tsx`));
    for (const candidate of candidates) if (isFile(candidate)) return inside(root, candidate);
    return null;
  }

  const scriptCache = new Map();
  const launchCache = new Map();
  /** Paths one script loads itself, or names as files. */
  function scriptReach(path) {
    if (scriptCache.has(path)) return scriptCache.get(path);
    const launches = new Set();
    const syntax = scriptSyntax(path, read(path));
    const resolve = specifier => resolveSpecifier(path, specifier);
    const original = new Set(syntax.actual.map(resolve).filter(Boolean));
    for (const mock of syntax.mocks) if (mock.keepsOriginal) original.add(resolve(mock.specifier));
    const mocked = new Set(syntax.mocks.filter(mock => !mock.keepsOriginal).map(mock => resolve(mock.specifier)).filter(Boolean));
    const reach = new Set();
    for (const specifier of syntax.loads) {
      const target = resolve(specifier);
      if (!target || (mocked.has(target) && !original.has(target))) continue;
      if (target.endsWith('.css') && !TEXT_QUERY.test(specifier)) continue;
      reach.add(target);
    }
    for (const item of original) if (item) reach.add(item);
    for (const specifier of syntax.urls) {
      const target = inside(root, join(root, dirname(path), specifier.replace(/[?#].*$/, '')));
      if (target && isFile(join(root, target))) reach.add(target);
    }
    for (const mentioned of mentionedPaths(path, syntax.strings, [''])) reach.add(mentioned);
    // A Cargo binary the script runs: its root file, which names the rest.
    for (const args of syntax.cargo) {
      if (args[0] !== 'run') continue;
      const options = cargoRuns('run', args.slice(1), null);
      for (const target of loadWorkspace().targets) {
        if (target.kind === 'bin' && options.bins.includes(target.name)
          && (options.packages.length === 0 || options.packages.includes(target.packageName))) {
          reach.add(target.root);
          launches.add(target.root);
        }
      }
    }
    for (const item of reach) if (CHECK_SCRIPT.test(item)) launches.add(item);
    scriptCache.set(path, reach);
    launchCache.set(path, launches);
    return reach;
  }

  /** What a check script runs as part of the check: the scripts of the
   *  checks it loads or starts, and the Cargo binaries it starts. A module of
   *  the product it loads is executed by the script, not run as a test. */
  function scriptLaunches(path) {
    scriptReach(path);
    return launchCache.get(path);
  }

  // -- Rust workspace -------------------------------------------------------

  let workspace = null;
  const rustCache = new Map();
  const rustFacts = path => {
    if (!rustCache.has(path)) rustCache.set(path, rustSyntax(read(path)));
    return rustCache.get(path);
  };

  function loadWorkspace() {
    if (workspace) return workspace;
    const members = cargoManifest(read('Cargo.toml')).workspace?.members ?? [];
    const targets = [];
    for (const member of members) {
      const manifest = cargoManifest(read(`${member}/Cargo.toml`));
      const packageName = manifest.package.name;
      const features = manifest.features ?? {};
      const libRoot = `${member}/${manifest.lib?.path ?? 'src/lib.rs'}`;
      const libCrate = (manifest.lib?.name ?? packageName).replace(/-/g, '_');
      const base = { member, packageName, features, libCrate };
      if (isFile(join(root, libRoot))) targets.push({ ...base, kind: 'lib', name: libCrate, crate: libCrate, root: libRoot, requiredFeatures: [] });
      const declared = (manifest.bin ?? []).map(bin => ({ name: bin.name, root: `${member}/${bin.path ?? `src/bin/${bin.name}.rs`}`, requiredFeatures: bin['required-features'] ?? [] }));
      const automatic = [];
      if (isFile(join(root, member, 'src/main.rs'))) automatic.push({ name: packageName, root: `${member}/src/main.rs`, requiredFeatures: [] });
      const binDirectory = join(root, member, 'src/bin');
      if (existsSync(binDirectory)) {
        for (const entry of readdirSync(binDirectory)) if (entry.endsWith('.rs')) automatic.push({ name: basename(entry, '.rs'), root: `${member}/src/bin/${entry}`, requiredFeatures: [] });
      }
      for (const bin of [...declared, ...automatic.filter(item => !declared.some(other => other.root === item.root))]) {
        targets.push({ ...base, kind: 'bin', name: bin.name, crate: bin.name.replace(/-/g, '_'), root: bin.root, requiredFeatures: bin.requiredFeatures });
      }
      const testDirectory = join(root, member, 'tests');
      if (existsSync(testDirectory)) {
        for (const entry of readdirSync(testDirectory)) if (entry.endsWith('.rs')) targets.push({ ...base, kind: 'test', name: basename(entry, '.rs'), crate: basename(entry, '.rs'), root: `${member}/tests/${entry}`, requiredFeatures: [] });
      }
    }
    for (const target of targets) {
      target.modules = new Map();
      walkModules(target, target.root, [], [], true);
    }
    workspace = { targets, libraries: new Map(targets.filter(target => target.kind === 'lib').map(target => [target.crate, target])) };
    return workspace;
  }

  function walkModules(target, file, segments, conditions, ownsDirectory) {
    const facts = rustFacts(file);
    const here = [...conditions, ...facts.innerCfgs];
    target.modules.set(segments.join('::'), { file, segments, conditions: here });
    for (const declaration of facts.modules) {
      const cfgs = declaration.attributes.map(cfgOf).filter(Boolean);
      const pathAttribute = declaration.attributes.find(attribute => attribute[0]?.value === 'path' && attribute[1]?.value === '=');
      let child;
      if (pathAttribute) child = join(root, dirname(file), pathAttribute[2].value);
      else {
        const directory = join(root, ownsDirectory ? dirname(file) : join(dirname(file), basename(file, '.rs')), ...declaration.scope);
        child = isFile(join(directory, `${declaration.name}.rs`)) ? join(directory, `${declaration.name}.rs`) : join(directory, declaration.name, 'mod.rs');
      }
      const childPath = inside(root, child);
      if (!childPath || !isFile(child)) continue;
      walkModules(target, childPath, [...segments, ...declaration.scope, declaration.name], [...here, ...cfgs],
        Boolean(pathAttribute) || basename(childPath) === 'mod.rs');
    }
  }

  function placements(path) {
    return loadWorkspace().targets.flatMap(target => [...target.modules.values()]
      .filter(module => module.file === path).map(module => ({ target, module })));
  }

  const rustReachCache = new Map();
  /** Files one Rust file names: modules through paths and `use`, files through strings. */
  function rustReach(path) {
    if (rustReachCache.has(path)) return rustReachCache.get(path);
    const facts = rustFacts(path);
    const { libraries } = loadWorkspace();
    const reach = new Set();
    for (const { target, module } of placements(path)) {
      const aliases = new Map();
      const resolve = (segments, scope, depth = 0) => {
        const here = [...module.segments, ...scope];
        let owner = target;
        let full;
        const [first] = segments;
        if (first === 'crate') full = segments.slice(1);
        else if (first === 'self') full = [...here, ...segments.slice(1)];
        else if (first === 'super') {
          let count = 0;
          while (segments[count] === 'super') count++;
          full = [...here.slice(0, Math.max(0, here.length - count)), ...segments.slice(count)];
        } else if (libraries.has(first)) { owner = libraries.get(first); full = segments.slice(1); }
        else if (aliases.has(first) && depth < 8) {
          const alias = aliases.get(first);
          return resolve([...alias.segments, ...segments.slice(1)], alias.scope, depth + 1);
        } else if (target.modules.has([...here, first].join('::'))) full = [...here, ...segments];
        else return null;
        for (let count = full.length; count >= 0; count--) {
          const found = owner.modules.get(full.slice(0, count).join('::'));
          if (found) return { owner, file: found.file };
        }
        return null;
      };
      for (const use of facts.uses) {
        const name = use.alias ?? use.segments.at(-1);
        if (!use.glob && name && name !== '_') aliases.set(name, { segments: use.segments, scope: use.scope });
      }
      for (const item of [...facts.uses, ...facts.paths]) {
        const resolved = resolve(item.segments, item.scope);
        if (resolved && resolved.file !== path) reach.add(resolved.file);
      }
      for (const mentioned of mentionedPaths(path, facts.strings, [target.member, ''])) reach.add(mentioned);
      for (const manifestPath of facts.manifestPaths) {
        const named = inside(root, join(root, target.member, manifestPath.replace(/[?#].*$/, '')));
        if (named && named !== path && isFile(join(root, named))) reach.add(named);
      }
    }
    if (placements(path).length === 0) for (const mentioned of mentionedPaths(path, facts.strings, [''])) reach.add(mentioned);
    rustReachCache.set(path, reach);
    return reach;
  }

  function enabledFeatures(target, requested, defaults) {
    const enabled = new Set();
    const add = feature => {
      if (enabled.has(feature)) return;
      enabled.add(feature);
      for (const implied of target.features[feature] ?? []) if (target.features[implied]) add(implied);
    };
    if (defaults) add('default');
    for (const feature of requested) if (target.features[feature]) add(feature);
    return enabled;
  }

  // -- Commands -------------------------------------------------------------

  let vitestConfig = null;
  function vitest() {
    if (vitestConfig) return vitestConfig;
    const source = ts.createSourceFile(VITE_CONFIG, read(VITE_CONFIG), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lists = { include: null, exclude: [] };
    function visit(node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'test' && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          const key = property.name?.getText(source);
          if ((key === 'include' || key === 'exclude') && ts.isArrayLiteralExpression(property.initializer)) {
            lists[key] = property.initializer.elements.filter(ts.isStringLiteral).map(element => element.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!lists.include) throw new Error(`${VITE_CONFIG}: no test.include list`);
    vitestConfig = { include: lists.include.map(globPattern), exclude: [...VITEST_EXCLUDE, ...lists.exclude].map(globPattern) };
    return vitestConfig;
  }

  /** How one step of a command runs tests, as a predicate on a test path. */
  function stepRuns(step, seen) {
    const words = shellWords(step);
    while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words.shift();
    const [program, ...rest] = words;
    if ((program === 'bun' || program === 'npm') && rest[0] === 'run' && rest[1]) return scriptRuns(rest[1], seen);
    if (program === 'node' && rest[0] === '--test') {
      const listed = new Set(rest.slice(1).filter(word => !word.startsWith('-')));
      return test => listed.has(test);
    }
    if (program === 'node' || program === 'bash' || program === 'sh') {
      const at = rest.findIndex(word => !word.startsWith('-'));
      if (at < 0) return () => false;
      const script = rest[at];
      // A wrapper runs the command it is given: after `--`, or a known program.
      const args = rest.slice(at + 1);
      const separator = args.indexOf('--');
      const nested = separator >= 0 ? args.slice(separator + 1)
        : WRAPPED_PROGRAMS.has(args[0]) ? args : [];
      const inner = nested.length ? stepRuns(nested.map(word => (/\s/.test(word) ? `"${word}"` : word)).join(' '), seen) : () => false;
      return test => test === script || inner(test)
        || (SCRIPT_EXTENSIONS.includes(extname(script)) && isFile(join(root, script)) && scriptLaunches(script).has(test));
    }
    if (program === 'vitest' || (program === 'bunx' && rest[0] === 'vitest')) {
      const args = program === 'vitest' ? rest : rest.slice(1);
      const filters = args.filter(word => word !== 'run' && !word.startsWith('-'));
      const { include, exclude } = vitest();
      return test => include.some(pattern => pattern.test(test)) && !exclude.some(pattern => pattern.test(test))
        && (filters.length === 0 || filters.some(filter => test.includes(filter)));
    }
    if (program === 'cargo' && (rest[0] === 'test' || rest[0] === 'run')) return cargoRuns(rest[0], rest.slice(1), step);
    // Checkers that run their configuration: TypeScript projects and ESLint.
    if (program === 'tsc' || (program === 'bunx' && rest[0] === 'tsc')) {
      const args = program === 'tsc' ? rest : rest.slice(1);
      const project = args.find((word, index) => !word.startsWith('-') && ['-p', '--project', '-b', '--build'].includes(args[index - 1] ?? ''))
        ?? args.find(word => word.endsWith('.json')) ?? 'tsconfig.json';
      const projects = typescriptProjects(project);
      return test => projects.has(test);
    }
    if (program === 'eslint' || (program === 'bunx' && rest[0] === 'eslint')) return test => test === 'eslint.config.js';
    return () => false;
  }

  function cargoRuns(subcommand, args, step) {
    const options = { packages: [], workspace: false, features: [], defaults: true, kinds: new Set(), bins: [], tests: [], filters: [] };
    const end = args.indexOf('--');
    const own = end < 0 ? args : args.slice(0, end);
    for (let index = 0; index < own.length; index++) {
      const word = own[index];
      const value = () => own[++index];
      if (word === '-p' || word === '--package') options.packages.push(value());
      else if (word === '--workspace' || word === '--all') options.workspace = true;
      else if (word === '--features' || word === '-F') options.features.push(...value().split(/[,\s]+/));
      else if (word === '--no-default-features') options.defaults = false;
      else if (word === '--all-targets') ['lib', 'bin', 'test'].forEach(kind => options.kinds.add(kind));
      else if (word === '--lib') options.kinds.add('lib');
      else if (word === '--bins') options.kinds.add('bin');
      else if (word === '--tests') options.kinds.add('test');
      else if (word === '--bin') options.bins.push(value());
      else if (word === '--test') options.tests.push(value());
      else if (['--locked', '--quiet', '-q', '--release', '--offline', '--frozen'].includes(word)) continue;
      else if (word.startsWith('-')) throw new Error(`Cannot tell which tests run: unknown cargo option ${word} in "${step}"`);
      else options.filters.push(word);
    }
    if (step === null) return options;
    const { targets } = loadWorkspace();
    const selected = targets.filter(target => options.workspace || options.packages.length === 0 || options.packages.includes(target.packageName));
    // Cargo reads the manifests and runs the build script of what it builds.
    const support = new Set(['Cargo.toml']);
    for (const target of selected) {
      support.add(`${target.member}/Cargo.toml`);
      if (isFile(join(root, target.member, 'build.rs'))) support.add(`${target.member}/build.rs`);
    }
    if (subcommand === 'run') {
      const roots = new Set(selected.filter(target => target.kind === 'bin' && (options.bins.length === 0 || options.bins.includes(target.name))).map(target => target.root));
      return test => roots.has(test) || support.has(test);
    }
    // A name filter runs some tests of a file and not others: no file counts.
    if (options.filters.length) return test => support.has(test);
    const kinds = options.kinds.size || options.bins.length || options.tests.length ? options.kinds : new Set(['lib', 'bin', 'test']);
    const built = selected.filter(target => kinds.has(target.kind) || (target.kind === 'bin' && options.bins.includes(target.name))
      || (target.kind === 'test' && options.tests.includes(target.name)));
    const compiled = new Set();
    for (const target of built) {
      const features = enabledFeatures(target, options.features, options.defaults);
      if (!target.requiredFeatures.every(feature => features.has(feature))) continue;
      const config = { test: true, features };
      for (const module of target.modules.values()) {
        if (module.conditions.every(condition => cfgHolds(condition, config)) && rustFacts(module.file).tests > 0) compiled.add(module.file);
      }
    }
    return test => compiled.has(test) || support.has(test);
  }

  /** A tsconfig with the configs it extends and the projects it references,
   *  as repository paths. */
  function typescriptProjects(project) {
    const found = new Set();
    const visit = path => {
      if (found.has(path) || !isFile(join(root, path))) return;
      found.add(path);
      const config = ts.parseConfigFileTextToJson(path, read(path)).config ?? {};
      const extended = [config.extends ?? []].flat().filter(item => typeof item === 'string' && item.startsWith('.'));
      for (const item of extended) visit(inside(root, join(root, dirname(path), item.endsWith('.json') ? item : `${item}.json`)) ?? '');
      for (const reference of config.references ?? []) {
        const target = join(dirname(path), reference.path);
        visit(inside(root, target.endsWith('.json') ? join(root, target) : join(root, target, 'tsconfig.json')) ?? '');
      }
    };
    visit(project);
    return found;
  }

  const commandCache = new Map();
  function scriptRuns(name, seen = new Set()) {
    if (commandCache.has(name)) return commandCache.get(name);
    const command = packageJson.scripts?.[name];
    if (typeof command !== 'string') throw new Error(`No package.json script: ${name}`);
    if (seen.has(name)) throw new Error(`package.json script runs itself: ${name}`);
    const steps = shellSteps(command).map(step => stepRuns(step, new Set([...seen, name])));
    const runs = test => steps.some(step => step(test));
    commandCache.set(name, runs);
    return runs;
  }

  return {
    /** Whether the package.json script `command` runs the test file `test`. */
    commandRuns(command, test) { return scriptRuns(command)(test); },
    /** Whether running `test` executes `path` directly. */
    executes(test, path) {
      if (test === path) return true;
      if (test.endsWith('.rs')) return rustReach(test).has(path);
      if (SCRIPT_EXTENSIONS.includes(extname(test))) return scriptReach(test).has(path);
      return false;
    },
    /** For each of `paths`, the tests among `files` that execute it, with the
     *  first of `commands` that runs each such test. */
    testsExecuting(paths, files, commands) {
      const found = new Map(paths.map(path => [path, []]));
      for (const test of files) {
        if (!(test.endsWith('.rs') || SCRIPT_EXTENSIONS.includes(extname(test))) || !isFile(join(root, test))) continue;
        const executed = paths.filter(path => this.executes(test, path));
        if (executed.length === 0) continue;
        const command = commands.find(name => { try { return scriptRuns(name)(test); } catch { return false; } });
        if (!command) continue;
        for (const path of executed) found.get(path).push({ test, command });
      }
      return found;
    },
    /** Whether `path` only declares: TypeScript types, or Rust modules and `use`.
     *  The compilers check such a file; there is nothing in it a test runs. */
    declarationsOnly(path) {
      if (path.endsWith('.d.ts')) return true;
      if (path.endsWith('.rs')) return rustFacts(path).declarationsOnly;
      if (['.ts', '.tsx', '.mts', '.cts'].includes(extname(path))) return scriptSyntax(path, read(path)).declarationsOnly;
      return false;
    },
    /** The Cargo targets of the workspace and the files of their module trees. */
    rustTargets() {
      return loadWorkspace().targets.map(target => ({ kind: target.kind, name: target.name, root: target.root,
        files: [...target.modules.values()].map(module => module.file) }));
    },
    /** Files `test` executes directly, for diagnostics and registry upkeep. */
    reach(test) {
      if (test.endsWith('.rs')) return new Set(rustReach(test));
      if (SCRIPT_EXTENSIONS.includes(extname(test))) return new Set(scriptReach(test));
      return new Set();
    },
  };
}
