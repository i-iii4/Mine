import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  DeleteSelectedCardsDialog,
  NOTHING_LEFT_TO_DELETE,
  type DeleteSelectionPending,
} from "./DeleteSelectedCardsDialog";
import type { DeleteBlockMedia, DeleteBlocksPlan } from "@/types";

const PHOTO: DeleteBlockMedia = { path: "Media/photo.jpg", file_name: "photo.jpg", kind: "image", referenced_by: ["one", "two"] };
const CLIP: DeleteBlockMedia = { path: "Media/clip.mp4", file_name: "clip.mp4", kind: "video", referenced_by: ["two"] };
const COVER: DeleteBlockMedia = { path: "Media/cover.jpg", file_name: "cover.jpg", kind: "image", referenced_by: ["Reader"] };

function planWith(
  slugs: string[],
  unused: DeleteBlockMedia[] = [],
  shared: DeleteBlockMedia[] = [],
): DeleteBlocksPlan {
  return {
    slugs,
    markdown_files: slugs.map((slug) => `${slug}.md`),
    unused_media: unused,
    shared_media: shared,
  };
}

function renderWindow(
  plan: DeleteBlocksPlan | null,
  {
    error = null,
    pending = null,
    deleteError = null,
    onOpenChange = () => {},
  }: {
    error?: string | null;
    pending?: DeleteSelectionPending | null;
    deleteError?: string | null;
    onOpenChange?: (open: boolean) => void;
  } = {},
) {
  render(
    <DeleteSelectedCardsDialog
      open
      vaultPath="/vault"
      plan={plan}
      error={error}
      pending={pending}
      deleteError={deleteError}
      onOpenChange={onOpenChange}
      onKeepMedia={() => {}}
      onDelete={() => {}}
    />,
  );
  return screen.getByRole("alertdialog");
}

function descriptionOf(dialog: HTMLElement): string | null {
  return dialog.querySelector("[data-slot='alert-dialog-description']")?.textContent ?? null;
}

// DESIGN_SYSTEM.md, «Окна», «Тексты окон» (decision of 11.10.2026): the same
// three forms as `Delete element?`, counted.
describe("Delete selected elements? description", () => {
  it("says the elements go to the Trash when none has media", () => {
    expect(descriptionOf(renderWindow(planWith(["one", "two", "three"])))).toBe(
      "3 elements go to the Trash.",
    );
  });

  it("adds the media other elements use, which stay", () => {
    expect(descriptionOf(renderWindow(planWith(["one", "two"], [], [COVER])))).toBe(
      "2 elements go to the Trash. 1 media file is used by other elements and will stay in the space.",
    );
  });

  it("names the media only these elements use, which go with them", () => {
    expect(descriptionOf(renderWindow(planWith(["one", "two"], [PHOTO, CLIP])))).toBe(
      "2 elements and the media files you delete with them go to the Trash. 2 media files are only used by these elements.",
    );
  });

  it("names both, their own media first", () => {
    expect(descriptionOf(renderWindow(planWith(["one", "two"], [PHOTO], [COVER])))).toBe(
      "2 elements and the media files you delete with them go to the Trash. 1 media file is only used by these elements. 1 media file is used by other elements and will stay in the space.",
    );
  });

  it("speaks of one element when only one of the selection is left", () => {
    expect(descriptionOf(renderWindow(planWith(["one"], [PHOTO])))).toBe(
      "1 element and the media files you delete with it go to the Trash. 1 media file is only used by this element.",
    );
  });

  it("offers nothing when every selected element is already gone", () => {
    const dialog = renderWindow(planWith([]));
    expect(descriptionOf(dialog)).toBe(NOTHING_LEFT_TO_DELETE);
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("shows why the plan could not be read, Delete unavailable", () => {
    const dialog = renderWindow(null, { error: "index is busy" });
    expect(descriptionOf(dialog)).toBe("Could not prepare delete plan: index is busy");
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});

describe("Delete selected elements? window", () => {
  it("stays closed until the plan or its error is here", () => {
    render(
      <DeleteSelectedCardsDialog
        open
        vaultPath="/vault"
        plan={null}
        error={null}
        pending={null}
        deleteError={null}
        onOpenChange={() => {}}
        onKeepMedia={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("is a question without media to delete, Cancel and Delete only", () => {
    const dialog = renderWindow(planWith(["one", "two"], [], [COVER]));
    expect(dialog).toHaveAttribute("data-modal-width", "question");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Delete",
    ]);
  });

  it("shows the media to delete at content width, never the shared ones", () => {
    const dialog = renderWindow(planWith(["one", "two"], [PHOTO, CLIP], [COVER]));
    expect(dialog).toHaveAttribute("data-modal-width", "content");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Keep media",
      "Delete",
    ]);
    const previews = dialog.querySelector("[data-delete-media-previews]") as HTMLElement;
    expect(within(previews).getByText("photo.jpg")).toBeInTheDocument();
    expect(within(previews).getByText("clip.mp4")).toBeInTheDocument();
    expect(within(previews).queryByText("cover.jpg")).toBeNull();
    // A video's poster is the first selected element that uses it.
    expect(previews.querySelector("video")?.getAttribute("poster")).toContain("two");
  });

  it("says Deleting… on the pressed button and holds every other", () => {
    const dialog = renderWindow(planWith(["one", "two"], [PHOTO]), { pending: "keep-media" });
    expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("does not close on Escape while the batch runs", () => {
    const onOpenChange = vi.fn();
    const dialog = renderWindow(planWith(["one", "two"]), { pending: "delete", onOpenChange });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows a failed batch above the buttons", () => {
    const dialog = renderWindow(planWith(["one", "two"]), { deleteError: "Permission denied" });
    expect(dialog.querySelector("[data-delete-selected-error]")).toHaveTextContent("Permission denied");
  });
});
