import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  GRAPH_PREFERENCES_STORAGE_KEY,
  storeGraphPreferences,
} from "@/lib/graphPreferences";
import { GraphSection } from "./GraphSection";

const emitMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tauri-apps/api/event", () => ({
  emit: emitMock,
}));

describe("GraphSection", () => {
  beforeEach(() => {
    localStorage.clear();
    emitMock.mockClear();
  });

  it("keeps all graph relation layers enabled by default", () => {
    render(<GraphSection />);

    expect(screen.getByRole("checkbox", { name: "Collections" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Wikilinks" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Related notes" })).toBeChecked();
  });

  it("updates one shared preference object and broadcasts its key", () => {
    storeGraphPreferences({
      include_collections: true,
      include_wikilinks: true,
      include_related_notes: true,
    });
    render(<GraphSection />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Wikilinks" }));

    expect(JSON.parse(localStorage.getItem(GRAPH_PREFERENCES_STORAGE_KEY)!)).toEqual({
      include_collections: true,
      include_wikilinks: false,
      include_related_notes: true,
    });
    expect(emitMock).toHaveBeenCalledWith("settings-changed", {
      key: GRAPH_PREFERENCES_STORAGE_KEY,
    });
  });
});
