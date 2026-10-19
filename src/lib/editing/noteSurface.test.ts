import { describe, expect, it } from "vitest";
import type { CardKind } from "@/types";
import { noteSurface } from "./noteSurface";

// SPEC_EDITING.md, Л1, Л2 (row 50.12, the user's decision of 18.10.2026 on
// ЛВ1): the open card's body opens straight in the editor.

describe("the surface of the open card's body (Л1, Л2)", () => {
  it("opens every card's whole body in the editor, a collection page's never (Л2.1, Л2.5)", () => {
    const kinds: CardKind[] = ["article", "media", "link", "channel"];
    const surfaces = kinds.map((card_kind) => [card_kind, noteSurface({ card_kind, body_hash: "hash-0" }).kind]);
    expect(surfaces).toEqual([
      ["article", "editor"],
      ["media", "editor"],
      ["link", "editor"],
      ["channel", "reading"],
    ]);
    expect(noteSurface({ card_kind: "channel", body_hash: "hash-0" })).toEqual({ kind: "reading", reason: "collection_page" });
  });

  it("keeps the feed's start of the body in the reading mode until the whole card comes (Л2.1)", () => {
    expect(noteSurface({ card_kind: "article" })).toEqual({ kind: "reading", reason: "body_not_read" });
    expect(noteSurface({ card_kind: "article", body_hash: null })).toEqual({ kind: "reading", reason: "body_not_read" });
    expect(noteSurface({ card_kind: "article", body_hash: "" })).toEqual({ kind: "reading", reason: "body_not_read" });
    expect(noteSurface({ card_kind: "article", body_hash: "hash-1" })).toEqual({ kind: "editor" });
  });

  it("is the editor by default and the reading mode only where a check turns the editor off", () => {
    expect(noteSurface({ card_kind: "article", body_hash: "hash-0" }, true)).toEqual({ kind: "editor" });
    expect(noteSurface({ card_kind: "article", body_hash: "hash-0" }, false)).toEqual({ kind: "reading", reason: "editing_off" });
    // A collection page stays a collection page whatever the check says.
    expect(noteSurface({ card_kind: "channel", body_hash: "hash-0" }, false).kind).toBe("reading");
  });
});
