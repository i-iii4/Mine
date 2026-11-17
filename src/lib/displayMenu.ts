// What the Display panels hold, as data (SPEC_FEED_DISPLAY.md, Д1 to Д4;
// SPEC_GRAPH_VIEW.md, «Панель графа»; SPEC_MENU_WINDOW.md, МО16, Г2): a
// panel is groups under their captions, a separator between the groups,
// each group a choice of one value or a few switches. The one description
// is drawn on the page and in the menu panel alike
// (src/components/MenuSpecView.tsx). Each group's values and labels stay
// with the component that owns the setting; this file is the shape they
// share.

import type { MenuAction, MenuEntry, MenuSpec } from "@/types";

/** One value of a group's choice and the words of its row. */
export interface DisplayChoice<T extends string> {
  value: T;
  label: string;
}

/** The choices of `values`, each with its label. */
export function labelledChoices<T extends string>(values: readonly T[], labels: Record<T, string>): DisplayChoice<T>[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

/** A group of a panel: its caption, then the choice of one value under it. */
export function displayChoice<T extends string>(
  id: string,
  caption: string,
  value: T,
  choices: readonly DisplayChoice<T>[],
): MenuEntry[] {
  return [
    { kind: "caption", text: caption },
    // The panel stays open: the choice applies at once and the next one is
    // a press away (SPEC_FEED_DISPLAY.md, Д3).
    { kind: "radio", id, value, options: choices.map((choice) => ({ value: choice.value, label: choice.label })), closes: false },
  ];
}

/** The value `action` chooses in the choice `id`, one of `choices`; null
 *  when the action is another entry's or names no such value. */
export function chosenValue<T extends string>(action: MenuAction, id: string, choices: readonly DisplayChoice<T>[]): T | null {
  if (action.kind !== "choose" || action.id !== id) return null;
  return choices.find((choice) => choice.value === action.value)?.value ?? null;
}

/**
 * The groups of a panel's part as they stand, the same at their largest
 * while the panel is open, and the way a choice is applied: `apply` says
 * whether the choice was this part's.
 */
export interface DisplayGroups {
  groups: readonly (readonly MenuEntry[])[];
  largest: readonly (readonly MenuEntry[])[];
  apply: (action: MenuAction) => boolean;
}

/** A Display panel: its groups in order, a separator between them. */
export function displaySpec(groups: readonly (readonly MenuEntry[])[]): MenuSpec {
  const entries: MenuEntry[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: "separator" });
    entries.push(...group);
  }
  return { role: "action", entries };
}
