/// The single source for every keyboard command: its binding, its name, and
/// the context it belongs to. The bottom bar, the Shortcuts settings section
/// and the keydown handlers all read from here, so a combo cannot drift
/// between the place that shows it and the place that implements it.
///
/// Bindings are data (`CommandBinding`), not hand-written matchers: the label
/// and the match derive from the same record, which is what makes rebinding
/// possible at all.

import {
  bindingLabel,
  bindingMatches,
  gestureLabel,
  type CommandBinding,
  type CommandGesture,
} from "./commandBinding";

export type CommandContext = "global" | "feed" | "element" | "selection";

export const COMMAND_CONTEXT_TITLES: Record<CommandContext, string> = {
  global: "Global",
  feed: "Feed",
  element: "Element",
  selection: "Selection",
};

export interface CommandDefinition {
  id: string;
  name: string;
  context: CommandContext;
  /// The chord, when the command has one.
  binding?: CommandBinding;
  /// A family of keys rather than a chord — shown, never matched, never bound.
  gesture?: CommandGesture;
  /// Why a command cannot be rebound, or absent when it can.
  ///
  /// - `structural`: arrows, Enter, Escape, Tab. These are the language of the
  ///   interface rather than shortcuts; rebinding them breaks the model.
  /// - `system`: macOS owns the combo (⌘, on Settings, ⌘T and the other tab
  ///   and window chords) and expects it there. Shown, never recorded.
  fixed?: "structural" | "system";
  /// More chords for the same fixed command: ⌃Tab beside ⇧⌘], ⌘2 to ⌘8
  /// beside ⌘1. Matched like the binding; a command that can be rebound has
  /// exactly one chord.
  alternates?: readonly CommandBinding[];
  /// The binding and its alternates are one run of keys (⌘1 to ⌘8), shown as
  /// the first and the last joined by "…" rather than one by one.
  run?: true;
}

/// ⌘1 to ⌘8 select a tab by its place; ⌘9 always selects the last one.
function metaDigit(digit: number): CommandBinding {
  return { key: String(digit), meta: true };
}

export const DEFAULT_COMMANDS: readonly CommandDefinition[] = [
  // ── Global ────────────────────────────────────────────────────────────
  {
    id: "toggle-sidebar",
    name: "Hide Sidebar",
    context: "global",
    binding: { key: "s", meta: true, ctrl: true },
  },
  {
    id: "new-collection",
    name: "New Collection",
    context: "global",
    binding: { key: "n", meta: true, shift: true },
  },
  {
    id: "settings",
    name: "Settings",
    context: "global",
    binding: { key: ",", meta: true },
    fixed: "system",
  },
  {
    id: "find-elements",
    name: "Find elements",
    context: "global",
    binding: { key: "f", meta: true },
  },
  {
    id: "find-collections",
    name: "Find collections",
    context: "global",
    binding: { key: "f", meta: true, shift: true },
  },
  {
    id: "switch-space",
    name: "Switch space",
    context: "global",
    binding: { key: "o", meta: true, shift: true },
  },
  {
    id: "history-back",
    name: "Back",
    context: "global",
    binding: { key: "[", meta: true },
  },
  {
    id: "history-forward",
    name: "Forward",
    context: "global",
    binding: { key: "]", meta: true },
  },
  {
    id: "commands-overlay",
    name: "Commands",
    context: "global",
    binding: { key: "/", meta: true },
  },
  {
    id: "switch-collection",
    name: "Switch collection",
    context: "global",
    gesture: "meta-alt-arrows",
    fixed: "structural",
  },
  {
    id: "toggle-view",
    name: "Switch view",
    context: "global",
    binding: { key: "Tab" },
    fixed: "structural",
  },
  {
    id: "paste",
    name: "Paste",
    context: "global",
    binding: { key: "v", meta: true },
  },
  // Dev button styles (src/lib/buttonStyle.ts): step the window's buttons
  // through macOS, Retro and Linear. Goes with the tool.
  {
    id: "flip-buttons",
    name: "Cycle Buttons macOS / Retro / Linear",
    context: "global",
    binding: { key: "b", ctrl: true, alt: true },
  },

  // ── Tabs and windows (SPEC_TABS.md, В55, В57) ─────────────────────────
  // macOS keeps these chords for tabs and windows in every app. The ⌘ ones
  // are native menu items; the pages catch ⌃Tab and ⌃⇧Tab.
  {
    id: "new-tab",
    name: "New Tab",
    context: "global",
    binding: { key: "t", meta: true },
    fixed: "system",
  },
  {
    id: "new-window",
    name: "New Window",
    context: "global",
    binding: { key: "n", meta: true },
    fixed: "system",
  },
  {
    id: "close-tab",
    name: "Close Tab",
    context: "global",
    binding: { key: "w", meta: true },
    fixed: "system",
  },
  {
    id: "close-window",
    name: "Close Window",
    context: "global",
    binding: { key: "w", meta: true, shift: true },
    fixed: "system",
  },
  {
    id: "next-tab",
    name: "Show Next Tab",
    context: "global",
    binding: { key: "]", meta: true, shift: true },
    alternates: [{ key: "Tab", ctrl: true }],
    fixed: "system",
  },
  {
    id: "previous-tab",
    name: "Show Previous Tab",
    context: "global",
    binding: { key: "[", meta: true, shift: true },
    alternates: [{ key: "Tab", ctrl: true, shift: true }],
    fixed: "system",
  },
  {
    id: "select-tab",
    name: "Select Tab 1 to 8",
    context: "global",
    binding: metaDigit(1),
    alternates: [2, 3, 4, 5, 6, 7, 8].map(metaDigit),
    run: true,
    fixed: "system",
  },
  {
    id: "select-last-tab",
    name: "Select Last Tab",
    context: "global",
    binding: metaDigit(9),
    fixed: "system",
  },

  // ── Feed ──────────────────────────────────────────────────────────────
  {
    id: "navigate",
    name: "Navigate",
    context: "feed",
    gesture: "arrows",
    fixed: "structural",
  },
  {
    id: "open-focused",
    name: "Focus",
    context: "feed",
    binding: { key: "Enter" },
    fixed: "structural",
  },
  {
    id: "select-focused",
    name: "Select",
    context: "feed",
    binding: { key: "Enter", shift: true },
    fixed: "structural",
  },
  {
    id: "element-menu",
    name: "Command",
    context: "feed",
    binding: { key: "k", meta: true },
  },
  {
    id: "clear-focus",
    name: "Unfocus",
    context: "feed",
    binding: { key: "Escape" },
    fixed: "structural",
  },

  // ── Element (open card) ───────────────────────────────────────────────
  {
    id: "close-element",
    name: "Close",
    context: "element",
    binding: { key: "Escape" },
    fixed: "structural",
  },
  {
    id: "element-menu-open",
    name: "Command",
    context: "element",
    binding: { key: "k", meta: true },
  },
  {
    id: "copy-path",
    name: "Copy path",
    context: "element",
    binding: { key: "l", meta: true },
  },
  {
    id: "toggle-connections",
    name: "Connections",
    context: "element",
    binding: { key: "Tab" },
    fixed: "structural",
  },

  // ── Selection ─────────────────────────────────────────────────────────
  {
    id: "clear-selection",
    name: "Clear selection",
    context: "selection",
    binding: { key: "Escape" },
    fixed: "structural",
  },
  {
    id: "toggle-in-selection",
    name: "Select",
    context: "selection",
    binding: { key: "Enter" },
    fixed: "structural",
  },
  {
    id: "batch-menu",
    name: "Command",
    context: "selection",
    binding: { key: "k", meta: true },
  },
  {
    id: "delete-selection",
    name: "Delete selected",
    context: "selection",
    binding: { key: "Backspace" },
    fixed: "structural",
  },
];

/// Overrides applied on top of the defaults, by command id. Owned by the
/// Shortcuts settings section; empty until the user rebinds something.
export type CommandOverrides = Readonly<Record<string, CommandBinding>>;

let overrides: CommandOverrides = {};
const listeners = new Set<() => void>();

export function setCommandOverrides(next: CommandOverrides) {
  overrides = next;
  for (const listener of listeners) listener();
}

export function getCommandOverrides(): CommandOverrides {
  return overrides;
}

export function subscribeToCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// A command with its binding resolved: the user's override when there is one,
/// the default otherwise.
export interface ResolvedCommand extends CommandDefinition {
  /// What the interface shows — chord label or gesture hint.
  combo: string;
  /// The same, one entry per key a fixed command answers to (⇧⌘] and ⌃⇥).
  combos: readonly string[];
  /// Whether this command's binding differs from the shipped default.
  rebound: boolean;
  /// Matches the physical keydown. Absent for gestures.
  matches?: (e: KeyboardEvent) => boolean;
}

/// Every chord a command answers to: its binding, then its alternates.
export function commandBindings(
  command: Pick<CommandDefinition, "binding" | "alternates">,
): CommandBinding[] {
  return command.binding ? [command.binding, ...(command.alternates ?? [])] : [];
}

function comboLabels(definition: CommandDefinition, bindings: readonly CommandBinding[]): string[] {
  if (bindings.length === 0) {
    return definition.gesture ? [gestureLabel(definition.gesture)] : [];
  }
  const labels = bindings.map(bindingLabel);
  return definition.run ? [`${labels[0]}…${labels[labels.length - 1]}`] : labels;
}

function resolve(definition: CommandDefinition): ResolvedCommand {
  const override = definition.fixed ? undefined : overrides[definition.id];
  const binding = override ?? definition.binding;
  const bindings = commandBindings({ binding, alternates: definition.alternates });
  const combos = comboLabels(definition, bindings);
  return {
    ...definition,
    binding,
    combo: combos.join(" "),
    combos,
    rebound: override !== undefined,
    matches: bindings.length > 0
      ? (e: KeyboardEvent) => bindings.some((candidate) => bindingMatches(candidate, e))
      : undefined,
  };
}

export function allCommands(): ResolvedCommand[] {
  return DEFAULT_COMMANDS.map(resolve);
}

export function commandById(id: string): ResolvedCommand {
  const found = DEFAULT_COMMANDS.find((command) => command.id === id);
  if (!found) throw new Error(`Unknown command id: ${id}`);
  return resolve(found);
}

export function commandsForContext(context: CommandContext): ResolvedCommand[] {
  return DEFAULT_COMMANDS.filter((command) => command.context === context).map(resolve);
}
