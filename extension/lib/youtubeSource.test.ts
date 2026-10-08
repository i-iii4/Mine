// The channel of a YouTube clip (SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube»).
import { describe, expect, it } from "vitest";
import "./youtubeSource.js";

const api = globalThis.MineYoutubeSource;

describe("youtubeChannelFromOEmbed", () => {
  it.each([
    "https://www.youtube.com/@kotecinho",
    "https://youtube.com/@kotecinho",
    "https://m.youtube.com/@kotecinho/",
  ])("takes @handle from the channel address %s", (authorUrl) => {
    expect(api.youtubeChannelFromOEmbed({ author_name: "Kotecinho Channel", author_url: authorUrl })).toBe("@kotecinho");
  });

  it("decodes a handle written in another alphabet", () => {
    expect(api.youtubeChannelFromOEmbed({ author_name: "Кот", author_url: "https://www.youtube.com/@%D0%BA%D0%BE%D1%82" })).toBe("@кот");
  });

  it.each([
    "https://www.youtube.com/channel/UC1234567890",
    "https://www.youtube.com/user/oldname",
    "https://www.youtube.com/@kotecinho/videos",
    "https://www.youtube.com/@",
    "https://www.youtube.com/@bad%ZZ",
    "https://evil.example/@kotecinho",
    "https://www.youtube.com.evil.example/@kotecinho",
    "http://www.youtube.com/@kotecinho",
    "not a url",
    42,
    null,
  ])("takes the channel name when author_url %s is not a channel handle address", (authorUrl) => {
    expect(api.youtubeChannelFromOEmbed({ author_name: "  Kotecinho Channel  ", author_url: authorUrl })).toBe("Kotecinho Channel");
  });

  it.each([
    ["no payload", null],
    ["a string", "{\"author_name\":\"Kotecinho\"}"],
    ["a number", 7],
    ["an empty object", {}],
    ["an empty name and no handle", { author_name: "   ", author_url: "https://www.youtube.com/channel/UC1" }],
    ["a name of the wrong type", { author_name: 12 }],
  ])("gives null for %s", (_label, payload) => {
    expect(api.youtubeChannelFromOEmbed(payload)).toBeNull();
  });
});

describe("youtubeOEmbedUrl", () => {
  it("asks oEmbed for the canonical video of any YouTube address", () => {
    const expected = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=9KDDhAOyv9k")}`;
    expect(api.youtubeOEmbedUrl("https://youtu.be/9KDDhAOyv9k?si=tracking")).toBe(expected);
    expect(api.youtubeOEmbedUrl("https://m.youtube.com/watch?v=9KDDhAOyv9k&t=17")).toBe(expected);
    expect(api.youtubeOEmbedUrl("https://www.youtube.com/shorts/9KDDhAOyv9k")).toBe(expected);
  });

  it.each(["https://example.com/watch?v=9KDDhAOyv9k", "https://www.youtube.com/@kotecinho", "", null])(
    "has no request for %s",
    (value) => {
      expect(api.youtubeOEmbedUrl(value)).toBeNull();
    },
  );
});
