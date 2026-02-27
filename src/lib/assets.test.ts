import { describe, it, expect } from "vitest";
import { thumbnailUrl, mediaUrl, domainFromUrl } from "./assets";

describe("thumbnailUrl", () => {
  it("builds correct path", () => {
    const url = thumbnailUrl("/vault", "my-block");
    expect(url).toBe("asset://localhost//vault/.arena/cache/thumbs/my-block.jpg");
  });
});

describe("mediaUrl", () => {
  it("builds correct path", () => {
    const url = mediaUrl("/vault", "photo.png");
    expect(url).toBe("asset://localhost//vault/photo.png");
  });
});

describe("domainFromUrl", () => {
  it("extracts domain without www", () => {
    expect(domainFromUrl("https://www.example.com/page")).toBe("example.com");
  });

  it("keeps domain without www", () => {
    expect(domainFromUrl("https://api.example.com")).toBe("api.example.com");
  });

  it("returns original on invalid URL", () => {
    expect(domainFromUrl("not-a-url")).toBe("not-a-url");
  });

  it("handles http scheme", () => {
    expect(domainFromUrl("http://test.org/path")).toBe("test.org");
  });
});
