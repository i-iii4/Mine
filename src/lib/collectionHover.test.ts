import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOVER_LEAVE_GRACE_MS,
  applySelectionMembership,
  getCardSelectionSummary,
  isCardLitByCollection,
  isRowConnectedToHoveredCard,
  releaseHoveredCard,
  releaseHoveredCollectionRow,
  resetCollectionHover,
  setCollectionMemberships,
  setHoveredCard,
  setHoveredCollectionRow,
  setSelectedCards,
} from "./collectionHover";

describe("collection hover", () => {
  beforeEach(() => {
    resetCollectionHover();
    setCollectionMemberships([
      { block_id: 1, tag: "Аниме" },
      { block_id: 1, tag: "Интерфейсы" },
      { block_id: 2, tag: "Аниме" },
    ]);
  });

  it("lights exactly the cards of the hovered collection, and every card for Everything", () => {
    setHoveredCollectionRow("tag:Аниме");
    expect([1, 2, 3].map(isCardLitByCollection)).toEqual([true, true, false]);
    setHoveredCollectionRow("tag:Интерфейсы");
    expect([1, 2, 3].map(isCardLitByCollection)).toEqual([true, false, false]);
    setHoveredCollectionRow("all");
    expect([1, 2, 3].map(isCardLitByCollection)).toEqual([true, true, true]);
    setHoveredCollectionRow(null);
    expect([1, 2, 3].map(isCardLitByCollection)).toEqual([false, false, false]);
  });

  it("ignores rows that are not collections", () => {
    setHoveredCollectionRow("create");
    expect(isCardLitByCollection(1)).toBe(false);
  });

  it("shows the hovered card's collections and Everything as connected", () => {
    setHoveredCard(1);
    expect(["all", "tag:Аниме", "tag:Интерфейсы", "tag:Другое"].map(isRowConnectedToHoveredCard))
      .toEqual([true, true, true, false]);
    setHoveredCard(2);
    expect(isRowConnectedToHoveredCard("tag:Интерфейсы")).toBe(false);
    setHoveredCard(null);
    expect(isRowConnectedToHoveredCard("all")).toBe(false);
  });

  it("crossing the gap to the next card keeps shared answers steady", () => {
    vi.useFakeTimers();
    const everything: boolean[] = [];
    setHoveredCard(1);
    everything.push(isRowConnectedToHoveredCard("all"));
    releaseHoveredCard(1);                                  // pointer in the gap
    everything.push(isRowConnectedToHoveredCard("all"));
    vi.advanceTimersByTime(HOVER_LEAVE_GRACE_MS - 1);
    everything.push(isRowConnectedToHoveredCard("all"));
    setHoveredCard(2);                                      // next card
    vi.advanceTimersByTime(HOVER_LEAVE_GRACE_MS);
    everything.push(isRowConnectedToHoveredCard("all"));
    expect(everything).toEqual([true, true, true, true]);
    expect(isRowConnectedToHoveredCard("tag:Интерфейсы")).toBe(false);
    vi.useRealTimers();
  });

  it("clears once the pointer has really left, after the grace window", () => {
    vi.useFakeTimers();
    setHoveredCard(1);
    releaseHoveredCard(1);
    vi.advanceTimersByTime(HOVER_LEAVE_GRACE_MS);
    expect(isRowConnectedToHoveredCard("all")).toBe(false);
    setHoveredCollectionRow("tag:Аниме");
    releaseHoveredCollectionRow("tag:Аниме");
    expect(isCardLitByCollection(2)).toBe(true);
    setHoveredCollectionRow("tag:Интерфейсы");            // next row, no dark frame
    vi.advanceTimersByTime(HOVER_LEAVE_GRACE_MS);
    expect(isCardLitByCollection(1)).toBe(true);
    releaseHoveredCollectionRow("tag:Интерфейсы");
    vi.advanceTimersByTime(HOVER_LEAVE_GRACE_MS);
    expect(isCardLitByCollection(1)).toBe(false);
    vi.useRealTimers();
  });

  it("releases only its own hover, so a late leave does not clear the next one", () => {
    setHoveredCard(1);
    setHoveredCard(2);
    releaseHoveredCard(1);
    expect(isRowConnectedToHoveredCard("all")).toBe(true);
    setHoveredCollectionRow("tag:Аниме");
    setHoveredCollectionRow("all");
    releaseHoveredCollectionRow("tag:Аниме");
    expect(isCardLitByCollection(3)).toBe(true);
  });

  it("follows the memberships of the latest snapshot", () => {
    setHoveredCollectionRow("tag:Интерфейсы");
    setCollectionMemberships([{ block_id: 2, tag: "Интерфейсы" }]);
    expect([1, 2].map(isCardLitByCollection)).toEqual([false, true]);
  });
});

describe("feed selection summary (SPEC_CARD_STATES.md, С6)", () => {
  beforeEach(() => {
    resetCollectionHover();
    setCollectionMemberships([
      { block_id: 1, tag: "Аниме" },
      { block_id: 2, tag: "Аниме" },
      { block_id: 2, tag: "Интерфейсы" },
    ]);
  });

  it("counts the selected cards each collection holds", () => {
    expect(getCardSelectionSummary()).toBeNull();
    setSelectedCards([{ id: 1, slug: "one" }, { id: 2, slug: "two" }]);
    const summary = getCardSelectionSummary()!;
    expect(summary.total).toBe(2);
    expect(summary.slugs).toEqual(["one", "two"]);
    expect(summary.connectedByTag.get("Аниме")).toBe(2);
    expect(summary.connectedByTag.get("Интерфейсы")).toBe(1);
    expect(summary.connectedByTag.get("Музыка")).toBeUndefined();
  });

  it("keeps the same summary object until the selection or memberships change", () => {
    setSelectedCards([{ id: 1, slug: "one" }]);
    const first = getCardSelectionSummary();
    setSelectedCards([{ id: 1, slug: "one" }]);
    expect(getCardSelectionSummary()).toBe(first);
    setCollectionMemberships([{ block_id: 1, tag: "Музыка" }]);
    expect(getCardSelectionSummary()).not.toBe(first);
    expect(getCardSelectionSummary()!.connectedByTag.get("Музыка")).toBe(1);
  });

  it("applies a connect or disconnect to every selected card at once", () => {
    setSelectedCards([{ id: 1, slug: "one" }, { id: 2, slug: "two" }]);
    applySelectionMembership("Интерфейсы", true);
    expect(getCardSelectionSummary()!.connectedByTag.get("Интерфейсы")).toBe(2);
    setHoveredCollectionRow("tag:Интерфейсы");
    expect(isCardLitByCollection(1)).toBe(true);
    applySelectionMembership("Интерфейсы", false);
    expect(getCardSelectionSummary()!.connectedByTag.get("Интерфейсы")).toBeUndefined();
    expect(isCardLitByCollection(2)).toBe(false);
  });

  it("ends with an empty selection", () => {
    setSelectedCards([{ id: 1, slug: "one" }]);
    setSelectedCards([]);
    expect(getCardSelectionSummary()).toBeNull();
  });
});
