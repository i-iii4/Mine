import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReconcileFileError } from "@/types";
import { INDEX_ERRORS_SHOWN, IndexErrorsNotice, VAULT_FRESHNESS_CHANGED_EVENT } from "./IndexErrorsNotice";

function pass(state: "fresh" | "degraded" | "failed", errorFiles: ReconcileFileError[]) {
  act(() => {
    window.dispatchEvent(new CustomEvent(VAULT_FRESHNESS_CHANGED_EVENT, {
      detail: {
        payload: {
          vault_path: "/vault",
          generation: 1,
          state,
          joined_callers: 0,
          inventory_markdown: 0,
          content_reads: 0,
          database_writes: 0,
          error_count: errorFiles.length,
          error_files: errorFiles,
          elapsed_ms: 0,
          fast_path_hits: 0,
        },
      },
    }));
  });
}

function broken(count: number): ReconcileFileError[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `Cards/Note ${index + 1}.md`,
    kind: "read",
    message: "iCloud did not bring the file",
  }));
}

/// SPEC_DEEP_AUDIT.md, Е6.17.
describe("IndexErrorsNotice", () => {
  it("names the first notes and counts the rest", async () => {
    render(<IndexErrorsNotice />);
    await act(async () => {
      await Promise.resolve();
    });

    pass("degraded", broken(INDEX_ERRORS_SHOWN + 2));

    expect(screen.getByText(`Could not read ${INDEX_ERRORS_SHOWN + 2} notes`)).toBeInTheDocument();
    expect(screen.getByText("“Note 1.md”: iCloud did not bring the file")).toBeInTheDocument();
    expect(screen.queryByText(`“Note ${INDEX_ERRORS_SHOWN + 1}.md”: iCloud did not bring the file`)).toBeNull();
    expect(screen.getByText("And 2 more.")).toBeInTheDocument();
  });

  it("stays closed for the same notes and comes back for others; a failed pass changes nothing", async () => {
    render(<IndexErrorsNotice />);
    await act(async () => {
      await Promise.resolve();
    });

    pass("degraded", broken(1));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Could not read 1 note")).toBeNull();

    pass("degraded", broken(1));
    expect(screen.queryByText("Could not read 1 note")).toBeNull();

    pass("degraded", broken(2));
    expect(screen.getByText("Could not read 2 notes")).toBeInTheDocument();

    pass("failed", []);
    expect(screen.getByText("Could not read 2 notes")).toBeInTheDocument();
  });
});
