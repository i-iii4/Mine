// Obsidian callout types (SPEC_READING_MODE.md, Ч8): every type with its
// aliases, the name of its lucide icon and its colour. The names are plain
// strings so the reading library stays free of React; `Callout` maps them to
// components and tokens.

/** The callout types of Obsidian, as its help page «Callouts» lists them. */
export type CalloutType =
  | "note"
  | "abstract"
  | "info"
  | "todo"
  | "tip"
  | "success"
  | "question"
  | "warning"
  | "failure"
  | "danger"
  | "bug"
  | "example"
  | "quote";

/** The lucide icon a callout type is drawn with. */
export type CalloutIconName =
  | "Pencil"
  | "ClipboardList"
  | "Info"
  | "CircleCheck"
  | "Flame"
  | "Check"
  | "CircleHelp"
  | "TriangleAlert"
  | "X"
  | "Zap"
  | "Bug"
  | "List"
  | "Quote";

/** The colour of a type's icon and title: Obsidian's colour of the type
 *  (`--callout-*` of its `app.css`, Obsidian 1.13.7), drawn by Mine's
 *  semantic colours (SPEC_COLOR_RULES.md, К12, 3.8). */
export type CalloutColor = "red" | "orange" | "blue" | "cyan" | "green" | "purple" | "grey";

interface CalloutTypeDefinition {
  readonly aliases: readonly string[];
  readonly icon: CalloutIconName;
  readonly color: CalloutColor;
}

/** Each type, its aliases, its icon and its colour (Ч8, the table of types;
 *  user's decision of 18.10.2026 on В3 (а)). */
export const CALLOUT_TYPES: Readonly<Record<CalloutType, CalloutTypeDefinition>> = {
  note: { aliases: [], icon: "Pencil", color: "blue" },
  abstract: { aliases: ["summary", "tldr"], icon: "ClipboardList", color: "cyan" },
  info: { aliases: [], icon: "Info", color: "blue" },
  todo: { aliases: [], icon: "CircleCheck", color: "blue" },
  tip: { aliases: ["hint", "important"], icon: "Flame", color: "cyan" },
  success: { aliases: ["check", "done"], icon: "Check", color: "green" },
  question: { aliases: ["help", "faq"], icon: "CircleHelp", color: "orange" },
  warning: { aliases: ["caution", "attention"], icon: "TriangleAlert", color: "orange" },
  failure: { aliases: ["fail", "missing"], icon: "X", color: "red" },
  danger: { aliases: ["error"], icon: "Zap", color: "red" },
  bug: { aliases: [], icon: "Bug", color: "red" },
  example: { aliases: [], icon: "List", color: "purple" },
  quote: { aliases: ["cite"], icon: "Quote", color: "grey" },
};

// `Object.entries` widens the keys to `string`; the record's keys are exactly
// the callout types.
const TYPE_BY_NAME: ReadonlyMap<string, CalloutType> = new Map(
  (Object.entries(CALLOUT_TYPES) as [CalloutType, CalloutTypeDefinition][]).flatMap(
    ([type, definition]) => [type, ...definition.aliases].map((name) => [name, type] as const),
  ),
);

/** Whether `value` names a callout type. */
export function isCalloutType(value: string): value is CalloutType {
  return Object.prototype.hasOwnProperty.call(CALLOUT_TYPES, value);
}

/** The type a callout written `[!written]` is drawn as: its type or alias in
 *  any letter case, and `note` for a type Obsidian does not know («any
 *  unsupported type defaults to the note type»). */
export function resolveCalloutType(written: string): CalloutType {
  return TYPE_BY_NAME.get(written.toLowerCase()) ?? "note";
}

/** The title of a callout written without one: its identifier as written,
 *  first letter capital (`Note`, `Faq` for the alias `faq`), as in Obsidian. */
export function defaultCalloutTitle(written: string): string {
  const lower = written.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** How a callout folds: `-` folded, `+` unfolded, no sign does not fold. */
export type CalloutFold = "folded" | "unfolded" | null;

/** The fold of the sign after the type. */
export function calloutFold(sign: string): CalloutFold {
  if (sign === "-") return "folded";
  if (sign === "+") return "unfolded";
  return null;
}
