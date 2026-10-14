import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MissingAwareImage } from "./MissingAwareImage";

/// SPEC_THUMBNAILS.md, «Нет файла миниатюры»; SPEC_DEEP_AUDIT.md, Е6.8: a
/// picture whose file is not there is hidden, so the slot keeps its fill and
/// never shows WebKit's broken-image icon; once the card's preview is ready
/// the file is asked again.
describe("MissingAwareImage", () => {
  it("hides the picture whose file failed to load and tells the caller", () => {
    const onError = vi.fn();
    render(<MissingAwareImage src="asset://localhost/Media/photo.jpg" alt="Photo" onError={onError} />);
    fireEvent.error(screen.getByRole("img", { name: "Photo" }));
    expect(screen.queryByRole("img", { name: "Photo" })).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("asks the file again when the card's preview is ready", async () => {
    render(<MissingAwareImage src="asset://localhost/thumbs/note.webp" alt="Preview" slug="note" />);
    fireEvent.error(screen.getByRole("img", { name: "Preview" }));
    expect(screen.queryByRole("img", { name: "Preview" })).toBeNull();
    // Let the subscription to `thumb:updated` settle before the event.
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new CustomEvent("thumb:updated", { detail: { payload: { slug: "note" } } }));
    });
    expect(await screen.findByRole("img", { name: "Preview" })).toHaveAttribute("src", "asset://localhost/thumbs/note.webp?retry=1");
  });
});
