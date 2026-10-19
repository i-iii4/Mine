// What a failed entry into editing and a failed write say (SPEC_EDITING.md,
// Л2.8, Л3.8): the lines of the task box's notices, which name the same
// situations (SPEC_READING_MODE.md, Ч12.3). The words are a proposal the user
// approves, like the texts of windows.

import type { NoteEditError, NoteSaveError } from "@/types";
import {
  NO_SPACE_FOR_TASK,
  TASK_NOTE_CHANGED,
  TASK_NOTE_GONE,
  taskInCloudLine,
  taskReadOnlyLine,
} from "@/components/reading/TaskCheckbox";
import type { SaveDisposition } from "@/lib/editing/saveQueue";

/** The line of a write the backend refused because the new text would read
 *  as a collection page (Л3.3, step 5). */
export const NOTE_WOULD_BE_COLLECTION = "The text would make the note a collection page.";

/** The line of a conflict (Л4.3): the file changed outside the session while
 *  it held edits the file has not. Under the title `NOTE_NOT_SAVED_TITLE`;
 *  a proposal until the user decides ЛВ2 (а), which adds the choice. */
export const NOTE_CHANGED_ON_DISK = "The file changed on disk while you were editing.";

/** The quiet line of a conflict: nothing of the editor's text is lost while
 *  the card stays open. */
export const NOTE_TEXT_KEPT = "Your text is kept here.";

/** The line of a note the editor could not open; `null` where nothing is
 *  said: a collection page simply has no editing (Л2.8). */
export function noteEditErrorLine(error: NoteEditError): string | null {
  switch (error.kind) {
    case "in_cloud":
      return taskInCloudLine(error.file_name);
    case "read_only":
      return taskReadOnlyLine(error.file_name);
    case "source_not_found":
      return TASK_NOTE_GONE;
    case "no_vault":
      return NO_SPACE_FOR_TASK;
    case "not_a_card":
      return null;
    case "internal":
      return error.message;
  }
}

/** The line of a write that failed (Л3.8). */
export function noteSaveErrorLine(error: NoteSaveError): string {
  switch (error.kind) {
    case "stale_body":
    case "changed":
      return TASK_NOTE_CHANGED;
    case "in_cloud":
      return taskInCloudLine(error.file_name);
    case "read_only":
      return taskReadOnlyLine(error.file_name);
    case "source_not_found":
      return TASK_NOTE_GONE;
    case "no_vault":
      return NO_SPACE_FOR_TASK;
    case "not_a_card":
      return NOTE_WOULD_BE_COLLECTION;
    case "internal":
      return error.message;
  }
}

/** What a failed write means for the session's queue (Л3.8, Л4.3, Л4.9). */
export function noteSaveDisposition(error: NoteSaveError): SaveDisposition {
  switch (error.kind) {
    case "stale_body":
    case "changed":
      return "conflict";
    case "source_not_found":
    case "not_a_card":
      return "stop";
    case "in_cloud":
    case "read_only":
    case "no_vault":
    case "internal":
      return "retry";
  }
}

/** A rejection of `save_note_body` as its error; the command wrapper gives
 *  nothing else, a rejection of anything else counts as internal. */
export function asNoteSaveError(error: unknown): NoteSaveError {
  if (error && typeof error === "object" && "kind" in error && typeof error.kind === "string") {
    // `saveNoteBody` rejects only with a `NoteSaveError` (commands.ts).
    return error as NoteSaveError;
  }
  return { kind: "internal", message: error instanceof Error ? error.message : String(error) };
}
