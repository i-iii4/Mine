// The words the open card's association headings show (DESIGN_SYSTEM.md,
// «Словарь сущностей (UI-нейминг)»: a card is an Element on screen).

import { describe, expect, it } from "vitest";
import { authorFeedHint } from "./cardAssociations";

describe("the author heading's hint", () => {
  it("names the author's elements, not cards", () => {
    expect(authorFeedHint("Ann")).toBe("All elements by Ann");
    expect(authorFeedHint("Ann")).not.toMatch(/\bcards?\b/i);
  });
});
