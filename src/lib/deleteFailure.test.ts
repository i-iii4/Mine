import { describe, expect, it } from "vitest";
import { deleteCollectionFailureSummary } from "./deleteFailure";

// DESIGN_SYSTEM.md, «Сбой после закрытия окна» (decision of 11.10.2026): the
// notice of a failed `Delete collection?` names what had changed.
describe("deleteCollectionFailureSummary", () => {
  it("says nothing changed when the connections stayed", () => {
    expect(deleteCollectionFailureSummary("Typography", false)).toBe("Nothing changed.");
  });

  it("says the connections are gone and the page stayed", () => {
    expect(deleteCollectionFailureSummary("Typography", true)).toBe(
      "The elements are no longer connected to “Typography”, but the collection page stayed.",
    );
  });
});
