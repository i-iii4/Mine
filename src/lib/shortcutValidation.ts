/// Whether a recorded chord may be assigned to a command.
///
/// Three refusals, each for its own reason: the chord belongs to the system,
/// the chord is a bare key, or another command in the same surface already
/// answers it. A refusal names the reason — a rebind that silently does
/// nothing is worse than one that explains itself.

import { bindingId, type CommandBinding } from "./commandBinding";
import {
  allCommands,
  commandBindings,
  type CommandContext,
  type ResolvedCommand,
} from "./commandRegistry";

export type ShortcutRejection =
  | { reason: "system"; combo: string }
  | { reason: "bare-key" }
  | { reason: "conflict"; command: string; context: CommandContext };

/// Combos macOS keeps for itself. Taking one either does nothing or breaks the
/// system behaviour the user relies on. Written as bindings and keyed through
/// `bindingId`, so the modifier order always matches what a recorded chord
/// produces.
const RESERVED_BINDINGS: readonly CommandBinding[] = [
  { key: "q", meta: true },
  { key: "w", meta: true },
  { key: "m", meta: true },
  { key: "h", meta: true },
  { key: "Tab", meta: true },
  { key: " ", meta: true },
  { key: "3", meta: true, shift: true },
  { key: "4", meta: true, shift: true },
  { key: "5", meta: true, shift: true },
  { key: "Escape", meta: true, alt: true },
  { key: " ", meta: true, ctrl: true },
  { key: "f", meta: true, ctrl: true },
  // Tabs and windows (SPEC_TABS.md, В59): ⌘T, ⌘N, ⌘W, ⇧⌘W, ⌘1 to ⌘9,
  // ⇧⌘[ and ⇧⌘], ⌃Tab and ⌃⇧Tab.
  { key: "t", meta: true },
  { key: "n", meta: true },
  { key: "w", meta: true, shift: true },
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => ({ key, meta: true })),
  { key: "[", meta: true, shift: true },
  { key: "]", meta: true, shift: true },
  // A US layout reports ⇧[ and ⇧] as "{" and "}".
  { key: "{", meta: true, shift: true },
  { key: "}", meta: true, shift: true },
  { key: "Tab", ctrl: true },
  { key: "Tab", ctrl: true, shift: true },
];

const RESERVED = new Set(RESERVED_BINDINGS.map(bindingId));

/// Contexts that can be active at the same time as the given one. Feed,
/// element and selection are mutually exclusive surfaces, so a combo may mean
/// different things in each — but every one of them coexists with global.
function coexisting(context: CommandContext): CommandContext[] {
  return context === "global"
    ? ["global", "feed", "element", "selection"]
    : ["global", context];
}

export function validateShortcut(
  commandId: string,
  binding: CommandBinding,
  commands: readonly ResolvedCommand[] = allCommands(),
): ShortcutRejection | null {
  const target = commands.find((command) => command.id === commandId);
  if (!target) throw new Error(`Unknown command id: ${commandId}`);

  const id = bindingId(binding);
  if (RESERVED.has(id)) {
    return { reason: "system", combo: id };
  }

  // A bare key would swallow typing everywhere outside an input.
  if (!binding.meta && !binding.ctrl && !binding.alt) {
    return { reason: "bare-key" };
  }

  const surfaces = new Set(coexisting(target.context));
  for (const command of commands) {
    if (command.id === commandId) continue;
    // Global commands must also not collide with any surface command, which
    // `coexisting("global")` already lists.
    if (!surfaces.has(command.context)) continue;
    if (commandBindings(command).some((candidate) => bindingId(candidate) === id)) {
      return { reason: "conflict", command: command.name, context: command.context };
    }
  }

  return null;
}

export function rejectionMessage(rejection: ShortcutRejection): string {
  switch (rejection.reason) {
    case "system":
      return "Reserved by macOS.";
    case "bare-key":
      return "Add ⌘, ⌥ or ⌃.";
    case "conflict":
      return `Used by ${rejection.command} (${rejection.context}).`;
  }
}
