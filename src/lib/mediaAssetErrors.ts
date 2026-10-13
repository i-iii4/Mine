// What a refused action on a media file says (MediaAssetActionError and the
// commands that answer with it): the words of the dictionary
// (DESIGN_SYSTEM.md, «Словарь сущностей»; SPEC_DEEP_AUDIT.md, Е6.15).

/** Said when an action needs an open space and there is none. */
export const NO_SPACE_OPEN_TEXT = "No space is open.";

export function mediaAssetErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "kind" in error) {
    const typed = error as { kind: string } & Record<string, unknown>;
    switch (typed.kind) {
      case "no_vault":
        return NO_SPACE_OPEN_TEXT;
      case "invalid_media_ref":
        return typeof typed.reason === "string" ? typed.reason : "Invalid media reference.";
      case "media_not_found":
        return "Media file was not found.";
      case "unsupported_media_kind":
        return "This media kind is not supported.";
      case "name_taken":
        return typeof typed.target === "string"
          ? `A file named ${typed.target} already exists.`
          : "A file with this name already exists.";
      case "invalid_filename":
        return typeof typed.reason === "string" ? typed.reason : "Invalid filename.";
      case "clipboard_unsupported":
        return "Native media copy is not supported on this platform.";
      case "collection_not_found":
        return typeof typed.collection === "string"
          ? `Collection “${typed.collection}” has no page; nothing was written.`
          : "The collection has no page; nothing was written.";
      case "internal":
        return typeof typed.message === "string" ? typed.message : "Media action failed.";
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Media action failed.";
}
