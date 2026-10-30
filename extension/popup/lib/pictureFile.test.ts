import { describe, expect, it } from "vitest";
import { pictureFileSource } from "./pictureFile";

const PICTURE = "https://upload.example.org/a/Harvest.jpg";

describe("pictureFileSource", () => {
  // Б1: the bytes the browser had go as an upload, like a screenshot.
  it("hands over the browser's upload", async () => {
    expect(await pictureFileSource(PICTURE, async () => "8f7e0a91d9b44d0cb1e6f52bb612ab8d"))
      .toEqual({ pre_uploaded_id: "8f7e0a91d9b44d0cb1e6f52bb612ab8d" });
  });

  // Б1: whatever the browser cannot give, the helper downloads as before.
  it("leaves the file to the helper when the browser has none", async () => {
    expect(await pictureFileSource(PICTURE, async () => null)).toEqual({ image_url: PICTURE });
    expect(await pictureFileSource(PICTURE, async () => { throw new Error("worker gone"); }))
      .toEqual({ image_url: PICTURE });
    expect(await pictureFileSource(PICTURE, null)).toEqual({ image_url: PICTURE });
  });
});
