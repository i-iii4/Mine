import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateBlockParams, IndexedBlock } from "@/types";
import { clearActionFailures, useActionFailures } from "./actionFailures";
import { createBlock } from "./commands";
import { createElementsInTurn, otherElementsCreatedText } from "./createElements";

vi.mock("./commands", () => ({ createBlock: vi.fn() }));

function file(path: string): CreateBlockParams {
  return { block_type: "image", title: null, url: null, tags: [], file_path: path };
}
const PASTED: CreateBlockParams = { block_type: "text", title: null, url: null, tags: [], file_path: null, body: "" };

afterEach(() => {
  act(() => clearActionFailures());
  vi.mocked(createBlock).mockReset();
});

// New elements from a drop of files and from ⌘V: in order, past a file that
// fails, a later drop waits its turn, and the tab's notice names what failed
// and counts what came in (SPEC_DEEP_AUDIT.md, Е6.4, Е6.5; DESIGN_SYSTEM.md,
// «Сбой после закрытия окна»).
describe("createElementsInTurn", () => {
  it("goes on past a failure and names every element that failed", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(createBlock).mockImplementation(async (params) => {
      if (params.file_path === "/drop/b.png") throw new Error("Too big.");
      if (params.file_path === null) throw new Error("Nothing to paste.");
      return {} as IndexedBlock;
    });

    let outcome: Awaited<ReturnType<typeof createElementsInTurn>> | undefined;
    await act(async () => {
      outcome = await createElementsInTurn([file("/drop/a.png"), file("/drop/b.png"), PASTED, file("/drop/c.png")]);
    });

    expect(vi.mocked(createBlock).mock.calls.map(([params]) => params.file_path))
      .toEqual(["/drop/a.png", "/drop/b.png", null, "/drop/c.png"]);
    expect(outcome).toEqual({
      created: 2,
      failures: [{ label: "b.png", message: "Too big." }, { label: null, message: "Nothing to paste." }],
    });
    expect(result.current).toEqual([{
      kind: "create-elements",
      title: "Could not create 2 elements",
      summary: "2 other elements were created.",
      messages: ["“b.png”: Too big.", "Nothing to paste."],
    }]);
  });

  it("makes a second drop wait until the first is added", async () => {
    let finishFirst: (() => void) | undefined;
    vi.mocked(createBlock).mockImplementation((params) => (params.file_path === "/drop/first.png"
      ? new Promise<IndexedBlock>((resolve) => { finishFirst = () => resolve({} as IndexedBlock); })
      : Promise.resolve({} as IndexedBlock)));

    const first = createElementsInTurn([file("/drop/first.png")]);
    const second = createElementsInTurn([file("/drop/second.png")]);
    await waitFor(() => expect(createBlock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(createBlock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst?.();
      await first;
    });
    await expect(second).resolves.toEqual({ created: 1, failures: [] });
    expect(vi.mocked(createBlock).mock.calls.map(([params]) => params.file_path))
      .toEqual(["/drop/first.png", "/drop/second.png"]);
  });

  it("takes the notice away once elements are created", async () => {
    const { result } = renderHook(() => useActionFailures());
    vi.mocked(createBlock).mockRejectedValueOnce(new Error("Disk full."));
    await act(async () => {
      await createElementsInTurn([file("/drop/one.png")]);
    });
    expect(result.current).toEqual([{
      kind: "create-elements", title: "Could not create an element", summary: undefined, messages: ["“one.png”: Disk full."],
    }]);

    vi.mocked(createBlock).mockResolvedValueOnce({} as IndexedBlock);
    await act(async () => {
      await createElementsInTurn([file("/drop/one.png")]);
    });
    expect(result.current).toEqual([]);
  });

  it("counts one other element in the singular", () => {
    expect(otherElementsCreatedText(1)).toBe("1 other element was created.");
    expect(otherElementsCreatedText(3)).toBe("3 other elements were created.");
  });
});
