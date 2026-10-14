import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSpaces, spacesInTabs } from "@/lib/commands";
import type { SpaceEntry } from "@/types";
import { useOpenSpaces } from "./useOpenSpaces";

vi.mock("@/lib/commands", () => ({ listSpaces: vi.fn(), spacesInTabs: vi.fn() }));

const MINE: SpaceEntry = { vault_id: "id-mine", path: "/Users/me/Mine", name: "Mine", available: true, current: true };
const ARCHIVE: SpaceEntry = { vault_id: "id-archive", path: "/Users/me/Archive", name: "Archive", available: true, current: false };

/// SPEC_TABS.md, В71: the settings sections choose among the spaces some tab
/// shows. A failure is told in the words of the error, never `String(e)`,
/// which gave `[object Object]` for a typed refusal (SPEC_DEEP_AUDIT.md, Е6.15).
describe("useOpenSpaces", () => {
  beforeEach(() => {
    vi.mocked(listSpaces).mockReset();
    vi.mocked(spacesInTabs).mockReset();
  });

  it("lists the open spaces in the order the tabs give and chooses the first", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue(["id-archive", "id-mine"]);
    vi.mocked(listSpaces).mockResolvedValue([MINE, ARCHIVE]);
    const { result } = renderHook(() => useOpenSpaces());
    expect(result.current.spaces).toBeNull();
    await waitFor(() => expect(result.current.spaces?.map((space) => space.name)).toEqual(["Archive", "Mine"]));
    expect(result.current.current?.vaultId).toBe("id-archive");
    expect(result.current.error).toBeNull();
  });

  it("says what failed in the words of a typed refusal", async () => {
    vi.mocked(spacesInTabs).mockRejectedValue({ kind: "internal", message: "The space registry is unreadable." });
    vi.mocked(listSpaces).mockResolvedValue([]);
    const { result } = renderHook(() => useOpenSpaces());
    await waitFor(() => expect(result.current.error).toBe("The space registry is unreadable."));
    expect(result.current.spaces).toEqual([]);
  });

  it("says what failed in the words of an error, without its name", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([]);
    vi.mocked(listSpaces).mockRejectedValue(new Error("No space list."));
    const { result } = renderHook(() => useOpenSpaces());
    await waitFor(() => expect(result.current.error).toBe("No space list."));
  });
});
