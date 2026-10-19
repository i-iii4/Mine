// The failures of a person's actions in this tab, as notices (SPEC_DEEP_AUDIT.md,
// Н11; DESIGN_SYSTEM.md, «Сбой после закрытия окна»).
//
// An action whose menu or window has already closed has nowhere of its own to
// say that it failed, and before 13.10.2026 such failures went to the console
// only: a Disconnect of a selection, a Connect of one card, ⌘V, a drop of
// files. They report here; the tab's notice stack shows them
// (`ActionFailureNotices`). Source, Reveal in Finder, Copy Path, Copy Link
// and the commands of the tab bar go to the log instead (`appLog.ts`,
// decision of 14.10.2026).
// The store belongs to the page: each tab is its own page, so a failure shows
// in the tab where the action started, lead or not.

import { useSyncExternalStore } from "react";
import { errorMessage } from "./errorMessage";

/** The kinds of action, one notice each: a new failure of a kind replaces
 *  the notice of the last one, as the next deletion hides the last one's. */
export type ActionFailureKind =
  | "membership"
  | "create-collection"
  | "create-elements"
  | "read-element"
  | "task-toggle"
  | "note-edit"
  | "note-save";

export interface ActionFailure {
  kind: ActionFailureKind;
  title: string;
  /** What the failure left, in the quiet tone, before the error. */
  summary?: string;
  /** The error lines, each in the destructive tone. */
  messages: string[];
}

/** Said under a failed change that changed no file. */
export const NOTHING_CHANGED = "Nothing changed.";

export const CREATE_COLLECTION_FAILED_TITLE = "Could not create the collection";
export const READ_ELEMENT_FAILED_TITLE = "Could not read the element";
/** The title of a task the reading view could not toggle (SPEC_READING_MODE.md,
 *  Ч12.3). */
export const TASK_TOGGLE_FAILED_TITLE = "Could not change the task";
/** The title of a note the editor could not open (SPEC_EDITING.md, Л2.8). */
export const NOTE_EDIT_FAILED_TITLE = "Could not edit the note";
/** The title of a write of the editor that failed (SPEC_EDITING.md, Л3.8). */
export const NOTE_SAVE_FAILED_TITLE = "Could not save the note";
/** The title of a conflict of the editor (SPEC_EDITING.md, Л4.3): the file
 *  changed while edits were unsaved, nothing is written over it. */
export const NOTE_NOT_SAVED_TITLE = "Not saved";

/** The title of a Connect or a Disconnect that changed nothing. */
export function membershipFailureTitle(connected: boolean, count: number): string {
  const verb = connected ? "connect" : "disconnect";
  return count === 1 ? `Could not ${verb} the element` : `Could not ${verb} ${count} elements`;
}

/** The title of new elements that could not be made: ⌘V, a drop of files. */
export function createElementsFailureTitle(count: number): string {
  return count === 1 ? "Could not create an element" : `Could not create ${count} elements`;
}

let failures: readonly ActionFailure[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly ActionFailure[]) {
  failures = next;
  for (const listener of listeners) listener();
}

/** Show `failure` in this tab, in place of the last failure of its kind. */
export function reportActionFailure(failure: ActionFailure): void {
  publish([...failures.filter((shown) => shown.kind !== failure.kind), failure]);
}

/** Show `error` of an action of `kind` under `title`. */
export function reportActionError(
  kind: ActionFailureKind,
  title: string,
  error: unknown,
  summary?: string,
): void {
  reportActionFailure({ kind, title, summary, messages: [errorMessage(error)] });
}

/** Hide the notice of `kind`: closed by the person, or the action that
 *  failed has since succeeded. */
export function dismissActionFailure(kind: ActionFailureKind): void {
  if (!failures.some((shown) => shown.kind === kind)) return;
  publish(failures.filter((shown) => shown.kind !== kind));
}

/** Every notice gone; for tests and a space opened anew. */
export function clearActionFailures(): void {
  if (failures.length > 0) publish([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ActionFailure[] {
  return failures;
}

export function useActionFailures(): readonly ActionFailure[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
