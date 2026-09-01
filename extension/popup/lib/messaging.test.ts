import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendToNative } from "./messaging";

beforeEach(() => {
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn((_message: unknown, callback: (response?: unknown) => void) => {
      runtime.lastError = { message: "A listener indicated an asynchronous response, but the message channel closed before a response was received." };
      callback();
      runtime.lastError = undefined;
    }),
  };
  (globalThis as Record<string, unknown>).chrome = { runtime };
});

describe("popup runtime transport", () => {
  it("maps a restarted background worker separately from native-host availability", async () => {
    await expect(sendToNative({ action: "get_status" })).resolves.toMatchObject({
      ok: false,
      code: "extension_transport",
      error: "Mine extension background stopped before replying. Retry this action.",
      transport_error: expect.stringContaining("message channel closed"),
    });
  });
});
