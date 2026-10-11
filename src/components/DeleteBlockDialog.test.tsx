import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeleteBlockDialog, DeleteKeptMediaNotice, keptOfferedMedia } from "./DeleteBlockDialog";
import type { DeleteBlockMedia, DeleteBlockPlan } from "@/types";

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
    expect(screen.getByText(/used by other elements/i)).toBeInTheDocument();
  });
});

const PHOTO: DeleteBlockMedia = { path: "Media/photo.jpg", file_name: "photo.jpg", kind: "image", referenced_by: [] };
const PAPER: DeleteBlockMedia = { path: "Media/paper.pdf", file_name: "paper.pdf", kind: "document", referenced_by: [] };

// User's decision of 11.10.2026: the window waits for its plan, read from the
// index at once, and opens already at its width.
describe("DeleteBlockDialog opening", () => {
  function dialog(plan: DeleteBlockPlan | null, error: string | null = null) {
    return (
      <DeleteBlockDialog
        open
        plan={plan}
        vaultPath="/vault"
        error={error}
        onOpenChange={() => {}}
        onKeepMedia={() => {}}
        onDeleteMedia={() => {}}
      />
    );
  }

  it("stays closed until the plan is here, then opens at the width of its media", () => {
    const { rerender } = render(dialog(null));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    rerender(dialog({ slug: "note", markdown_file: "note.md", unused_media: [PHOTO], shared_media: [] }));
    expect(screen.getByRole("alertdialog")).toHaveAttribute("data-modal-width", "content");
  });

  it("opens as a question when no media go with the element", () => {
    render(dialog({ slug: "note", markdown_file: "note.md", unused_media: [], shared_media: [PHOTO] }));
    expect(screen.getByRole("alertdialog")).toHaveAttribute("data-modal-width", "question");
  });

  it("opens with the error when the plan could not be read", () => {
    render(dialog(null, "index is busy"));
    expect(screen.getByRole("alertdialog")).toHaveAttribute("data-modal-width", "question");
    expect(screen.getByText(/index is busy/)).toBeInTheDocument();
  });
});

describe("files Delete kept", () => {
  it("are news only when the window offered them", () => {
    const kept = [{ ...PHOTO, referenced_by: ["Cards/Late"] }, { ...PAPER, referenced_by: ["Cards/Reader"] }];
    expect(keptOfferedMedia([PHOTO], kept)).toEqual([kept[0]]);
    expect(keptOfferedMedia([], kept)).toEqual([]);
  });

  it("name the one file, or count several", () => {
    const { rerender } = render(<DeleteKeptMediaNotice media={[PHOTO]} onClose={() => {}} />);
    expect(screen.getByText("photo.jpg is used by another element and stayed in the space.")).toBeInTheDocument();

    rerender(<DeleteKeptMediaNotice media={[PHOTO, PAPER]} onClose={() => {}} />);
    expect(screen.getByText("2 media files are used by other elements and stayed in the space.")).toBeInTheDocument();
  });
});
