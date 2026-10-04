import { beforeEach, describe, expect, it, vi } from "vitest";

const { native, save, lookup } = vi.hoisted(() => ({ native: vi.fn(), save: vi.fn(), lookup: vi.fn() }));
vi.mock("./messaging", () => ({ sendToNative: native }));
vi.mock("./standalone", () => ({ standaloneSave: save, standaloneLookup: lookup }));
import { clearCommittedSaves, clearPendingSave, executePinnedSave, findPendingSave, persistPendingSave, persistSaveReceipt, type PinnedSaveOperation } from "./saveOperation";

function operation(executor: "native" | "browser" = "native"): PinnedSaveOperation {
  return { id: "same-operation", executor, bindingId: "same-folder", vaultPath: executor === "native" ? "/v" : null,
    payload: { action: "save_block", title: "Original", url: "https://example.com" }, attempted: false };
}
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortedKeys(item)]));
}

beforeEach(() => vi.resetAllMocks());

describe("pinned save operation", () => {
  it("confirms a pending operation when storage reorders nested object keys", async () => {
    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }),
      set: async (records: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(records)) values[key] = sortedKeys(value);
      },
    } } });
    await persistPendingSave(operation());
    expect(await findPendingSave("https://example.com")).toMatchObject({ attempted: true, id: "same-operation" });
    vi.unstubAllGlobals();
  });

  it("confirms a committed receipt when storage reorders nested object keys", async () => {
    const values: Record<string, unknown> = { "minePendingSaveOperation:same-operation": operation() };
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }),
      set: async (records: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(records)) values[key] = sortedKeys(value);
      },
    } } });
    const pinned = operation();
    await persistSaveReceipt(pinned, { ok: true, outcome: "committed", slug: "Cards/Once" });
    // Settled: the page has nothing left to check (SPEC_CLIPPER_DRAFTS_REMOVAL.md, Ч4).
    expect(await findPendingSave("https://example.com")).toBeNull();
    expect(await executePinnedSave(pinned)).toMatchObject({ outcome: "committed", slug: "Cards/Once" });
    expect(native).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects a pending operation readback that changes content or attachment order", async () => {
    const pinned = operation();
    pinned.payload = { ...pinned.payload!, tags: ["B", "A"] };
    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }),
      set: async () => { values["minePendingSaveOperation:same-operation"] = {
        ...pinned, schemaVersion: 1, attempted: true, payload: { ...pinned.payload, tags: ["A", "B"] },
      }; },
    } } });
    await expect(persistPendingSave(pinned)).rejects.toThrow("could not be confirmed");
    expect(native).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

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
    await persistPendingSave(operation());
    await expect(persistPendingSave({ ...operation(), payload: { action: "save_block", title: "Changed" } })).rejects.toThrow("already stored");
    vi.unstubAllGlobals();
  });

  it("confirms the same identity after the original pending readback was interrupted", async () => {
    const values: Record<string, unknown> = {};
    let reads = 0;
    const set = vi.fn(async (records: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(records)) values[key] = sortedKeys(value);
    });
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => {
        reads += 1;
        if (reads === 2) throw new Error("Pending readback interrupted");
        return { ...values };
      }, set,
    } } });
    const prepared = operation();
    await expect(persistPendingSave(prepared)).rejects.toThrow("Pending readback interrupted");
    expect(prepared.attempted).toBe(false);
    await persistPendingSave(prepared);
    expect(set).toHaveBeenCalledTimes(1);
    expect(prepared.attempted).toBe(false);
    expect(await findPendingSave("https://example.com")).toMatchObject({ attempted: true, id: prepared.id });
    expect(native).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not replace a committed receipt when confirming a prepared operation again", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({
      "minePendingSaveOperation:same-operation": {
        ...operation(), schemaVersion: 1, attempted: true, terminalResult: { ok: true, outcome: "committed" },
      },
    }), set: vi.fn() } } });
    await expect(persistPendingSave(operation())).rejects.toThrow("already stored");
    await expect(persistPendingSave({ ...operation(), terminalResult: { ok: true, outcome: "committed" } })).rejects.toThrow("already stored");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
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

  it.each(["envelope", "legacy payload"])("preserves an unrelated unknown format identified by its %s without blocking this page", async (source) => {
    const unrelated = { ...operation(), schemaVersion: 2,
      ...(source === "envelope"
        ? { sourceUrl: "https://example.com/other", payload: null }
        : { payload: { action: "save_block", url: "https://example.com/other" } }),
    };
    const values: Record<string, unknown> = { "minePendingSaveOperation:older": unrelated };
    const remove = vi.fn();
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => structuredClone(values),
      set: async (records: Record<string, unknown>) => { Object.assign(values, structuredClone(records)); },
      remove,
    } } });
    expect(await findPendingSave("https://example.com")).toBeNull();
    const current = operation();
    await persistPendingSave(current);
    native.mockResolvedValue({ ok: true, outcome: "committed", slug: "Current" });
    expect(await executePinnedSave(current)).toMatchObject({ outcome: "committed" });
    expect(await findPendingSave("https://example.com")).toMatchObject({ id: current.id });
    expect(values["minePendingSaveOperation:older"]).toEqual(unrelated);
    expect(remove).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation_id: current.id, url: "https://example.com" }));
    vi.unstubAllGlobals();
  });

  it("does not assume an unknown record without source identity belongs to another page", async () => {
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({
      "minePendingSaveOperation:unidentified": { ...operation(), schemaVersion: 2, payload: null },
    }) } } });
    await expect(findPendingSave("https://example.com/other")).rejects.toThrow("unknown pending save format");
    expect(native).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("a committed receipt left by a failed removal never blocks the page and goes on the next opening (Т6)", async () => {
    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }), set: async (record: Record<string, unknown>) => { Object.assign(values, record); },
      remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete values[key]; },
    } } });
    const pinned = operation();
    await persistPendingSave(pinned);
    await persistSaveReceipt(pinned, { ok: true, outcome: "committed", slug: "Cards/Once" });
    expect(await findPendingSave("https://example.com")).toBeNull();
    await clearCommittedSaves();
    expect(values).toEqual({});
    expect(native).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("removes only committed records: an unresolved save and an unknown format stay", async () => {
    const unresolved = { ...operation(), id: "unresolved", schemaVersion: 1, attempted: true };
    const unknown = { ...operation(), id: "unknown", schemaVersion: 2, terminalResult: { ok: true } };
    const values: Record<string, unknown> = {
      "minePendingSaveOperation:committed": { ...operation(), id: "committed", schemaVersion: 1, attempted: true, terminalResult: { ok: false, outcome: "committed" } },
      "minePendingSaveOperation:unresolved": unresolved,
      "minePendingSaveOperation:unknown": unknown,
      mineSaveDestination: { executor: "native", vaultPath: "/v", bindingId: "same-folder" },
    };
    vi.stubGlobal("chrome", { storage: { local: {
      get: async () => ({ ...values }),
      remove: async (keys: string | string[]) => { for (const key of [keys].flat()) delete values[key]; },
    } } });
    await clearCommittedSaves();
    expect(Object.keys(values).sort()).toEqual([
      "minePendingSaveOperation:unknown", "minePendingSaveOperation:unresolved", "mineSaveDestination",
    ]);
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
