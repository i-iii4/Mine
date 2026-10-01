// What the helper's `folder_state` tells the person (SPEC_CLIPPER.md, К3).
// Most states arrive with the helper's own sentence; the identity states
// have fixed ones here, because Save must stay off until a new check clears
// them (SPEC_AUDIT_FIXES.md, Д2.1).

/** States in which the helper cannot tell which space the folder is. */
const IDENTITY_STATE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["identity_in_cloud", "This space is still downloading from iCloud. Try again in a moment."],
  ["identity_unreadable", "Mine cannot read this space's identity file."],
  ["identity_unwritable", "This folder is a copy and Mine could not give it its own identity."],
]);

/**
 * The one-line message for a state in which the helper cannot tell which
 * space the folder is; `null` for any other state, an unknown one or a value
 * that is not a state at all.
 */
export function identityStateMessage(folderState: unknown): string | null {
  return typeof folderState === "string" ? IDENTITY_STATE_MESSAGES.get(folderState) ?? null : null;
}

/** Whether the helper's state keeps Save off until the next check. */
export function folderStateBlocksSave(folderState: unknown): boolean {
  return identityStateMessage(folderState) !== null;
}
