/// What a failure says to the person: the words of the error, never
/// `String(error)`, which gave `Error: …` for an error and `[object Object]`
/// for a typed refusal (SPEC_DEEP_AUDIT.md, Е6.15).
///
/// `Error.message` is the text `commandErrorMessage` composed for a
/// `CommandError` (src/lib/commands.ts); a typed refusal that reached here
/// unwrapped speaks through its `message`, else names its `kind`.

/** Said when a failure carries no words at all. */
export const UNKNOWN_ERROR_TEXT = "Unknown error.";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || UNKNOWN_ERROR_TEXT;
  if (typeof error === "string") return error || UNKNOWN_ERROR_TEXT;
  if (typeof error === "object" && error !== null) {
    const { message, kind } = error as { message?: unknown; kind?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof kind === "string" && kind) return kind.replace(/_/g, " ");
  }
  return UNKNOWN_ERROR_TEXT;
}
