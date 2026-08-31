import { beforeEach, describe, expect, it, vi } from "vitest";

const { native, save, lookup } = vi.hoisted(() => ({ native: vi.fn(), save: vi.fn(), lookup: vi.fn() }));
vi.mock("./messaging", () => ({ sendToNative: native }));
vi.mock("./standalone", () => ({ standaloneSave: save, standaloneLookup: lookup }));
import { executePinnedSave, findPendingSave, type PinnedSaveOperation } from "./saveOperation";

function operation(executor: "native" | "browser" = "native"): PinnedSaveOperation {
  return { id: "same-operation", executor, bindingId: "same-folder", vaultPath: executor === "native" ? "/v" : null,
    payload: { action: "save_block", title: "Original", url: "https://example.com" }, attempted: false };
}

beforeEach(() => vi.resetAllMocks());

describe("pinned save operation", () => {
  it("uses read-only lookup after a lost native response, without fallback", async () => {
    native.mockResolvedValueOnce({ ok: false, outcome: "unknown" }).mockResolvedValue({ ok: true, outcome: "committed" });
    const pinned = operation();
    expect(await executePinnedSave(pinned)).toMatchObject({ outcome: "committed" });
    expect(native.mock.calls[0]![0]).toMatchObject({ action: "save_block", operation_id: "same-operation", binding_id: "same-folder", vault_path: "/v" });
    expect(native.mock.calls[1]![0]).toMatchObject({ action: "get_save_operation", operation_id: "same-operation", vault_path: "/v" });
    expect(save).not.toHaveBeenCalled();
  });

  it("does not interpret not_committed conflict as permission to create another operation", async () => {
    native.mockResolvedValueOnce({ ok: false, outcome: "not_committed", code: "operation_conflict" })
      .mockResolvedValue({ ok: false, outcome: "unknown" });
    const pinned = operation();
    await executePinnedSave(pinned);
    await executePinnedSave(pinned);
    expect(native.mock.calls.map(([request]) => request.action)).toEqual(["save_block", "get_save_operation"]);
  });

  it("resumes only an explicitly resumable prepared record, preserving the exact request", async () => {
    const pinned = operation("browser");
    pinned.attempted = true;
    lookup.mockResolvedValue({ ok: false, outcome: "not_committed", resumable: true });
    save.mockResolvedValue({ ok: true, outcome: "committed" });
    await executePinnedSave(pinned);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ mode: "resume", operation_id: "same-operation", binding_id: "same-folder", title: "Original" }));
    expect(native).not.toHaveBeenCalled();
  });

  it("keeps an identity-only damaged record discoverable and lookup-only", async () => {
    const damaged = { ...operation(), payload: null, sourceUrl: "https://example.com" };
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({ "minePendingSaveOperation:same-operation": damaged }) } } });
    const found = await findPendingSave("https://example.com");
    expect(found).toMatchObject({ id: "same-operation", payload: null });
    native.mockResolvedValue({ ok: false, outcome: "not_committed", resumable: true });
    await executePinnedSave(found!);
    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]![0].action).toBe("get_save_operation");
    vi.unstubAllGlobals();
  });
});
