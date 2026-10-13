// New elements from a drop of files and from ⌘V (SPEC_DEEP_AUDIT.md, Е6.4,
// Е6.5): one after another, past a file that fails, in the order the person
// gave them, and a drop or a paste that comes while the last one is still
// being added waits its turn instead of being thrown away. What could not be
// created is the tab's notice: which files, why, and how many came in.

import type { CreateBlockParams } from "@/types";
import { createBlock } from "./commands";
import {
  createElementsFailureTitle,
  dismissActionFailure,
  reportActionFailure,
} from "./actionFailures";
import { errorMessage } from "./errorMessage";

/** One element that could not be created: the file it was to come from, by
 *  name (none for pasted text), and why. */
export interface ElementFailure {
  label: string | null;
  message: string;
}

export interface ElementsOutcome {
  created: number;
  failures: ElementFailure[];
}

/** The quiet line of the notice: the elements of the same drop or paste that
 *  were created. */
export function otherElementsCreatedText(created: number): string {
  return created === 1 ? "1 other element was created." : `${created} other elements were created.`;
}

function fileLabel(params: CreateBlockParams): string | null {
  if (!params.file_path) return null;
  return params.file_path.split("/").filter(Boolean).pop() ?? params.file_path;
}

let queue: Promise<unknown> = Promise.resolve();

/// Create `paramsList` in order, after every drop and paste before it, and
/// tell the tab what failed. The answer counts what was created.
export function createElementsInTurn(paramsList: readonly CreateBlockParams[]): Promise<ElementsOutcome> {
  const turn = queue.then(async () => {
    const outcome: ElementsOutcome = { created: 0, failures: [] };
    for (const params of paramsList) {
      try {
        await createBlock(params);
        outcome.created += 1;
      } catch (error) {
        outcome.failures.push({ label: fileLabel(params), message: errorMessage(error) });
      }
    }
    reportElementsOutcome(outcome);
    return outcome;
  });
  // The next turn waits for this one, whatever its outcome.
  queue = turn.catch(() => undefined);
  return turn;
}

function reportElementsOutcome({ created, failures }: ElementsOutcome): void {
  if (failures.length === 0) {
    if (created > 0) dismissActionFailure("create-elements");
    return;
  }
  reportActionFailure({
    kind: "create-elements",
    title: createElementsFailureTitle(failures.length),
    summary: created > 0 ? otherElementsCreatedText(created) : undefined,
    messages: failures.map(({ label, message }) => (label === null ? message : `“${label}”: ${message}`)),
  });
}
