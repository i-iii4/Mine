import { describe, expect, it, vi } from "vitest";
import { cardMenuEntries, runCardMenuItem } from "./cardMenuEntries";
import {
  decodeCardMenuPayload,
  encodeCardMenuPayload,
  parseActionMessage,
  parseAnswerMessage,
  parseUpdateMessage,
  type CardMenuPayload,
} from "./menuPanelProtocol";
import { parseMenuMode } from "./menuMode";


const PAYLOAD: CardMenuPayload = {
  opener: { kind: "point" },
  byKey: true,
  buttons: "retro",
  entries: cardMenuEntries({
    hasUrl: true,
    disconnectFrom: "Web",
    tableCommands: [{ id: "row-above", label: "Add Row Above", destructive: false, separatorBefore: false }],
  }),
  picker: { blockSlug: "card", selectedTags: ["Web"], tags: [{ tag: "Web", count: 3 }], currentTag: "Web" },
};

describe("cardMenuEntries", () => {
  it("groups the card's collections, its link, its file and the card itself", () => {
    const entries = cardMenuEntries({ hasUrl: true, disconnectFrom: "Web", tableCommands: [] });
    expect(entries.map((entry) => (entry.kind === "item" ? entry.id : entry.kind))).toEqual([
      "connect",
      "separator",
      "source",
      "copy-link",
      "separator",
      "reveal",
      "copy-path",
      "separator",
      "rename",
      "disconnect",
      "delete",
    ]);
  });

  it("has no link group without a link, no Disconnect off a collection, Table only with a table", () => {
    const entries = cardMenuEntries({ hasUrl: false, disconnectFrom: null, tableCommands: [] });
    expect(entries.map((entry) => (entry.kind === "item" ? entry.id : entry.kind))).toEqual([
      "connect",
      "separator",
      "reveal",
      "copy-path",
      "separator",
      "rename",
      "delete",
    ]);
    const withTable = cardMenuEntries({
      hasUrl: false,
      disconnectFrom: null,
      tableCommands: [{ id: "a", label: "A", destructive: false, separatorBefore: false }],
    });
    expect(withTable[1]?.kind).toBe("table");
  });

  it("names the collection Disconnect leaves", () => {
    const disconnect = cardMenuEntries({ hasUrl: false, disconnectFrom: "Web", tableCommands: [] })
      .find((entry) => entry.kind === "item" && entry.id === "disconnect");
    expect(disconnect).toMatchObject({ label: "Disconnect from “Web”", variant: "detach", truncate: true });
  });

  it("runs an item with the handlers of the tab", () => {
    const onToggleTag = vi.fn();
    const onRequestRename = vi.fn();
    const onRequestDelete = vi.fn();
    const context = {
      block: { slug: "card" },
      url: null,
      filePath: "/space/card.md",
      currentTag: "Web",
      onToggleTag,
      onRequestRename,
      onRequestDelete,
    };
    runCardMenuItem("disconnect", context);
    runCardMenuItem("rename", context);
    runCardMenuItem("delete", context);
    expect(onToggleTag).toHaveBeenCalledWith("card", "Web", true);
    expect(onRequestRename).toHaveBeenCalledWith({ slug: "card" });
    expect(onRequestDelete).toHaveBeenCalledWith("card");
  });
});

describe("the payload between the tab and the panel", () => {
  it("survives the trip through the backend whole", () => {
    expect(decodeCardMenuPayload(encodeCardMenuPayload(PAYLOAD))).toEqual(PAYLOAD);
  });

  it("refuses what is not a menu", () => {
    expect(decodeCardMenuPayload("not json")).toBeNull();
    expect(decodeCardMenuPayload(JSON.stringify({ ...PAYLOAD, entries: [{ kind: "item", id: "format-disk" }] }))).toBeNull();
    expect(decodeCardMenuPayload(JSON.stringify({ ...PAYLOAD, opener: { kind: "plate", align: "middle" } }))).toBeNull();
    expect(decodeCardMenuPayload(JSON.stringify({ ...PAYLOAD, picker: { ...PAYLOAD.picker, tags: [{ tag: 1 }] } }))).toBeNull();
  });

  it("reads choices, answers and updates and drops the rest", () => {
    expect(parseActionMessage({ menu: 1, request: 2, action: { kind: "run", id: "copy-path" } }))
      .toEqual({ menu: 1, request: 2, action: { kind: "run", id: "copy-path" } });
    expect(parseActionMessage({ menu: 1, request: 2, action: { kind: "run", id: "rm" } })).toBeNull();
    expect(parseActionMessage({ menu: "1", request: 2, action: { kind: "check", name: "x" } })).toBeNull();
    expect(parseAnswerMessage({ menu: 1, request: 2, answer: { kind: "membership", made: null } }))
      .toEqual({ menu: 1, request: 2, answer: { kind: "membership", made: null } });
    expect(parseAnswerMessage({ menu: 1, request: 2, answer: { kind: "refusal", reason: 3 } })).toBeNull();
    expect(parseUpdateMessage({ menu: 4, payload: PAYLOAD })).toEqual({ menu: 4, payload: PAYLOAD });
    expect(parseUpdateMessage({ menu: 4, payload: {} })).toBeNull();
  });
});

describe("parseMenuMode", () => {
  it("is Web unless Window was chosen", () => {
    expect(parseMenuMode(null)).toBe("web");
    expect(parseMenuMode("system")).toBe("web");
    expect(parseMenuMode("window")).toBe("window");
  });
});
