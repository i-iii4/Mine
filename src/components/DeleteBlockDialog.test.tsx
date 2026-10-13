import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeleteBlockDialog } from "./DeleteBlockDialog";
import { DeleteKeptMediaNotice, DeleteMediaPreviewGrid, keptOfferedMedia } from "./DeleteWindowParts";
import type { DeleteBlockMedia, DeleteBlockPlan } from "@/types";

const PHOTO: DeleteBlockMedia = { path: "Media/photo.jpg", file_name: "photo.jpg", kind: "image", referenced_by: [] };
const PAPER: DeleteBlockMedia = { path: "Media/paper.pdf", file_name: "paper.pdf", kind: "document", referenced_by: [] };
const COVER: DeleteBlockMedia = { path: "Media/cover.jpg", file_name: "cover.jpg", kind: "image", referenced_by: ["Other"] };

function planWith(unused: DeleteBlockMedia[], shared: DeleteBlockMedia[]): DeleteBlockPlan {
  return { slug: "note", markdown_file: "note.md", unused_media: unused, shared_media: shared };
}

function description(plan: DeleteBlockPlan): string | null {
  render(
    <DeleteBlockDialog
      open
      plan={plan}
      vaultPath="/vault"
      error={null}
      onOpenChange={() => {}}
      onKeepMedia={() => {}}
      onDeleteMedia={() => {}}
    />,
  );
  return screen.getByRole("alertdialog").querySelector("[data-slot='alert-dialog-description']")?.textContent
    ?? null;
}

// DESIGN_SYSTEM.md, «Окна», «Тексты окон» (decision of 11.10.2026): the
// description names the fate of every thing touched, the Trash first, and
// does not retell the buttons.
describe("Delete element? description", () => {
  it("says the element goes to the Trash when it has no media", () => {
    expect(description(planWith([], []))).toBe("The element goes to the Trash.");
  });

  it("adds the media other elements use, which stay", () => {
    expect(description(planWith([], [COVER]))).toBe(
      "The element goes to the Trash. 1 media file is used by other elements and will stay in the space.",
    );
  });

  it("names the media only this element uses, which go with it", () => {
    expect(description(planWith([PHOTO], []))).toBe(
      "The element and the media files you delete with it go to the Trash. 1 media file is only used by this element.",
    );
  });

  it("names both, its own media first", () => {
    expect(description(planWith([PHOTO, PAPER], [COVER, { ...COVER, path: "Media/b.jpg" }]))).toBe(
      "The element and the media files you delete with it go to the Trash. 2 media files are only used by this element. 2 media files are used by other elements and will stay in the space.",
    );
  });
});

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

// SPEC_DEEP_AUDIT.md, Е6.8: a media file that will not load leaves its tile's
// fill, never the broken-image icon.
describe("DeleteMediaPreviewGrid", () => {
  it("hides a picture whose file will not load and keeps the tile", () => {
    const { container } = render(
      <DeleteMediaPreviewGrid media={[PHOTO]} vaultPath="/vault" posterSlug={() => null} />,
    );
    const picture = container.querySelector("img") as HTMLImageElement;
    fireEvent.error(picture);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
  });
});
