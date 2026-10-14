import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CollectionNameCheckContext,
  useCollectionNameCheck,
  useCollectionNameRefusal,
  type CollectionNameCheck,
} from "./useCollectionNameRefusal";

/** A check whose answers the test gives, one per name asked. */
function pendingCheck() {
  const answers = new Map<string, { resolve: (refusal: string | null) => void; reject: (error: unknown) => void }>();
  const check = vi.fn<CollectionNameCheck>((name) => new Promise((resolve, reject) => answers.set(name, { resolve, reject })));
  return { check, answer: (name: string) => answers.get(name)! };
}

/// SPEC_DEEP_AUDIT.md, Е6.2: every place a collection is named asks the one
/// check as the name is typed. The answer for an earlier name never speaks
/// for the current one, and a check that could not answer refuses nothing.
describe("useCollectionNameRefusal", () => {
  it("refuses the name the check refuses", async () => {
    const { check, answer } = pendingCheck();
    const { result } = renderHook(() => useCollectionNameRefusal("Inbox", check));
    expect(result.current).toBeNull();
    answer("Inbox").resolve("A collection named Inbox exists.");
    await waitFor(() => expect(result.current).toBe("A collection named Inbox exists."));
  });

  it("does not let the answer for an earlier name speak for the current one", async () => {
    const { check, answer } = pendingCheck();
    const { result, rerender } = renderHook(({ name }) => useCollectionNameRefusal(name, check), { initialProps: { name: "Inbo" } });
    rerender({ name: "Inbox" });
    answer("Inbo").resolve("Refused for the earlier name.");
    await Promise.resolve();
    expect(result.current).toBeNull();
    answer("Inbox").resolve(null);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();
  });

  it("refuses nothing when the check fails", async () => {
    const { check, answer } = pendingCheck();
    const { result } = renderHook(() => useCollectionNameRefusal("Inbox", check));
    answer("Inbox").reject(new Error("no index"));
    await waitFor(() => expect(check).toHaveBeenCalledWith("Inbox"));
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it("asks nothing for an empty name or without a check", () => {
    const { check } = pendingCheck();
    expect(renderHook(() => useCollectionNameRefusal("", check)).result.current).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(renderHook(() => useCollectionNameRefusal("Inbox", undefined)).result.current).toBeNull();
  });
});

describe("useCollectionNameCheck", () => {
  it("takes the check it is given, else the app's", () => {
    const app: CollectionNameCheck = async () => null;
    const given: CollectionNameCheck = async () => "refused";
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CollectionNameCheckContext.Provider value={app}>{children}</CollectionNameCheckContext.Provider>
    );
    expect(renderHook(() => useCollectionNameCheck(undefined), { wrapper }).result.current).toBe(app);
    expect(renderHook(() => useCollectionNameCheck(given), { wrapper }).result.current).toBe(given);
    expect(renderHook(() => useCollectionNameCheck(undefined)).result.current).toBeUndefined();
  });
});
