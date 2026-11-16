import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installPictureDecode } from "@/test/pictureDecode";
import { FeedVideoPoster } from "./FeedVideoPoster";

/// SPEC_FEED_SCROLL_PERFORMANCE.md, «Подготовка картинки карточки».
describe("FeedVideoPoster", () => {
  const poster = (container: HTMLElement) =>
    container.querySelector<HTMLImageElement>("[data-feed-video-poster]");

  it("asks the engine to decode the poster as it mounts, and each candidate after it", () => {
    const { decode, restore } = installPictureDecode();
    try {
      const { container } = render(
        <FeedVideoPoster candidateUrls={["/thumbs/a.jpg", "/thumbs/b.jpg"]} loading="eager" />,
      );
      expect(decode.mock.contexts).toEqual([poster(container)]);

      fireEvent.error(poster(container)!);

      expect(poster(container)).toHaveAttribute("src", "/thumbs/b.jpg");
      expect(decode).toHaveBeenCalledTimes(2);
    } finally { restore(); }
  });

  it("falls through the candidates to the fallback when none loads", () => {
    const { container } = render(
      <FeedVideoPoster
        candidateUrls={["/thumbs/a.jpg", "/thumbs/a.jpg", "", "/thumbs/b.jpg"]}
        loading="eager"
        fallback={<div data-fallback="" />}
      />,
    );

    fireEvent.error(poster(container)!);
    expect(poster(container)).toHaveAttribute("src", "/thumbs/b.jpg");
    fireEvent.error(poster(container)!);

    expect(poster(container)).toBeNull();
    expect(container.querySelector("[data-fallback]")).not.toBeNull();
  });

  it("takes a poster that loaded and cannot be decoded as one that did not load", async () => {
    const { decode, restore } = installPictureDecode(
      () => Promise.reject(new DOMException("The source image cannot be decoded.", "EncodingError")),
    );
    const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    const naturalWidth = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
    try {
      const { container } = render(
        <FeedVideoPoster
          candidateUrls={["/thumbs/a.jpg", "/thumbs/b.jpg"]}
          loading="eager"
          fallback={<div data-fallback="" />}
        />,
      );

      await waitFor(() => expect(container.querySelector("[data-fallback]")).not.toBeNull());
      expect(decode).toHaveBeenCalledTimes(2);
    } finally {
      restore();
      complete.mockRestore();
      naturalWidth.mockRestore();
    }
  });
});
