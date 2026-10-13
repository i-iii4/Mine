/// Notices of a delete whose window had already closed (DESIGN_SYSTEM.md,
/// «Окна», «Сбой после закрытия окна», decision of 11.10.2026): the tab that
/// started it shows the failure, lead or not, never only the console.

/** Title of the notice when `Delete element?` deleted nothing. */
export const DELETE_ELEMENT_FAILED_TITLE = "Could not delete the element";

/** Title of the notice when `Delete collection?` stopped. */
export const DELETE_COLLECTION_FAILED_TITLE = "Could not delete the collection";

/// What a failed `Delete collection?` changed: nothing. The collection goes
/// in one backend command, its links off the elements and its page to the
/// Trash in one mutation (SPEC_DEEP_AUDIT.md, Н2, Е1.3).
export const DELETE_COLLECTION_NOTHING_CHANGED = "Nothing changed.";

/** Title of the notice when a deleted collection's link stayed in elements
 *  the deletion could not change. */
export const DELETE_COLLECTION_KEPT_LINKS_TITLE = "Links kept";

/// The elements that still link a deleted collection: the deletion could not
/// read them, or their properties cannot take the change in place, so their
/// files are as they were (SPEC_DEEP_AUDIT.md, Е1.3). `slugs` are the
/// elements, by slug; the text names one by its file name.
export function deleteCollectionKeptLinksText(label: string, slugs: string[]): string {
  const [only] = slugs;
  if (slugs.length === 1 && only !== undefined) {
    const name = only.split("/").pop() ?? only;
    return `“${name}” could not be changed and still links to “${label}”.`;
  }
  return `${slugs.length} elements could not be changed and still link to “${label}”.`;
}
