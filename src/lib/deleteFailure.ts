/// Notices of a delete whose window had already closed (DESIGN_SYSTEM.md,
/// «Окна», «Сбой после закрытия окна», decision of 11.10.2026): the tab that
/// started it shows the failure, lead or not, never only the console.

/** Title of the notice when `Delete element?` deleted nothing. */
export const DELETE_ELEMENT_FAILED_TITLE = "Could not delete the element";

/** Title of the notice when `Delete collection?` stopped. */
export const DELETE_COLLECTION_FAILED_TITLE = "Could not delete the collection";

/// What a failed `Delete collection?` changed before it stopped. The
/// collection goes in two steps: its connections leave the elements in one
/// atomic batch (`delete_tag_from_all`), then its page goes to the Trash
/// (`delete_channel`). A failure of the first step changed nothing; a failure
/// of the second left the elements disconnected and the empty page in place.
export function deleteCollectionFailureSummary(
  label: string,
  connectionsRemoved: boolean,
): string {
  return connectionsRemoved
    ? `The elements are no longer connected to “${label}”, but the collection page stayed.`
    : "Nothing changed.";
}
