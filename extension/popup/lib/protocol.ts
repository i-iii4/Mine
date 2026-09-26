import type { NativeRequest, NativeResponse } from "./messaging";
import "../../lib/saveProtocol.js";

const BASE_PROTOCOL = 1;
const REQUIRED_CAPABILITIES = ["save_operation_v1", "operation_lookup_v1"];

export function validateSaveRequest(request: Record<string, unknown>): NativeResponse | null {
  return (globalThis as unknown as { MineSaveProtocol: { validate: (value: Record<string, unknown>) => NativeResponse | null } }).MineSaveProtocol.validate(request);
}

/** Agree on the baseline independently of application and extension versions. */
export function negotiateSaveProtocol(status: NativeResponse): number | null {
  if (!status.ok || !REQUIRED_CAPABILITIES.every(feature => status.features?.includes(feature))) return null;
  // Transition hosts already advertised baseline capabilities before adding
  // a protocol list. An explicit unknown list must never use that fallback.
  if (status.save_protocols === undefined) return BASE_PROTOCOL;
  return Array.isArray(status.save_protocols) && status.save_protocols.includes(BASE_PROTOCOL) ? BASE_PROTOCOL : null;
}

/** Pin the negotiated protocol and required capabilities into the operation. */
export function baselineSaveRequest(payload: NativeRequest, protocol = BASE_PROTOCOL): NativeRequest {
  return { ...payload, save_protocol: protocol, required_capabilities: [...REQUIRED_CAPABILITIES] };
}

/** A widget carries its compiled identity even in a tab opened before update. */
export function negotiateWidgetProtocol(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mine extension background did not confirm this widget. The saved draft is preserved. Reload the page and retry.")), 10_000);
    chrome.runtime.sendMessage({ target: "background", action: "clipperHandshake",
      build_id: import.meta.env.VITE_MINE_BUILD_ID ?? "unbuilt",
      commit: import.meta.env.VITE_MINE_BUILD_COMMIT ?? "unknown",
      save_protocols: [BASE_PROTOCOL], features: REQUIRED_CAPABILITIES, required_capabilities: REQUIRED_CAPABILITIES,
    }, (response: NativeResponse | undefined) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!response || negotiateSaveProtocol(response) === null) {
        reject(new Error(response?.error ?? "The Mine widget and extension do not share a save protocol. Its saved draft has been preserved."));
        return;
      }
      resolve();
    });
  });
}
