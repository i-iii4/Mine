// The iCloud conflicts notice and window (SPEC_ICLOUD_CONFLICTS.md, ВК10 по
// ВК13): the notice comes back only for a new path, the window shows a row
// and a Keep per version with the main button on the version in the folder,
// one way to close, and each error under its own group.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultConflict, VaultConflictError } from "@/types";
import { listVaultConflictPaths, listVaultConflicts, resolveVaultConflict } from "@/lib/commands";
import {
  conflictErrorText,
  conflictNoticeText,
  noticeVisible,
  VAULT_CONFLICTS_CHANGED_EVENT,
  VAULT_CONFLICTS_DESCRIPTION,
  VaultConflictsNotice,
  versionLabel,
} from "./VaultConflictsNotice";

const listeners = vi.hoisted(() => new Map<string, Array<(event: { payload: unknown }) => void>>());

vi.mock("@/lib/pageEvents", () => ({
  listenPage: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    return () => {
      listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== handler));
    };
  }),
}));

vi.mock("@/lib/commands", () => ({
  listVaultConflictPaths: vi.fn(),
  listVaultConflicts: vi.fn(),
  resolveVaultConflict: vi.fn(),
}));

const pathsMock = vi.mocked(listVaultConflictPaths);
const listMock = vi.mocked(listVaultConflicts);
const resolveMock = vi.mocked(resolveVaultConflict);

/** The event as the backend sends it: the count and no failed check. */
function send(event: string) {
  act(() => {
    for (const handler of listeners.get(event) ?? []) handler({ payload: { count: 1, check_error: null } });
  });
}

const NOTE: VaultConflict = {
  path: "Cards/Note.md",
  name: "Note",
  detected_at: "2026-10-11T09:00:00Z",
  current: { token: null, modified: "2026-10-11T08:00:00Z", device: null },
  versions: [
    { token: "tok-a", modified: "2026-10-10T12:54:00Z", device: "Anna’s MacBook Pro" },
    { token: "tok-b", modified: "2026-10-09T07:05:00Z", device: null },
  ],
  unanswered: false,
};

const OTHER: VaultConflict = {
  path: "Journal/Day.md",
  name: "Day",
  detected_at: "2026-10-10T09:00:00Z",
  current: { token: null, modified: "2026-10-10T08:00:00Z", device: null },
  versions: [{ token: "tok-c", modified: "2026-10-09T10:00:00Z", device: "iPhone" }],
  unanswered: false,
};

/** A recorded conflict iCloud did not answer about this time (Е5.12). */
const UNANSWERED: VaultConflict = {
  path: "Cards/Busy.md",
  name: "Busy",
  detected_at: "2026-10-08T09:00:00Z",
  current: { token: null, modified: null, device: null },
  versions: [],
  unanswered: true,
};

beforeEach(() => {
  listeners.clear();
  pathsMock.mockReset();
  listMock.mockReset();
  resolveMock.mockReset();
});

describe("the notice's words", () => {
  it("names the note of one conflict and counts several", () => {
    expect(conflictNoticeText(["Cards/Note.md"])).toEqual({
      title: "iCloud sync conflict",
      text: "“Note” has versions from more than one device.",
    });
    expect(conflictNoticeText(["Cards/Note.md", "Journal/Day.md"])).toEqual({
      title: "2 iCloud sync conflicts",
      text: "2 notes have versions from more than one device.",
    });
  });

  it("comes back after closing only for a path that was not there", () => {
    const closed = new Set(["A.md", "B.md"]);
    expect(noticeVisible([], null)).toBe(false);
    expect(noticeVisible(["A.md"], null)).toBe(true);
    expect(noticeVisible(["A.md", "B.md"], closed)).toBe(false);
    expect(noticeVisible(["A.md"], closed)).toBe(false);
    expect(noticeVisible(["A.md", "C.md"], closed)).toBe(true);
  });
});

describe("the version rows", () => {
  it("label the version in the folder and the hidden ones (ВК11, 11.10.2026)", () => {
    const time = (iso: string) => {
      const date = new Date(iso);
      return `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })}, ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
    };
    expect(versionLabel(NOTE.current, true)).toBe(`In the folder · ${time("2026-10-11T08:00:00Z")}`);
    expect(versionLabel(NOTE.versions[0]!, false)).toBe(
      `Hidden version · Anna’s MacBook Pro · ${time("2026-10-10T12:54:00Z")}`,
    );
    expect(versionLabel(NOTE.versions[1]!, false)).toBe(
      `Hidden version · Unknown device · ${time("2026-10-09T07:05:00Z")}`,
    );
    expect(versionLabel({ token: "t", modified: null, device: null }, false)).toBe("Hidden version · Unknown device");
  });

  it("say each refusal in the window's words (ВК12)", () => {
    const words = (error: VaultConflictError) => conflictErrorText(error, "Note");
    expect(words({ kind: "no_vault" })).toBe("No space is open.");
    expect(words({ kind: "invalid_path", path: "../x.md" })).toBe("Mine cannot use the path “../x.md”.");
    expect(words({ kind: "not_pending", path: "Cards/Note.md" })).toBeNull();
    expect(words({ kind: "versions_changed", path: "Cards/Note.md" })).toBe(
      "The versions of “Note” changed. The list shows them again.",
    );
    expect(words({ kind: "source_changed", path: "Cards/Note.md" })).toBe(
      "“Note” changed outside Mine; nothing was changed. Try again.",
    );
    expect(words({ kind: "helper_failed", message: "timeout" })).toBe("iCloud did not answer: timeout");
    expect(words({ kind: "trash_failed", paths: ["Cards/Note (iPhone 2026-10-09 10-05).md"] })).toBe(
      "The other versions stayed next to the note as separate notes: the Trash refused them.",
    );
    expect(words({ kind: "internal", message: "disk full" })).toBe("disk full");
  });
});

describe("VaultConflictsNotice", () => {
  it("shows the count, closes, and returns only for a new path", async () => {
    pathsMock.mockResolvedValue(["Cards/Note.md", "Journal/Day.md"]);
    render(<VaultConflictsNotice vaultReady />);
    expect(await screen.findByText("2 iCloud sync conflicts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("2 iCloud sync conflicts")).toBeNull();

    // The same paths, or fewer: the notice stays closed.
    pathsMock.mockResolvedValue(["Cards/Note.md"]);
    send(VAULT_CONFLICTS_CHANGED_EVENT);
    await waitFor(() => expect(pathsMock).toHaveBeenCalledTimes(2));
    expect(document.querySelector("[data-vault-conflicts-notice]")).toBeNull();

    // A path that was not there when it was closed brings it back.
    pathsMock.mockResolvedValue(["Cards/Note.md", "Inbox/New.md"]);
    send(VAULT_CONFLICTS_CHANGED_EVENT);
    expect(await screen.findByText("2 iCloud sync conflicts")).toBeInTheDocument();
  });

  it("reads nothing before the space is ready", () => {
    pathsMock.mockResolvedValue(["Cards/Note.md"]);
    render(<VaultConflictsNotice vaultReady={false} />);
    expect(pathsMock).not.toHaveBeenCalled();
  });
});

async function openWindow(conflicts: VaultConflict[]) {
  pathsMock.mockResolvedValue(conflicts.map((conflict) => conflict.path));
  listMock.mockResolvedValue(conflicts);
  render(<VaultConflictsNotice vaultReady />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  return screen.findByRole("dialog");
}

function group(path: string) {
  const element = document.querySelector(`[data-conflict-group="${path}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no group for ${path}`);
  return element;
}

describe("the window", () => {
  it("shows a row and a Keep per version, the main one on the folder's, and one way to close", async () => {
    const dialog = await openWindow([NOTE]);
    expect(within(dialog).getByText("Resolve iCloud sync conflicts")).toBeInTheDocument();
    expect(within(dialog).getByText(VAULT_CONFLICTS_DESCRIPTION)).toBeInTheDocument();
    await waitFor(() => expect(group(NOTE.path)).toBeInTheDocument());

    const rows = group(NOTE.path).querySelectorAll("[data-conflict-version]");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/^In the folder · /);
    expect(rows[1]).toHaveTextContent(/^Hidden version · Anna’s MacBook Pro · /);
    expect(rows[2]).toHaveTextContent(/^Hidden version · Unknown device · /);
    const keeps = within(group(NOTE.path)).getAllByRole("button", { name: "Keep" });
    expect(keeps).toHaveLength(3);
    expect(keeps[0]).toHaveAttribute("data-variant", "default");
    expect(keeps[1]).toHaveAttribute("data-variant", "secondary");
    expect(within(group(NOTE.path)).getByRole("button", { name: "Keep all" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );

    // No Cancel, no Close at the bottom: the cross alone.
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: /^Close/ })).toHaveLength(1);
  });

  it("keeps a hidden version with the versions it showed, and closes after the last group", async () => {
    let finish: () => void = () => undefined;
    resolveMock.mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    await openWindow([NOTE]);
    await waitFor(() => expect(group(NOTE.path)).toBeInTheDocument());

    fireEvent.click(within(group(NOTE.path)).getAllByRole("button", { name: "Keep" })[1]!);

    expect(resolveMock).toHaveBeenCalledWith(
      "Cards/Note.md",
      { kind: "keep_version", token: "tok-a" },
      ["tok-a", "tok-b"],
    );
    expect(within(group(NOTE.path)).getByRole("button", { name: "Keeping…" })).toBeDisabled();
    expect(within(group(NOTE.path)).getByRole("button", { name: "Keep all" })).toBeDisabled();

    listMock.mockResolvedValue([]);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the version in the folder and keeps all", async () => {
    resolveMock.mockResolvedValue(undefined);
    await openWindow([NOTE, OTHER]);
    await waitFor(() => expect(group(OTHER.path)).toBeInTheDocument());

    listMock.mockResolvedValue([OTHER]);
    fireEvent.click(within(group(NOTE.path)).getAllByRole("button", { name: "Keep" })[0]!);
    await waitFor(() => expect(document.querySelector(`[data-conflict-group="${NOTE.path}"]`)).toBeNull());
    expect(resolveMock).toHaveBeenLastCalledWith(
      "Cards/Note.md",
      { kind: "keep_version", token: null },
      ["tok-a", "tok-b"],
    );

    listMock.mockResolvedValue([]);
    fireEvent.click(within(group(OTHER.path)).getByRole("button", { name: "Keep all" }));
    expect(resolveMock).toHaveBeenLastCalledWith("Journal/Day.md", { kind: "keep_all" }, ["tok-c"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // SPEC_DEEP_AUDIT.md, Е5.12: the notice counted a conflict the window left
  // out, and the window opened empty and closed at once.
  it("shows a conflict iCloud did not answer about, with words and nothing to keep", async () => {
    const dialog = await openWindow([UNANSWERED, NOTE]);
    await waitFor(() => expect(group(UNANSWERED.path)).toBeInTheDocument());

    expect(within(group(UNANSWERED.path)).getByText("Busy")).toBeInTheDocument();
    expect(
      within(group(UNANSWERED.path)).getByText(
        "iCloud did not answer about this note. Mine asks again when you come back to the window.",
      ),
    ).toBeInTheDocument();
    expect(within(group(UNANSWERED.path)).queryAllByRole("button")).toHaveLength(0);
    expect(within(dialog).getAllByRole("button", { name: "Keep all" })).toHaveLength(1);
  });

  it("stays open with only a conflict iCloud did not answer about", async () => {
    const dialog = await openWindow([UNANSWERED]);
    await waitFor(() => expect(group(UNANSWERED.path)).toBeInTheDocument());
    expect(dialog).toBeInTheDocument();
  });

  it("asks iCloud for the versions once as it opens, not on every count", async () => {
    await openWindow([NOTE]);
    await waitFor(() => expect(group(NOTE.path)).toBeInTheDocument());
    pathsMock.mockResolvedValue([NOTE.path, OTHER.path]);
    send(VAULT_CONFLICTS_CHANGED_EVENT);
    await waitFor(() => expect(pathsMock).toHaveBeenCalledTimes(2));
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("shows an error under its own group and leaves the others alone", async () => {
    resolveMock.mockRejectedValue({ kind: "source_changed", path: "Journal/Day.md" });
    await openWindow([NOTE, OTHER]);
    await waitFor(() => expect(group(OTHER.path)).toBeInTheDocument());

    fireEvent.click(within(group(OTHER.path)).getByRole("button", { name: "Keep all" }));

    expect(
      await within(group(OTHER.path)).findByText("“Day” changed outside Mine; nothing was changed. Try again."),
    ).toBeInTheDocument();
    expect(group(NOTE.path).querySelector("[data-conflict-error]")).toBeNull();
    expect(within(group(OTHER.path)).getByRole("button", { name: "Keep all" })).toBeEnabled();
  });

  it("keeps a group the Trash refused with its words until the window is closed", async () => {
    resolveMock.mockRejectedValue({ kind: "trash_failed", paths: ["Cards/Note (iPhone 2026-10-09 10-05).md"] });
    await openWindow([NOTE]);
    await waitFor(() => expect(group(NOTE.path)).toBeInTheDocument());

    listMock.mockResolvedValue([]);
    fireEvent.click(within(group(NOTE.path)).getAllByRole("button", { name: "Keep" })[0]!);

    await waitFor(() => expect(group(NOTE.path)).toHaveTextContent(
      "The other versions stayed next to the note as separate notes: the Trash refused them.",
    ));
    expect(document.querySelectorAll(`[data-conflict-group="${NOTE.path}"]`)).toHaveLength(1);
    expect(within(group(NOTE.path)).queryByRole("button")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

/// SPEC_DEEP_AUDIT.md, Е6.17 (Е5.11): a check of the space for conflicts that
/// failed is the notice's news too; before, the reason reached the page and
/// was dropped.
describe("a failed check of the space for conflicts", () => {
  beforeEach(() => {
    listeners.clear();
    pathsMock.mockReset().mockResolvedValue([]);
  });

  function sendChanged(payload: { count: number; check_error: string | null }) {
    act(() => {
      for (const handler of listeners.get(VAULT_CONFLICTS_CHANGED_EVENT) ?? []) {
        handler({ payload });
      }
    });
  }

  it("says the check failed and why, and goes away after a check that did not", async () => {
    render(<VaultConflictsNotice vaultReady />);
    await waitFor(() => expect(listeners.get(VAULT_CONFLICTS_CHANGED_EVENT)?.length).toBe(1));

    sendChanged({ count: 0, check_error: "the iCloud helper did not answer" });

    expect(await screen.findByText("Could not check for iCloud sync conflicts")).toBeInTheDocument();
    expect(screen.getByText("the iCloud helper did not answer")).toBeInTheDocument();

    sendChanged({ count: 0, check_error: null });
    await waitFor(() => expect(screen.queryByText("Could not check for iCloud sync conflicts")).toBeNull());
  });
});

