import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_PREFERENCES,
  getStoredGraphPreferences,
  GRAPH_PREFERENCES_STORAGE_KEY,
  storeGraphPreferences,
} from "./graphPreferences";

describe("graphPreferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults every graph layer to visible", () => {
    expect(getStoredGraphPreferences()).toEqual(DEFAULT_GRAPH_PREFERENCES);
  });

  it("roundtrips one persisted preference object", () => {
    const preferences = {
      include_collections: false,
      include_wikilinks: true,
      include_related_notes: false,
    };

    storeGraphPreferences(preferences);

    expect(getStoredGraphPreferences()).toEqual(preferences);
    expect(JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY)!)).toEqual(
      preferences,
    );
  });

  it("repairs malformed and partial values with contract defaults", () => {
    localStorage.setItem(GRAPH_PREFERENCES_STORAGE_KEY, "{bad");
    expect(getStoredGraphPreferences()).toEqual(DEFAULT_GRAPH_PREFERENCES);

    localStorage.setItem(
      GRAPH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ include_wikilinks: false, include_related_notes: "no" }),
    );
    expect(getStoredGraphPreferences()).toEqual({
      include_collections: true,
      include_wikilinks: false,
      include_related_notes: true,
    });
  });
});
