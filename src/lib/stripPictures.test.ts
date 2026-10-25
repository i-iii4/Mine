import { afterEach, describe, expect, it, vi } from "vitest";
import { holdStripPicture, releaseStripPicturesExcept } from "./stripPictures";

describe("the strips' held pictures", () => {
  afterEach(() => {
    releaseStripPicturesExcept(new Set());
    vi.restoreAllMocks();
  });

  /** Pictures the module made since the spy, by address. */
  function madePictures() {
    const made: string[] = [];
    const original = window.Image;
    vi.spyOn(window, "Image").mockImplementation(function picture() {
      const image = new original();
      queueMicrotask(() => made.push(image.getAttribute("src") ?? image.src));
      return image;
    });
    return made;
  }

  it("holds one picture per address", async () => {
    const made = madePictures();
    holdStripPicture("/t/a.micro.jpg?m=1");
    holdStripPicture("/t/a.micro.jpg?m=1");
    holdStripPicture("/t/b.micro.jpg?m=1");
    await Promise.resolve();
    expect(made).toHaveLength(2);
  });

  it("lets go of the pictures of cards no read lists, keeping a retried address of a listed one", async () => {
    holdStripPicture("/t/a.micro.jpg?m=1");
    holdStripPicture("/t/b.micro.jpg?m=1&retry=2");
    holdStripPicture("/t/c.micro.jpg?m=1");
    releaseStripPicturesExcept(new Set(["/t/a.micro.jpg?m=1", "/t/b.micro.jpg?m=1"]));

    const made = madePictures();
    holdStripPicture("/t/a.micro.jpg?m=1");
    holdStripPicture("/t/b.micro.jpg?m=1&retry=2");
    holdStripPicture("/t/c.micro.jpg?m=1");
    await Promise.resolve();
    // Only the released one is made again.
    expect(made).toHaveLength(1);
  });
});
