import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeleteBlockDialog } from "./DeleteBlockDialog";

const PLAN_NO_MEDIA = {
  slug: "note",
  unused_media: [],
  shared_media: [],
};

describe("DeleteBlockDialog description", () => {
  it("says nothing when the card has no media", () => {
    render(
      <DeleteBlockDialog
        open
        plan={PLAN_NO_MEDIA as never}
        vaultPath="/vault"
        error={null}
        onOpenChange={() => {}}
        onKeepMedia={() => {}}
        onDeleteMedia={() => {}}
      />,
    );
    // The old copy explained that only the element would be deleted, which
    // answers a question nobody asked.
    expect(screen.queryByText(/only the element/i)).not.toBeInTheDocument();
  });

  it("still explains what happens to media the card owns", () => {
    render(
      <DeleteBlockDialog
        open
        plan={{ slug: "note", unused_media: [{ file_name: "a.jpg", kind: "image" }], shared_media: [] } as never}
        vaultPath="/vault"
        error={null}
        onOpenChange={() => {}}
        onKeepMedia={() => {}}
        onDeleteMedia={() => {}}
      />,
    );
    expect(screen.getByText(/1 media file/i)).toBeInTheDocument();
  });

  it("still explains media shared with other cards", () => {
    render(
      <DeleteBlockDialog
        open
        plan={{ slug: "note", unused_media: [], shared_media: [{ file_name: "b.jpg", kind: "image" }] } as never}
        vaultPath="/vault"
        error={null}
        onOpenChange={() => {}}
        onKeepMedia={() => {}}
        onDeleteMedia={() => {}}
      />,
    );
    expect(screen.getByText(/used by other cards/i)).toBeInTheDocument();
  });
});
