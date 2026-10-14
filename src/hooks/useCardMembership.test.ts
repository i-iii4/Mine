import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBlock } from "@/lib/commands";
import { indexedBlock, lightBlock } from "@/test/blocks";
import { useCardMembership } from "./useCardMembership";

vi.mock("@/lib/commands", () => ({ getBlock: vi.fn() }));

const card = lightBlock({ slug: "note", collections: ["alpha"] });

/// SPEC_DEEP_AUDIT.md, Е6.12: a card's menu shows the collections the feed
/// knows from the first frame; the file read while the menu is open replaces
/// them, and a read that fails leaves them.
describe("useCardMembership", () => {
  beforeEach(() => {
    vi.mocked(getBlock).mockReset();
  });

  it("shows the collections the feed knows while the read has not answered", () => {
    vi.mocked(getBlock).mockImplementation(() => new Promise<never>(() => {}));
    const { result } = renderHook(() => useCardMembership(card, true));
    expect(result.current).toEqual(["alpha"]);
    expect(getBlock).toHaveBeenCalledWith("note");
  });

  it("replaces them with the collections the card's file names", async () => {
    vi.mocked(getBlock).mockResolvedValue(indexedBlock({ slug: "note", tags: ["alpha", "beta"] }));
    const { result } = renderHook(() => useCardMembership(card, true));
    await waitFor(() => expect(result.current).toEqual(["alpha", "beta"]));
  });

  it("keeps the collections the feed knows when the read fails", async () => {
    vi.mocked(getBlock).mockRejectedValue(new Error("unreadable"));
    const { result } = renderHook(() => useCardMembership(card, true));
    await waitFor(() => expect(getBlock).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current).toEqual(["alpha"]);
  });

  it("reads nothing while the menu is closed", () => {
    const { result } = renderHook(() => useCardMembership(card, false));
    expect(result.current).toEqual(["alpha"]);
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("never shows the answer for another card", async () => {
    vi.mocked(getBlock).mockResolvedValueOnce(indexedBlock({ slug: "note", tags: ["beta"] }));
    const { result, rerender } = renderHook(({ block }) => useCardMembership(block, true), { initialProps: { block: card } });
    await waitFor(() => expect(result.current).toEqual(["beta"]));
    vi.mocked(getBlock).mockImplementation(() => new Promise<never>(() => {}));
    rerender({ block: lightBlock({ slug: "other", collections: ["gamma"] }) });
    expect(result.current).toEqual(["gamma"]);
  });
});
