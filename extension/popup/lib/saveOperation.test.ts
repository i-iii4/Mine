import { beforeEach, describe, expect, it, vi } from "vitest";

const { native, save, lookup } = vi.hoisted(() => ({ native: vi.fn(), save: vi.fn(), lookup: vi.fn() }));
vi.mock("./messaging", () => ({ sendToNative: native }));
vi.mock("./standalone", () => ({ standaloneSave: save, standaloneLookup: lookup }));
import { clearPendingSave, executePinnedSave, findPendingSave, persistPendingSave, persistSaveReceipt, type PinnedSaveOperation } from "./saveOperation";

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

  it("confirms operation persistence before allowing dispatch", async () => {
    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }),
      set: async (record: Record<string, unknown>) => { Object.assign(values, record); },
    } } });
    await persistPendingSave(operation());
    expect(await findPendingSave("https://example.com")).toMatchObject({ attempted: true, id: "same-operation" });
    await expect(persistPendingSave(operation())).rejects.toThrow("already stored");
    vi.unstubAllGlobals();
  });

  it("refuses a lost acknowledgement and preserves unknown pending formats", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}), set: async () => undefined } } });
    await expect(persistPendingSave(operation())).rejects.toThrow("could not be confirmed");
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({
      "minePendingSaveOperation:same-operation": { ...operation(), schemaVersion: 2 },
    }) } } });
    await expect(findPendingSave("https://example.com")).rejects.toThrow("unknown pending save format");
    expect(native).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a committed receipt survives draft cleanup failure without repeating source writes", async () => {
    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }), set: async (record: Record<string, unknown>) => { Object.assign(values, record); },
    } } });
    const pinned = operation();
    await persistPendingSave(pinned);
    await persistSaveReceipt(pinned, { ok: true, outcome: "committed", slug: "Cards/Once" });
    const reopened = await findPendingSave("https://example.com");
    expect(await executePinnedSave(reopened!)).toMatchObject({ outcome: "committed", slug: "Cards/Once" });
    expect(native).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("an older sender cannot overwrite or clear an unknown operation format", async () => {
    const set = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({
      "minePendingSaveOperation:same-operation": { ...operation(), schemaVersion: 2 },
    }), set, remove } } });
    await expect(persistSaveReceipt(operation(), { ok: true, outcome: "committed" })).rejects.toThrow("preserved");
    await expect(clearPendingSave(operation())).rejects.toThrow("preserved");
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
