import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  GRAPH_PREFERENCES_STORAGE_KEY,
  reloadGraphPreferences,
  setGraphPreference,
} from "@/lib/graphPreferences";
import { GraphSection } from "./GraphSection";

const emitMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock,
}));

describe("GraphSection (SPEC_GRAPH_VIEW.md, «Панель графа»)", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
    emitMock.mockClear();
  });

  afterEach(() => {
    localStorage.clear();
    reloadGraphPreferences();
  });

  it("offers the two extra links, both on by default, and no switch for collections", () => {
    render(<GraphSection />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Wikilinks" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Related notes" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Collections" })).not.toBeInTheDocument();
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
  });

  it("updates the one shared preference object and broadcasts its key", () => {
    render(<GraphSection />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Wikilinks" }));

    expect(screen.getByRole("checkbox", { name: "Wikilinks" })).not.toBeChecked();
    expect(JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY)!)).toEqual({
      include_wikilinks: false,
      include_related_notes: true,
    });
    expect(emitMock).toHaveBeenCalledWith(
      "settings-changed",
      expect.objectContaining({ key: GRAPH_PREFERENCES_STORAGE_KEY }),
    );
  });

  it("follows a change made through the graph's panel at once", () => {
    render(<GraphSection />);

    act(() => setGraphPreference("include_related_notes", false));

    expect(screen.getByRole("checkbox", { name: "Related notes" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Wikilinks" })).toBeChecked();
  });
});
