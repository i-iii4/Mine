import { describe, expect, it } from "vitest";
import { cardChargeFor, graphPhysics } from "./physics";
import type { GraphCanvasNode } from "./contracts";

function card(degree: number): GraphCanvasNode {
  return {
    id: `card-${degree}`, kind: "card", label: "Card", slug: "card",
    collection_ref: null, card_kind: null, block_type: null,
    thumbnail: null, preview_manifest: null, degree,
  } as GraphCanvasNode;
}

function collection(): GraphCanvasNode {
  return {
    id: "collection:Design", kind: "collection", label: "Design", slug: null,
    collection_ref: "Design", card_kind: null, block_type: null,
    thumbnail: null, preview_manifest: null, degree: 4,
  } as GraphCanvasNode;
}

describe("cardChargeFor", () => {
  const physics = graphPhysics(500);

  it("gives an unlinked card less repulsion than a linked one", () => {
    // A linked card is pulled back by its collection; an unlinked one has
    // nothing holding it, so equal repulsion pushed it out until the free area
    // of the library read as empty.
    const linked = Math.abs(cardChargeFor(card(3), physics));
    const alone = Math.abs(cardChargeFor(card(0), physics));
    expect(alone).toBeLessThan(linked);
  });

  it("leaves collections on their own charge", () => {
    expect(cardChargeFor(collection(), physics)).toBe(physics.collectionCharge);
  });

  it("keeps repulsion a repulsion", () => {
    // Sign matters: a positive charge would make cards attract and collapse
    // into a single point.
    expect(cardChargeFor(card(0), physics)).toBeLessThan(0);
    expect(cardChargeFor(card(5), physics)).toBeLessThan(0);
  });
});
