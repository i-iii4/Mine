import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetailMotionGateContext, type DetailMotionGate } from "@/components/detailMotionGate";
import type { CardAssociationGroup, CardAssociations } from "@/types";
import { useCardAssociations } from "./useCardAssociations";

const commands = vi.hoisted(() => ({
  listCardAssociations: vi.fn<(slug: string, exclude: string[]) => Promise<CardAssociations>>(),
}));

vi.mock("@/lib/commands", () => ({
  listCardAssociations: commands.listCardAssociations,
}));

const GROUP: CardAssociationGroup = { kind: "site", label: "example.com", blocks: [] };

function answer(slug: string, generation: number, groups: CardAssociationGroup[] = [GROUP]): CardAssociations {
  return { slug, generation, groups };
}

/** A window that holds every update until it rests (SPEC_CARD_PEEK.md, О12). */
function movingWindow() {
  const held: (() => void)[] = [];
  const gate: DetailMotionGate = {
    defer: (update) => { held.push(update); },
    track: (work) => work,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DetailMotionGateContext.Provider value={gate}>{children}</DetailMotionGateContext.Provider>
  );
  const rest = () => act(() => { for (const update of held.splice(0)) update(); });
  return { wrapper, rest, held };
}

/// The open card's association groups (SPEC_CARD_ASSOCIATIONS.md, «Загрузка
/// и обновление»), held back while the card's window moves.
describe("useCardAssociations", () => {
  beforeEach(() => {
    commands.listCardAssociations.mockReset();
  });

  it("asks nothing while the Related notes are not known", () => {
    const { result } = renderHook(() => useCardAssociations("card", null));
    expect(commands.listCardAssociations).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("shows the groups as they arrive outside the card's window", async () => {
    commands.listCardAssociations.mockResolvedValue(answer("card", 1));
    const { result } = renderHook(() => useCardAssociations("card", ["related"]));
    await waitFor(() => expect(result.current).toEqual([GROUP]));
    expect(commands.listCardAssociations).toHaveBeenCalledWith("card", ["related"]);
  });

  it("lands the groups once the card's window rests (SPEC_CARD_PEEK.md, О12)", async () => {
    commands.listCardAssociations.mockResolvedValue(answer("card", 1));
    const peek = movingWindow();
    const { result } = renderHook(() => useCardAssociations("card", []), { wrapper: peek.wrapper });
    await waitFor(() => expect(peek.held).toHaveLength(1));
    expect(result.current).toEqual([]);
    peek.rest();
    expect(result.current).toEqual([GROUP]);
  });

  it("keeps the newer answer over an older one, and asks again on vault-refreshed", async () => {
    commands.listCardAssociations.mockResolvedValueOnce(answer("card", 5));
    const { result } = renderHook(() => useCardAssociations("card", []));
    await waitFor(() => expect(result.current).toEqual([GROUP]));

    commands.listCardAssociations.mockResolvedValueOnce(answer("card", 4, []));
    act(() => { window.dispatchEvent(new Event("vault-refreshed")); });
    await waitFor(() => expect(commands.listCardAssociations).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(result.current).toEqual([GROUP]);
  });
});
