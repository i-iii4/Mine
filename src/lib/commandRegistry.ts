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
  /// - `system`: macOS owns the combo (⌘, on Settings) and expects it there.
  fixed?: "structural" | "system";
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
  /// Whether this command's binding differs from the shipped default.
  rebound: boolean;
  /// Matches the physical keydown. Absent for gestures.
  matches?: (e: KeyboardEvent) => boolean;
}

function resolve(definition: CommandDefinition): ResolvedCommand {
  const override = definition.fixed ? undefined : overrides[definition.id];
  const binding = override ?? definition.binding;
  return {
    ...definition,
    binding,
    combo: binding
      ? bindingLabel(binding)
      : definition.gesture
        ? gestureLabel(definition.gesture)
        : "",
    rebound: override !== undefined,
    matches: binding ? (e: KeyboardEvent) => bindingMatches(binding, e) : undefined,
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
