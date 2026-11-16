// The arguments the frontend hands each backend command, read against the
// command's Rust signature (SPEC_DEEP_AUDIT.md, Н13, Е7.2). Tauri finds an
// argument by its key: the camelCase of the Rust parameter by default, the
// parameter's own name under `rename_all = "snake_case"`. A key the command
// does not take is dropped without a word and a missing required one fails
// only at run time, while every other test mocks `invoke`: nothing else
// catches a mismatch.
//
// The same list of registered commands holds SPEC_INTEGRATION.md to the code
// (AUDIT_CODE_QUALITY.md, Д1): the document named commands deleted long ago.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const RUST_SOURCES = "src-tauri/src";
const CORE_SOURCES = "mine-core/src";
const FRONTEND_SOURCES = "src";
const GENERATED_TYPES = "src/types/generated.ts";
const INTEGRATION_SPEC = "SPEC_INTEGRATION.md";

/** A parameter Tauri fills itself instead of reading it from the call. */
const INJECTED_PARAMETER =
  /^(?:tauri::)?(?:ipc::)?(?:State|AppHandle|Webview|WebviewWindow|Window|Request)\b/;
/** A parameter that takes the call's raw body and headers. */
const RAW_BODY_PARAMETER = /^(?:tauri::)?(?:ipc::)?Request\b/;
/** The functions that hand a command to Tauri. */
const INVOKERS = new Set(["invoke", "tauriInvoke"]);

interface RustCommand {
  /** The keys the command reads, and whether each one must be present. */
  keys: Map<string, { required: boolean }>;
  /** It reads the raw body of the call. */
  raw: boolean;
}

type CallArguments =
  | { kind: "keys"; keys: string[] }
  | { kind: "raw" }
  /** A spread or a computed key: its keys cannot be read from the source. */
  | { kind: "unreadable" };

interface FrontendCall {
  command: string;
  /** What the call hands over; a choice between two objects is two. */
  arguments: CallArguments[];
  where: string;
}

/** `position_ms` as Tauri names it by default: `positionMs`. */
function camelCase(name: string): string {
  return name.replace(/_+([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/** Split `text` at the commas outside brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("(<[{".includes(character)) depth += 1;
    if (")>]}".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The command `name` as `text`, the Rust module declaring it, defines it. */
function readRustCommand(text: string, name: string): RustCommand | null {
  const attribute = /#\[tauri::command(?:\(([^)\]]*)\))?\]/g;
  for (const match of text.matchAll(attribute)) {
    const after = text.slice(match.index + match[0].length);
    const signature = /^(?:\s*(?:#\[[^\]]*\]|\/\/[^\n]*))*\s*pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/
      .exec(after);
    if (signature === null || signature[1] !== name) continue;
    let depth = 1;
    let end = signature[0].length;
    while (depth > 0 && end < after.length) {
      if (after[end] === "(") depth += 1;
      if (after[end] === ")") depth -= 1;
      end += 1;
    }
    const parameters = after
      .slice(signature[0].length, end - 1)
      .replace(/\/\/[^\n]*/g, "");
    const snakeCase = /rename_all\s*=\s*"snake_case"/.test(match[1] ?? "");
    const keys = new Map<string, { required: boolean }>();
    let raw = false;
    for (const parameter of splitTopLevel(parameters)) {
      const colon = parameter.indexOf(":");
      const pattern = parameter.slice(0, colon).replace(/^mut\s+/, "").trim();
      const type = parameter.slice(colon + 1).trim();
      if (RAW_BODY_PARAMETER.test(type)) raw = true;
      if (INJECTED_PARAMETER.test(type)) continue;
      keys.set(snakeCase ? pattern : camelCase(pattern), { required: !/^Option\s*</.test(type) });
    }
    return { keys, raw };
  }
  return null;
}

/** Every command the app registers: its name and the file declaring it. */
function registeredCommands(): Map<string, string> {
  const lib = readFileSync(join(RUST_SOURCES, "lib.rs"), "utf8");
  const start = lib.indexOf("generate_handler![");
  const end = lib.indexOf("])", start);
  expect(start).toBeGreaterThan(-1);
  const registered = new Map<string, string>();
  for (const line of lib.slice(start, end).split("\n")) {
    const entry = /^\s*((?:[a-z_]+::)+)([a-z0-9_]+),\s*$/.exec(line);
    if (entry === null) continue;
    const modulePath = (entry[1] ?? "").replace(/::$/, "").split("::").join("/");
    const file = [`${modulePath}.rs`, `${modulePath}/mod.rs`]
      .map((candidate) => join(RUST_SOURCES, candidate))
      .find((candidate) => existsSync(candidate));
    expect(file, `${entry[1]}${entry[2]}: no module file`).toBeDefined();
    registered.set(entry[2] ?? "", file ?? "");
  }
  return registered;
}

/** The keys an object literal names, or null when one cannot be read. */
function objectKeys(object: ts.ObjectLiteralExpression): string[] | null {
  const keys: string[] = [];
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text);
    } else if (
      ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      keys.push(property.name.text);
    } else {
      return null;
    }
  }
  return keys;
}

/** What the expression `args` hands a command. */
function readArguments(args: ts.Expression | undefined): CallArguments[] {
  if (args === undefined) return [{ kind: "keys", keys: [] }];
  if (ts.isParenthesizedExpression(args)) return readArguments(args.expression);
  if (ts.isConditionalExpression(args)) {
    return [...readArguments(args.whenTrue), ...readArguments(args.whenFalse)];
  }
  if (ts.isObjectLiteralExpression(args)) {
    const keys = objectKeys(args);
    return [keys === null ? { kind: "unreadable" } : { kind: "keys", keys }];
  }
  return [{ kind: "raw" }];
}

/** Every call of `invoke` with a command named in the source of `file`. */
function readFrontendCalls(text: string, file: string): FrontendCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const calls: FrontendCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && INVOKERS.has(node.expression.text)
    ) {
      const [command, args] = node.arguments;
      if (command !== undefined && ts.isStringLiteralLike(command)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        calls.push({ command: command.text, arguments: readArguments(args), where: `${file}:${line}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** The frontend's sources, tests aside. */
function frontendFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : frontendFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The commands of Tauri plugins the pages call, which live outside this
 *  tree: their keys as the plugin's Rust signature reads them.
 *  `plugin:log|log` is `tauri-plugin-log` 2.8.0, `commands.rs`: `level`,
 *  `message`, `location`, `file`, `line`, `key_values` (camelCase by
 *  default), the first two required (`src/lib/appLog.ts`). */
const PLUGIN_COMMANDS: ReadonlyMap<string, RustCommand> = new Map([
  ["plugin:log|log", {
    keys: new Map([
      ["level", { required: true }],
      ["message", { required: true }],
      ["location", { required: false }],
      ["file", { required: false }],
      ["line", { required: false }],
      ["keyValues", { required: false }],
    ]),
    raw: false,
  }],
]);

/** What is wrong with `call` against `command`, if anything. */
function mismatches(call: FrontendCall, command: RustCommand | null): string[] {
  if (command === null) return [`${call.where}: "${call.command}" is not a registered command`];
  return call.arguments.flatMap((args) => argumentMismatches(call, args, command));
}

function argumentMismatches(call: FrontendCall, args: CallArguments, command: RustCommand): string[] {
  if (args.kind === "unreadable") {
    return [`${call.where}: "${call.command}" gets keys the check cannot read`];
  }
  if (args.kind === "raw") {
    return command.raw ? [] : [`${call.where}: "${call.command}" gets a raw body it does not read`];
  }
  const given = new Set(args.keys);
  const problems: string[] = [];
  for (const key of given) {
    if (!command.keys.has(key)) {
      problems.push(
        `${call.where}: "${call.command}" takes no "${key}"; it takes ${[...command.keys.keys()].join(", ") || "nothing"}`,
      );
    }
  }
  for (const [key, { required }] of command.keys) {
    if (required && !given.has(key)) {
      problems.push(`${call.where}: "${call.command}" needs "${key}"`);
    }
  }
  return problems;
}

describe("the arguments of every command call (Е7.2)", () => {
  it("are the keys the Rust command reads", () => {
    const registered = registeredCommands();
    const calls = frontendFiles(FRONTEND_SOURCES).flatMap((file) =>
      readFrontendCalls(readFileSync(file, "utf8"), file));
    // The reader found the calls: an empty list would pass anything.
    expect(calls.length).toBeGreaterThan(80);

    const problems = calls.flatMap((call) => {
      const plugin = PLUGIN_COMMANDS.get(call.command);
      if (plugin !== undefined) return mismatches(call, plugin);
      const file = registered.get(call.command);
      const command = file === undefined
        ? null
        : readRustCommand(readFileSync(file, "utf8"), call.command);
      if (file !== undefined && command === null) {
        return [`${call.where}: "${call.command}" is registered but ${file} declares no such command`];
      }
      return mismatches(call, command);
    });
    expect(problems).toEqual([]);
  });

  it("catches a key named the other way and a key the command lacks", () => {
    const rust = [
      "/// Remember where the listener stopped.",
      "#[tauri::command(async)]",
      "pub fn set_position(",
      "    webview: tauri::Webview,",
      "    state: State<'_, AppState>,",
      "    slug: String,",
      "    // Milliseconds from the start.",
      "    position_ms: u64,",
      "    duration_ms: Option<u64>,",
      ") -> Result<(), CommandError> {",
      "#[tauri::command(rename_all = \"snake_case\")]",
      "pub async fn rename(old_tag: String, new_tag: String) {}",
      "#[tauri::command]",
      "pub fn save(request: Request<'_>) {}",
    ].join("\n");
    const frontend = [
      "invoke<void>(\"set_position\", { slug, position_ms, duration_ms });",
      "invoke<void>(\"set_position\", { slug, positionMs });",
      "invoke<void>(\"rename\", { old_tag, new_tag });",
      "invoke<void>(\"rename\", { oldTag, new_tag });",
      "invoke<void>(\"save\", bytes, { headers });",
      "invoke<void>(\"rename\", { ...names });",
      "invoke<void>(\"gone\");",
      "invoke<void>(\"rename\", whole ? { old_tag, new_tag } : { old_tag });",
    ].join("\n");
    const problems = readFrontendCalls(frontend, "sample.ts").map((call) =>
      mismatches(call, readRustCommand(rust, call.command)));

    expect(problems).toEqual([
      [
        "sample.ts:1: \"set_position\" takes no \"position_ms\"; it takes slug, positionMs, durationMs",
        "sample.ts:1: \"set_position\" takes no \"duration_ms\"; it takes slug, positionMs, durationMs",
        "sample.ts:1: \"set_position\" needs \"positionMs\"",
      ],
      [],
      [],
      [
        "sample.ts:4: \"rename\" takes no \"oldTag\"; it takes old_tag, new_tag",
        "sample.ts:4: \"rename\" needs \"old_tag\"",
      ],
      [],
      ["sample.ts:6: \"rename\" gets keys the check cannot read"],
      ["sample.ts:7: \"gone\" is not a registered command"],
      ["sample.ts:8: \"rename\" needs \"new_tag\""],
    ]);
  });
});

/** The Rust sources under `directory`. */
function rustFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return rustFiles(path);
    return name.endsWith(".rs") ? [path] : [];
  });
}

/** Every identifier the backend writes: its functions, fields and modules in
 *  Rust, and the names it serializes under, which only the generated types
 *  spell out (`stale_body` is the variant `StaleBody`). */
function backendNames(): Set<string> {
  const names = new Set<string>();
  const sources = [...rustFiles(RUST_SOURCES), ...rustFiles(CORE_SOURCES), GENERATED_TYPES];
  for (const file of sources) {
    for (const match of readFileSync(file, "utf8").matchAll(/\b[a-z][a-z0-9_]*\b/g)) {
      names.add(match[0]);
    }
  }
  return names;
}

/** The names a document gives that the code does not have. A snake_case name
 *  in an inline code span is a command or another backend name: it must be a
 *  registered command or an identifier of the backend. A signature written as
 *  `#[tauri::command] name(` in a code block must be a registered command. */
function unknownSpecNames(
  text: string,
  registered: ReadonlySet<string>,
  backend: ReadonlySet<string>,
): string[] {
  const unknown = new Set<string>();
  const blocks = /```[\s\S]*?```/g;
  for (const block of text.matchAll(blocks)) {
    for (const signature of block[0].matchAll(/#\[tauri::command[^\]]*\]\s+([a-z0-9_]+)\s*\(/g)) {
      const name = signature[1] ?? "";
      if (!registered.has(name)) unknown.add(name);
    }
  }
  for (const span of text.replace(blocks, "").matchAll(/`([^`\n]+)`/g)) {
    for (const match of (span[1] ?? "").matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      const name = match[0];
      if (!registered.has(name) && !backend.has(name)) unknown.add(name);
    }
  }
  return [...unknown].sort();
}

describe("the commands SPEC_INTEGRATION.md names (AUDIT_CODE_QUALITY.md, Д1)", () => {
  it("every registered command is declared by its module", () => {
    const registered = registeredCommands();
    // The reader found the list: an empty one would pass anything below.
    expect(registered.size).toBeGreaterThan(100);

    const undeclared = [...registered].filter(([name, file]) =>
      readRustCommand(readFileSync(file, "utf8"), name) === null);
    expect(undeclared).toEqual([]);
  });

  it("are registered, and its other backend names exist", () => {
    const registered = new Set(registeredCommands().keys());
    const spec = readFileSync(INTEGRATION_SPEC, "utf8");
    // The document still speaks of commands: a moved or emptied file would
    // pass anything.
    expect(spec).toContain("`list_grid_blocks`");

    expect(unknownSpecNames(spec, registered, backendNames())).toEqual([]);
  });

  it("catches a command the code no longer has", () => {
    const registered = new Set(["list_grid_blocks", "delete_block"]);
    const backend = new Set(["upsert_block", "body_hash"]);
    const text = [
      "`list_grid_blocks` reads the index; `rebuild_index` and `list_tags` are gone.",
      "`delete_block(..., delete_unused_media=true)` calls `upsert_block` with `body_hash`.",
      "```rust",
      "#[tauri::command] delete_block(state, slug: String)",
      "#[tauri::command] rename_tag(state, old_tag: String)",
      "let untouched_local = 1;",
      "```",
    ].join("\n");

    expect(unknownSpecNames(text, registered, backend)).toEqual([
      "delete_unused_media",
      "list_tags",
      "rebuild_index",
      "rename_tag",
    ]);
  });
});
