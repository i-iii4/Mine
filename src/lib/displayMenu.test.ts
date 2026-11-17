import { describe, expect, it } from "vitest";
import { chosenValue, displayChoice, displaySpec, labelledChoices, type DisplayChoice } from "./displayMenu";
import { menuSpecSize } from "./menuSpec";
import type { MenuEntry } from "@/types";

const SORT: DisplayChoice<"newest" | "oldest">[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

describe("a group of a Display panel", () => {
  it("is its caption, then the choice of one value under it", () => {
    expect(displayChoice("sort", "Sort", "oldest", SORT)).toEqual([
      { kind: "caption", text: "Sort" },
      {
        kind: "radio",
        id: "sort",
        value: "oldest",
        options: [{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }],
        closes: false,
      },
    ]);
  });

  it("labels its values in their order", () => {
    expect(labelledChoices(["full", "peek"] as const, { peek: "Peek", full: "Full page" })).toEqual([
      { value: "full", label: "Full page" },
      { value: "peek", label: "Peek" },
    ]);
  });

  it("reads a choice only when it is its own and names one of its values", () => {
    expect(chosenValue({ kind: "choose", id: "sort", value: "oldest" }, "sort", SORT)).toBe("oldest");
    // Another group's choice, a value the group does not offer, another kind
    // of action.
    expect(chosenValue({ kind: "choose", id: "show", value: "oldest" }, "sort", SORT)).toBeNull();
    expect(chosenValue({ kind: "choose", id: "sort", value: "random" }, "sort", SORT)).toBeNull();
    expect(chosenValue({ kind: "run", id: "sort" }, "sort", SORT)).toBeNull();
    expect(chosenValue({ kind: "check", id: "sort", checked: true }, "sort", SORT)).toBeNull();
  });
});

describe("a Display panel", () => {
  const sort = displayChoice("sort", "Sort", "newest", SORT);
  const links: MenuEntry[] = [
    { kind: "caption", text: "Links" },
    { kind: "checkbox", id: "links.wikilinks", label: "Wikilinks", checked: true },
    { kind: "checkbox", id: "links.related", label: "Related notes", checked: false },
  ];

  it("holds its groups in order, a separator between them and none at its ends", () => {
    const spec = displaySpec([sort, [], links]);
    expect(spec.role).toBe("action");
    expect(spec.entries.map((entry) => ("id" in entry ? entry.id : entry.kind))).toEqual([
      "caption", "sort", "separator", "caption", "links.wikilinks", "links.related",
    ]);
    expect(displaySpec([]).entries).toEqual([]);
    expect(displaySpec([[], sort]).entries).toEqual(sort);
  });

  it("counts a caption as a line, a choice as a row for each value, a switch as a row", () => {
    // Sort: 28 and two rows; the separator 9; Links: 28 and two rows.
    expect(menuSpecSize(displaySpec([sort, links])).size).toEqual({ width: 240, height: 10 + (28 + 2 * 32) + 9 + (28 + 2 * 32) });
  });
});
