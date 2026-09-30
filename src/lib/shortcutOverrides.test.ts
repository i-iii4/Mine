// Shortcut overrides reach the registry at startup without undoing a rebind
// that arrived while they were being read (SPEC_AUDIT_FIXES.md, Ф11, Б5.3).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import type { CommandBinding } from "./commandBinding";
import { commandById, getCommandOverrides, setCommandOverrides } from "./commandRegistry";
import { hydrateCommandOverrides } from "./shortcutOverrides";

const { listShortcutOverridesMock } = vi.hoisted(() => ({
  listShortcutOverridesMock: vi.fn<() => Promise<Record<string, CommandBinding>>>(),
}));

vi.mock("./commands", () => ({
  listShortcutOverrides: listShortcutOverridesMock,
  saveShortcutOverrides: vi.fn(async () => null),
}));

function pressed(id: string, init: KeyboardEventInit): boolean {
  return commandById(id).matches?.(new KeyboardEvent("keydown", init)) ?? false;
}

describe("hydrateCommandOverrides", () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true);
    listShortcutOverridesMock.mockReset();
  });

  afterEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
    setCommandOverrides({});
  });

  it("applies the saved chords once they are read", async () => {
    listShortcutOverridesMock.mockResolvedValue({ paste: { key: "b", meta: true } });

    await hydrateCommandOverrides();

    expect(pressed("paste", { key: "b", code: "KeyB", metaKey: true })).toBe(true);
    expect(pressed("paste", { key: "v", code: "KeyV", metaKey: true })).toBe(false);
  });

  it("keeps a rebind that arrived while the saved chords were being read", async () => {
    let answer: (overrides: Record<string, CommandBinding>) => void = () => undefined;
    listShortcutOverridesMock.mockImplementation(
      () => new Promise((resolve) => { answer = resolve; }),
    );

    const hydrating = hydrateCommandOverrides();
    // Settings rebinds Paste; its `shortcuts-changed` lands first.
    const rebound = { paste: { key: "j", meta: true } };
    setCommandOverrides(rebound);
    answer({ paste: { key: "b", meta: true } });
    await hydrating;

    expect(getCommandOverrides()).toBe(rebound);
    expect(pressed("paste", { key: "j", code: "KeyJ", metaKey: true })).toBe(true);
    expect(pressed("paste", { key: "b", code: "KeyB", metaKey: true })).toBe(false);
  });
});
