/// The single source for every keyboard command: its combo, its name, and the
/// context it belongs to. The bottom bar and the ⌘/ overlay render from this
/// table, and keydown handlers take their matchers from it, so a combo or a
/// name can never drift between the places that show it and the place that
/// implements it.

export type CommandContext = "global" | "feed" | "element" | "selection";

export const COMMAND_CONTEXT_TITLES: Record<CommandContext, string> = {
  global: "Global",
  feed: "Feed",
  element: "Element",
  selection: "Selection",
};

interface ModifierSpec {
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/// Exact modifier match: a combo that asks for ⌘ alone must not fire on ⌘⇧.
function modifiersMatch(e: KeyboardEvent, spec: ModifierSpec): boolean {
  return (
    e.metaKey === Boolean(spec.meta)
    && e.shiftKey === Boolean(spec.shift)
    && e.altKey === Boolean(spec.alt)
    && e.ctrlKey === Boolean(spec.ctrl)
  );
}

export interface CommandDefinition {
  id: string;
  /// Display form for the bar and the overlay, e.g. "⌘⇧N".
  combo: string;
  /// The action's name as the interface shows it.
  name: string;
  context: CommandContext;
  /// Matches the physical keydown. Absent on reference-only rows whose combo
  /// names a family of keys (arrows) rather than one chord.
  matches?: (e: KeyboardEvent) => boolean;
}

export const COMMANDS: readonly CommandDefinition[] = [
  // ── Global ────────────────────────────────────────────────────────────
  {
    id: "toggle-sidebar",
    combo: "⌃⌘S",
    name: "Hide Sidebar",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true, ctrl: true })
      && (e.code === "KeyS" || e.key.toLowerCase() === "s"),
  },
  {
    id: "new-collection",
    combo: "⌘⇧N",
    name: "New Collection",
    context: "global",
    matches: (e) => modifiersMatch(e, { meta: true, shift: true }) && e.key === "N",
  },
  {
    id: "settings",
    combo: "⌘,",
    name: "Settings",
    context: "global",
    matches: (e) => modifiersMatch(e, { meta: true }) && e.key === ",",
  },
  {
    id: "find-elements",
    combo: "⌘F",
    name: "Find elements",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true })
      && (e.code === "KeyF" || e.key.toLowerCase() === "f"),
  },
  {
    id: "find-collections",
    combo: "⌘⇧F",
    name: "Find collections",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true, shift: true })
      && (e.code === "KeyF" || e.key.toLowerCase() === "f"),
  },
  {
    id: "switch-space",
    combo: "⌘⇧O",
    name: "Switch space",
    context: "global",
    matches: (e) => modifiersMatch(e, { meta: true, shift: true }) && e.key === "O",
  },
  {
    id: "history-back",
    combo: "⌘[",
    name: "Back",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true })
      && (e.key === "[" || e.code === "BracketLeft"),
  },
  {
    id: "history-forward",
    combo: "⌘]",
    name: "Forward",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true })
      && (e.key === "]" || e.code === "BracketRight"),
  },
  {
    id: "commands-overlay",
    combo: "⌘/",
    name: "Commands",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true })
      && (e.key === "/" || e.code === "Slash"),
  },
  {
    id: "switch-collection",
    combo: "⌘⌥ ↕",
    name: "Switch collection",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true, alt: true })
      && (e.key === "ArrowUp" || e.key === "ArrowDown"),
  },
  {
    id: "toggle-view",
    combo: "⇥",
    name: "Switch view",
    context: "global",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Tab",
  },
  {
    id: "paste",
    combo: "⌘V",
    name: "Paste",
    context: "global",
    matches: (e) =>
      modifiersMatch(e, { meta: true })
      && (e.code === "KeyV" || e.key.toLowerCase() === "v"),
  },

  // ── Feed ──────────────────────────────────────────────────────────────
  {
    id: "navigate",
    combo: "↕ ↔",
    name: "Navigate",
    context: "feed",
  },
  {
    id: "open-focused",
    combo: "↵",
    name: "Focus",
    context: "feed",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Enter",
  },
  {
    id: "select-focused",
    combo: "⇧↵",
    name: "Select",
    context: "feed",
    matches: (e) => modifiersMatch(e, { shift: true }) && e.key === "Enter",
  },
  {
    id: "element-menu",
    combo: "⌘K",
    name: "Command",
    context: "feed",
    matches: (e) => modifiersMatch(e, { meta: true }) && e.key.toLowerCase() === "k",
  },
  {
    id: "clear-focus",
    combo: "esc",
    name: "Unfocus",
    context: "feed",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Escape",
  },

  // ── Element (open card) ───────────────────────────────────────────────
  {
    id: "close-element",
    combo: "esc",
    name: "Close",
    context: "element",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Escape",
  },
  {
    id: "element-menu-open",
    combo: "⌘K",
    name: "Command",
    context: "element",
    matches: (e) => modifiersMatch(e, { meta: true }) && e.key.toLowerCase() === "k",
  },
  {
    id: "copy-path",
    combo: "⌘L",
    name: "Copy path",
    context: "element",
    matches: (e) => modifiersMatch(e, { meta: true }) && e.key.toLowerCase() === "l",
  },
  {
    id: "toggle-connections",
    combo: "⇥",
    name: "Connections",
    context: "element",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Tab",
  },

  // ── Selection ─────────────────────────────────────────────────────────
  {
    id: "clear-selection",
    combo: "esc",
    name: "Clear selection",
    context: "selection",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Escape",
  },
  {
    id: "toggle-in-selection",
    combo: "↵",
    name: "Select",
    context: "selection",
    matches: (e) => modifiersMatch(e, {}) && e.key === "Enter",
  },
  {
    id: "batch-menu",
    combo: "⌘K",
    name: "Command",
    context: "selection",
    matches: (e) => modifiersMatch(e, { meta: true }) && e.key.toLowerCase() === "k",
  },
];

export function commandById(id: string): CommandDefinition {
  const found = COMMANDS.find((command) => command.id === id);
  if (!found) throw new Error(`Unknown command id: ${id}`);
  return found;
}

export function commandsForContext(context: CommandContext): CommandDefinition[] {
  return COMMANDS.filter((command) => command.context === context);
}
