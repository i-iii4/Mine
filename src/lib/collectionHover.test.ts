import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOVER_LEAVE_GRACE_MS,
  isCardLitByCollection,
  isRowConnectedToHoveredCard,
  releaseHoveredCard,
  releaseHoveredCollectionRow,
  resetCollectionHover,
  setCollectionMemberships,
  setHoveredCard,
  setHoveredCollectionRow,
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
