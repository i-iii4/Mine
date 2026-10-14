import { describe, expect, it } from "vitest";
import { NO_SPACE_OPEN_TEXT, mediaAssetErrorMessage } from "./mediaAssetErrors";

// A refused action on a media file speaks the words of the dictionary
// (DESIGN_SYSTEM.md, «Словарь сущностей»; SPEC_DEEP_AUDIT.md, Е6.15).
describe("mediaAssetErrorMessage", () => {
  it("names a space, not a vault, when none is open", () => {
    expect(mediaAssetErrorMessage({ kind: "no_vault" })).toBe(NO_SPACE_OPEN_TEXT);
    expect(NO_SPACE_OPEN_TEXT).toBe("No space is open.");
  });

  it("carries what the refusal names", () => {
    expect(mediaAssetErrorMessage({ kind: "name_taken", target: "photo.jpg" })).toBe(
      "A file named photo.jpg already exists.",
    );
    expect(mediaAssetErrorMessage({ kind: "collection_not_found", collection: "Typography" })).toBe(
      "Collection “Typography” has no page; nothing was written.",
    );
    expect(mediaAssetErrorMessage({ kind: "invalid_filename", reason: "The name is empty." })).toBe(
      "The name is empty.",
    );
    expect(mediaAssetErrorMessage({ kind: "internal", message: "Disk full." })).toBe("Disk full.");
  });

  it("has a sentence for a refusal that names nothing", () => {
    expect(mediaAssetErrorMessage({ kind: "media_not_found" })).toBe("Media file was not found.");
    expect(mediaAssetErrorMessage({ kind: "name_taken" })).toBe("A file with this name already exists.");
    expect(mediaAssetErrorMessage({ kind: "collection_not_found" })).toBe(
      "The collection has no page; nothing was written.",
    );
  });

  it("says the message of an error, and a plain sentence for anything else", () => {
    expect(mediaAssetErrorMessage(new Error("Timed out."))).toBe("Timed out.");
    expect(mediaAssetErrorMessage("text")).toBe("Media action failed.");
    expect(mediaAssetErrorMessage(null)).toBe("Media action failed.");
  });
});
