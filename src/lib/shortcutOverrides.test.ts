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
    listShortcutOverridesMock.mockResolvedValue({ "switch-space": { key: "b", meta: true } });

    await hydrateCommandOverrides();

    expect(pressed("switch-space", { key: "b", code: "KeyB", metaKey: true })).toBe(true);
    expect(pressed("switch-space", { key: "o", code: "KeyO", metaKey: true, shiftKey: true })).toBe(false);
  });

  it("keeps a rebind that arrived while the saved chords were being read", async () => {
    let answer: (overrides: Record<string, CommandBinding>) => void = () => undefined;
    listShortcutOverridesMock.mockImplementation(
      () => new Promise((resolve) => { answer = resolve; }),
    );

    const hydrating = hydrateCommandOverrides();
    // Settings rebinds Switch space; its `shortcuts-changed` lands first.
    const rebound = { "switch-space": { key: "j", meta: true } };
    setCommandOverrides(rebound);
    answer({ "switch-space": { key: "b", meta: true } });
    await hydrating;

    expect(getCommandOverrides()).toBe(rebound);
    expect(pressed("switch-space", { key: "j", code: "KeyJ", metaKey: true })).toBe(true);
    expect(pressed("switch-space", { key: "b", code: "KeyB", metaKey: true })).toBe(false);
  });
});
