import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAppOpenRequest } from "./useAppOpenRequest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), select: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/commands", () => ({ selectVault: mocks.select }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockResolvedValue(null);
  mocks.select.mockResolvedValue(undefined);
});
it("retains cold-start requests until initial startup finishes", async () => {
  const selected = vi.fn();
  mocks.invoke.mockResolvedValueOnce("/tmp/Моё пространство");
  const hook = renderHook(({ready}) => useAppOpenRequest(ready, selected), {initialProps:{ready:false}});
  expect(mocks.invoke).not.toHaveBeenCalled();
  hook.rerender({ready:true});
  await waitFor(() => expect(selected).toHaveBeenCalledWith("/tmp/Моё пространство"));
  expect(mocks.select).toHaveBeenCalledTimes(1);
  expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0]);
});
it("switches an already-running app when notified", async () => {
  const selected = vi.fn();
  renderHook(() => useAppOpenRequest(true, selected));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  mocks.invoke.mockResolvedValueOnce("/tmp/Other");
  await act(async () => mocks.listen.mock.calls[0][1]());
  await waitFor(() => expect(selected).toHaveBeenCalledWith("/tmp/Other"));
});
it("reports failed switches without replacing the current space", async () => {
  mocks.invoke.mockResolvedValueOnce("/tmp/Missing");
  mocks.select.mockRejectedValue(new Error("Folder missing"));
  const selected = vi.fn();
  const hook = renderHook(() => useAppOpenRequest(true, selected));
  await waitFor(() => expect(hook.result.current).toContain("Folder missing"));
  expect(selected).not.toHaveBeenCalled();
});
