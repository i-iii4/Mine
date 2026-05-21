import { describe, expect, it } from "vitest";
import { filterAndRankChannelSearch } from "./channelSearch";

const channels = [
  { tag: "Interface", label: "Interface" },
  { tag: "Typography", label: "Typography" },
  { tag: "Motion", label: "Motion" },
  { tag: "Slow motion", label: "Slow motion" },
  { tag: "Local first", label: "Local first" },
  { tag: "Mine research", label: "Mine research" },
];

function search(query: string): string[] {
  return filterAndRankChannelSearch(
    channels.map((channel) => ({
      item: channel,
      texts: [channel.label, channel.tag],
    })),
    query,
  ).map((channel) => channel.tag);
}

describe("channel search ranking", () => {
  it("matches channels case-insensitively", () => {
    expect(search("mine")).toEqual(["Mine research"]);
    expect(search("MINE")).toEqual(["Mine research"]);
  });

  it("ranks full-label prefix matches above later word matches", () => {
    expect(search("mo").slice(0, 2)).toEqual(["Motion", "Slow motion"]);
  });

  it("keeps channel order for equal scores", () => {
    const ranked = filterAndRankChannelSearch(
      [
        { item: "first", texts: ["Alpha"] },
        { item: "second", texts: ["Alpha"] },
      ],
      "alpha",
    );

    expect(ranked).toEqual(["first", "second"]);
  });

  it("accepts bounded typos without showing unrelated channels", () => {
    expect(search("typograpgy")).toEqual(["Typography"]);
  });
});
