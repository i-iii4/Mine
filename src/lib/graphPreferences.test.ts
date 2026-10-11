import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import {
  DEFAULT_GRAPH_PREFERENCES,
  getGraphPreferences,
  getStoredGraphPreferences,
  GRAPH_PREFERENCES_STORAGE_KEY,
  reloadGraphPreferences,
  setGraphPreference,
  useGraphPreferences,
} from "./graphPreferences";

function stored(): unknown {
  return JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY) ?? "null");
}

describe("graphPreferences (SPEC_GRAPH_VIEW.md, «Панель графа»)", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
    vi.mocked(emit).mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
  });

  it("shows every extra link by default", () => {
    expect(getStoredGraphPreferences()).toEqual(DEFAULT_GRAPH_PREFERENCES);
    expect(DEFAULT_GRAPH_PREFERENCES).toEqual({
      include_wikilinks: true,
      include_related_notes: true,
    });
  });

  it("holds no preference for collections: a stored false for them is not read", () => {
    localStorage.setItem(
      GRAPH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        include_collections: false,
        include_wikilinks: true,
        include_related_notes: false,
      }),
    );

    expect(getStoredGraphPreferences()).toEqual({
      include_wikilinks: true,
      include_related_notes: false,
    });
    expect(getStoredGraphPreferences()).not.toHaveProperty("include_collections");
  });

  it("drops the old collections field with the next write and keeps it on read", () => {
    const legacy = JSON.stringify({
      include_collections: false,
      include_wikilinks: true,
      include_related_notes: true,
    });
    localStorage.setItem(GRAPH_PREFERENCES_STORAGE_KEY, legacy);
    reloadGraphPreferences();
    // Reading never rewrites what is stored.
    expect(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY)).toBe(legacy);

    setGraphPreference("include_wikilinks", false);

    expect(stored()).toEqual({ include_wikilinks: false, include_related_notes: true });
  });

  it("repairs malformed and partial values with the defaults", () => {
    localStorage.setItem(GRAPH_PREFERENCES_STORAGE_KEY, "{bad");
    expect(getStoredGraphPreferences()).toEqual(DEFAULT_GRAPH_PREFERENCES);

    localStorage.setItem(GRAPH_PREFERENCES_STORAGE_KEY, "[false, false]");
    expect(getStoredGraphPreferences()).toEqual(DEFAULT_GRAPH_PREFERENCES);

    localStorage.setItem(
      GRAPH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ include_wikilinks: false, include_related_notes: "no" }),
    );
    expect(getStoredGraphPreferences()).toEqual({
      include_wikilinks: false,
      include_related_notes: true,
    });
  });

  it("stores a switch, applies it on this page at once and announces it to the other windows", () => {
    const { result } = renderHook(() => useGraphPreferences());

    act(() => setGraphPreference("include_related_notes", false));

    expect(result.current).toEqual({ include_wikilinks: true, include_related_notes: false });
    expect(getGraphPreferences()).toEqual(result.current);
    expect(stored()).toEqual({ include_wikilinks: true, include_related_notes: false });
    expect(emit).toHaveBeenCalledExactlyOnceWith("settings-changed", {
      key: GRAPH_PREFERENCES_STORAGE_KEY,
      value: JSON.stringify({ include_wikilinks: true, include_related_notes: false }),
    });
  });

  it("does nothing when a switch is set to the value it has", () => {
    const { result } = renderHook(() => useGraphPreferences());
    const before = result.current;

    act(() => setGraphPreference("include_wikilinks", true));

    expect(result.current).toBe(before);
    expect(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY)).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("re-reads what another window stored, and publishes only a change", () => {
    const { result } = renderHook(() => useGraphPreferences());
    const before = result.current;

    // This page's own announcement comes back to it: an equal value keeps
    // the same object, so the graph asks for no new snapshot.
    act(() => reloadGraphPreferences());
    expect(result.current).toBe(before);

    localStorage.setItem(
      GRAPH_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ include_wikilinks: false, include_related_notes: true }),
    );
    act(() => reloadGraphPreferences());

    expect(result.current).toEqual({ include_wikilinks: false, include_related_notes: true });
    expect(emit).not.toHaveBeenCalled();
  });
});
