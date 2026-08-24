/// Whether a recorded chord may be assigned to a command.
///
/// Three refusals, each for its own reason: the chord belongs to the system,
/// the chord is a bare key, or another command in the same surface already
/// answers it. A refusal names the reason — a rebind that silently does
/// nothing is worse than one that explains itself.

import { bindingId, type CommandBinding } from "./commandBinding";
import { allCommands, type CommandContext, type ResolvedCommand } from "./commandRegistry";

export type ShortcutRejection =
  | { reason: "system"; combo: string }
  | { reason: "bare-key" }
  | { reason: "conflict"; command: string; context: CommandContext };

/// Combos macOS keeps for itself. Taking one either does nothing or breaks the
/// system behaviour the user relies on.
const RESERVED = new Set([
  "meta+q", "meta+w", "meta+m", "meta+h", "meta+n", "meta+t",
  "meta+tab", "meta+ ", "meta+space",
  "meta+shift+3", "meta+shift+4", "meta+shift+5",
  "meta+alt+esc", "ctrl+meta+ ", "ctrl+meta+f",
]);

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
    if (!command.binding) continue;
    if (!surfaces.has(command.context)) continue;
    // Global commands must also not collide with any surface command.
    if (target.context === "global" && command.context !== "global") {
      if (bindingId(command.binding) === id) {
        return { reason: "conflict", command: command.name, context: command.context };
      }
      continue;
    }
    if (bindingId(command.binding) === id) {
      return { reason: "conflict", command: command.name, context: command.context };
    }
  }

  return null;
}

export function rejectionMessage(rejection: ShortcutRejection): string {
  switch (rejection.reason) {
    case "system":
      return "macOS keeps this combination for itself.";
    case "bare-key":
      return "A shortcut needs ⌘, ⌥ or ⌃ — a bare key would swallow typing.";
    case "conflict":
      return `Already used by ${rejection.command} (${rejection.context}).`;
  }
}
