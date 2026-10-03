// The places of a tab behind its back and forward buttons (SPEC_TABS.md, В81).

import { describe, expect, it } from "vitest";
import {
  EMPTY_PLACE_HISTORY,
  PLACE_HISTORY_LIMIT,
  historyDirections,
  recordPlace,
  settlePlace,
  stepPlace,
  type Place,
  type PlaceHistory,
} from "./placeHistory";

const everything: Place = { tag: null, card: null };
const alpha: Place = { tag: "alpha", card: null };
const alphaCard: Place = { tag: "alpha", card: "alpha-block" };

function through(...places: Place[]): PlaceHistory {
  return places.reduce(recordPlace, EMPTY_PLACE_HISTORY);
}

describe("place history", () => {
  it("has nowhere to go before and at the first place", () => {
    expect(historyDirections(EMPTY_PLACE_HISTORY)).toEqual({ back: false, forward: false });
    expect(historyDirections(through(everything))).toEqual({ back: false, forward: false });
  });

  it("goes back through Everything, a collection and a card, and forward again", () => {
    const history = through(everything, alpha, alphaCard);
    expect(historyDirections(history)).toEqual({ back: true, forward: false });

    const back = stepPlace(history, false);
    expect(back?.target).toEqual(alpha);
    const twice = stepPlace(back!.history, false);
    expect(twice?.target).toEqual(everything);
    expect(historyDirections(twice!.history)).toEqual({ back: false, forward: true });
    expect(stepPlace(twice!.history, false)).toBeNull();

    expect(stepPlace(twice!.history, true)?.target).toEqual(alpha);
  });

  it("records nothing for standing still", () => {
    expect(through(alpha, alpha)).toEqual(through(alpha));
  });

  it("drops the places ahead when the tab goes somewhere new", () => {
    const back = stepPlace(through(everything, alpha, alphaCard), false)!.history;
    const elsewhere = recordPlace(back, { tag: "beta", card: null });
    expect(elsewhere.entries).toEqual([everything, alpha, { tag: "beta", card: null }]);
    expect(historyDirections(elsewhere)).toEqual({ back: true, forward: false });
  });

  it("keeps the newest places within the limit", () => {
    const places = Array.from({ length: PLACE_HISTORY_LIMIT + 5 }, (_, index) => ({ tag: `t${index}`, card: null }));
    const history = through(...places);
    expect(history.entries).toHaveLength(PLACE_HISTORY_LIMIT);
    expect(history.entries[0]).toEqual({ tag: "t5", card: null });
    expect(history.index).toBe(PLACE_HISTORY_LIMIT - 1);
  });

  it("takes the place a step reached when the asked one is gone", () => {
    const back = stepPlace(through(everything, alphaCard, alpha), false)!.history;
    const settled = settlePlace(back, alpha);
    expect(settled.entries).toEqual([everything, alpha, alpha]);
    expect(settled.index).toBe(1);
  });
});
