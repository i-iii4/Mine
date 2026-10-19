import { followNoteRename, holdNoteForEditing, isNoteHeldForEditing, noteMissingFromIndex } from "./noteEditSessions";

describe("the editor's holds of notes (SPEC_EDITING.md, Л4.8, Л4.9)", () => {
  it("follows a rename, tells the session the new name and answers for it", () => {
    const renamed = vi.fn();
    const hold = holdNoteForEditing("Cards/Old", { renamed, missing: vi.fn() });
    expect(isNoteHeldForEditing("Cards/Old")).toBe(true);
    followNoteRename("Cards/Old", "Cards/New");
    expect(renamed).toHaveBeenCalledWith("Cards/New");
    expect(hold.slug).toBe("Cards/New");
    expect(isNoteHeldForEditing("Cards/Old")).toBe(false);
    expect(isNoteHeldForEditing("Cards/New")).toBe(true);
    hold.release();
    expect(isNoteHeldForEditing("Cards/New")).toBe(false);
  });

  it("tells only the sessions of a note that left the index, and forgets released ones", () => {
    const missing = vi.fn();
    const other = vi.fn();
    const hold = holdNoteForEditing("Cards/Gone", { renamed: vi.fn(), missing });
    const kept = holdNoteForEditing("Cards/Kept", { renamed: vi.fn(), missing: other });
    noteMissingFromIndex("Cards/Gone");
    expect(missing).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    hold.release();
    hold.release();
    noteMissingFromIndex("Cards/Gone");
    expect(missing).toHaveBeenCalledTimes(1);
    kept.release();
  });

  it("ignores a rename of a note nobody holds and a rename to itself", () => {
    const renamed = vi.fn();
    const hold = holdNoteForEditing("Cards/A", { renamed, missing: vi.fn() });
    followNoteRename("Cards/B", "Cards/C");
    followNoteRename("Cards/A", "Cards/A");
    expect(renamed).not.toHaveBeenCalled();
    hold.release();
  });
});
