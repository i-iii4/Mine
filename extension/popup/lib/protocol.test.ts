import { describe, expect, it, vi } from "vitest";
import { baselineSaveRequest, negotiateSaveProtocol, validateSaveRequest } from "./protocol";
import { standaloneSave } from "./standalone";

describe("independent save compatibility", () => {
  it("does not dispatch a rejected standalone save to the filesystem owner", async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    try {
      expect(await standaloneSave({ operation_id: "rejected", save_protocol: 3 })).toMatchObject({ terminal_rejected: true, operation_id: "rejected", code: "incompatible_protocol" });
      expect(sendMessage).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("accepts transition fields absent and rejects mandatory unknown requirements with terminal identity", () => {
    expect(validateSaveRequest({ operation_id: "legacy" })).toBeNull();
    expect(validateSaveRequest({ save_protocol: 1, required_capabilities: ["save_operation_v1"] })).toBeNull();
    for (const requirements of [{ save_protocol: 2 }, { required_capabilities: ["future"] }, { required_capabilities: null }]) {
      expect(validateSaveRequest({ operation_id: "save-id", ...requirements })).toMatchObject({ ok: false, terminal_rejected: true, operation_id: "save-id", outcome: "not_committed" });
    }
  });
  const features = ["save_operation_v1", "operation_lookup_v1"];
  it("retains baseline across different app versions and extra capabilities", () => {
    for (const version of ["0.1.0", "9.2.1"]) {
      expect(negotiateSaveProtocol({ ok: true, version, features: [...features, "future_optional"], save_protocols: [1, 2] })).toBe(1);
    }
  });
  it("keeps the transition host with baseline capabilities usable", () => {
    expect(negotiateSaveProtocol({ ok: true, features })).toBe(1);
  });
  it("does not downgrade an explicitly unsupported protocol list", () => {
    expect(negotiateSaveProtocol({ ok: true, features, save_protocols: [2] })).toBeNull();
    expect(negotiateSaveProtocol({ ok: true, features: [features[0]!], save_protocols: [1] })).toBeNull();
  });
  it("pins protocol and capability requirements without changing source input", () => {
    const payload = { action: "save_block", title: "Draft", body: "Source" };
    expect(baselineSaveRequest(payload)).toEqual({ ...payload, save_protocol: 1, required_capabilities: features });
    expect(payload).not.toHaveProperty("save_protocol");
  });
});
