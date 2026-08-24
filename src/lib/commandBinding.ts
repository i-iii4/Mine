/// A keyboard binding as data: which key, which modifiers.
///
/// The registry used to carry a display string and a hand-written matcher side
/// by side. Nothing tied them together, so a rebound command would have shown
/// one combo and answered another. Here both the label and the match are
/// derived from the same record, and a rebind is just a different record.

export interface CommandBinding {
  /// The physical key, lowercase for letters ("k"), or the event key name for
  /// the named ones ("Tab", "Enter", "Escape", "ArrowUp", ",", "/").
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/// Keys whose combo cannot be typed as a chord: they name a family of keys or
/// a direction, and the bar shows them as a hint rather than a binding.
export type CommandGesture = "arrows" | "meta-alt-arrows";

const KEY_LABELS: Record<string, string> = {
  Tab: "⇥",
  Enter: "↵",
  Escape: "esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "space",
  Backspace: "⌫",
  Delete: "⌦",
};

const GESTURE_LABELS: Record<CommandGesture, string> = {
  arrows: "↕ ↔",
  "meta-alt-arrows": "⌘⌥ ↕",
};

export function gestureLabel(gesture: CommandGesture): string {
  return GESTURE_LABELS[gesture];
}

/// macOS modifier order, as the system writes it: ⌃ ⌥ ⇧ ⌘ then the key.
export function bindingLabel(binding: CommandBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("⌃");
  if (binding.alt) parts.push("⌥");
  if (binding.shift) parts.push("⇧");
  if (binding.meta) parts.push("⌘");
  parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
  return parts.join("");
}

/// Exact modifier match: a binding on ⌘ must not fire on ⌘⇧.
export function bindingMatches(binding: CommandBinding, e: KeyboardEvent): boolean {
  if (e.metaKey !== Boolean(binding.meta)) return false;
  if (e.shiftKey !== Boolean(binding.shift)) return false;
  if (e.altKey !== Boolean(binding.alt)) return false;
  if (e.ctrlKey !== Boolean(binding.ctrl)) return false;
  return eventKeyMatches(binding.key, e);
}

/// Letters are compared through `code` as well: with ⌥ held, or on a
/// non-Latin layout, `key` is not the letter that is printed on the cap.
function eventKeyMatches(key: string, e: KeyboardEvent): boolean {
  if (/^[a-z]$/.test(key)) {
    return e.code === `Key${key.toUpperCase()}` || e.key.toLowerCase() === key;
  }
  if (key === ",") return e.key === "," || e.code === "Comma";
  if (key === "/") return e.key === "/" || e.code === "Slash";
  if (key === "[") return e.key === "[" || e.code === "BracketLeft";
  if (key === "]") return e.key === "]" || e.code === "BracketRight";
  return e.key === key;
}

export function bindingsEqual(a: CommandBinding, b: CommandBinding): boolean {
  return (
    a.key === b.key
    && Boolean(a.meta) === Boolean(b.meta)
    && Boolean(a.shift) === Boolean(b.shift)
    && Boolean(a.alt) === Boolean(b.alt)
    && Boolean(a.ctrl) === Boolean(b.ctrl)
  );
}

/// Stable text form for storage and for comparing against reserved combos.
export function bindingId(binding: CommandBinding): string {
  return [
    binding.ctrl ? "ctrl" : "",
    binding.alt ? "alt" : "",
    binding.shift ? "shift" : "",
    binding.meta ? "meta" : "",
    binding.key.toLowerCase(),
  ].filter(Boolean).join("+");
}
