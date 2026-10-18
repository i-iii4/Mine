import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBlock, resolveNoteLink } from "@/lib/commands";
import { indexedBlock } from "@/test/blocks";
import { NOTE_EMBED_WIDTH_PX, NoteEmbed, NoteEmbedLookups } from "./NoteEmbed";

vi.mock("@/lib/commands", () => ({ getBlock: vi.fn(), resolveNoteLink: vi.fn() }));
vi.mock("@/lib/appLog", () => ({ logFailure: vi.fn() }));
vi.mock("@/components/Card", () => ({
  ReadOnlyCardPreview: ({ block, width, shadow }: { block: { slug: string; body: string }; width: number; shadow: string }) => (
    <div data-test-card={block.slug} data-width={width} data-shadow={shadow}>{block.slug}</div>
  ),
}));

const SOURCE = "Cards/Source";
const notes: Record<string, string> = { Peer: "Cards/Peer", Source: SOURCE, Ring: "Cards/Ring" };

function embed(lookups: NoteEmbedLookups, target: string, label: string | null = null) {
  return <NoteEmbed lookups={lookups} target={target} fragment={null} label={label} vaultPath="/vault" thumbsRootPath="/thumbs" />;
}

beforeEach(() => {
  vi.mocked(resolveNoteLink).mockReset().mockImplementation(async (_source, target) => notes[target] ?? null);
  vi.mocked(getBlock).mockReset().mockImplementation(async (slug) => indexedBlock({ slug, body: `![[${slug === "Cards/Ring" ? "Source" : "Ring"}]]` }));
});

// SPEC_READING_MODE.md, Ч11.
describe("NoteEmbed", () => {
  it("takes no room until its lookup answers, then shows the note's card 240 wide without a shadow", async () => {
    const lookups = new NoteEmbedLookups(SOURCE);
    const { container } = render(embed(lookups, "Peer"));
    expect(container.querySelector("[data-note-embed]")).toBeNull();
    await waitFor(() => expect(container.querySelector("[data-test-card='Cards/Peer']")).not.toBeNull());
    expect(container.querySelector("[data-test-card]")).toHaveAttribute("data-width", String(NOTE_EMBED_WIDTH_PX));
    expect(container.querySelector("[data-test-card]")).toHaveAttribute("data-shadow", "none");
    expect(resolveNoteLink).toHaveBeenCalledWith(SOURCE, "Peer");
  });

  it("shows a missing note as one quiet line with its name or caption", async () => {
    const lookups = new NoteEmbedLookups(SOURCE);
    const { container } = render(<>{embed(lookups, "Gone")}{embed(lookups, "Lost", "A caption")}</>);
    await waitFor(() => expect(container.querySelectorAll("[data-note-embed='missing']")).toHaveLength(2));
    const [gone, lost] = container.querySelectorAll("[data-note-embed='missing']");
    expect(gone).toHaveTextContent("Gone");
    expect(gone).toHaveAttribute("title", "No note named “Gone”");
    expect(gone).toHaveClass("text-muted-foreground");
    expect(lost).toHaveTextContent("A caption");
    expect(getBlock).not.toHaveBeenCalled();
  });

  it("shows a note embedding itself and a ring of two as one card each, never unfolding", async () => {
    const lookups = new NoteEmbedLookups(SOURCE);
    const { container } = render(<>{embed(lookups, "Source")}{embed(lookups, "Ring")}</>);
    await waitFor(() => expect(container.querySelectorAll("[data-test-card]")).toHaveLength(2));
    expect([...container.querySelectorAll("[data-test-card]")].map((card) => card.getAttribute("data-test-card"))).toEqual([SOURCE, "Cards/Ring"]);
    expect(resolveNoteLink).toHaveBeenCalledTimes(2);
  });

  it("looks a target written several times up once, all in one pass", async () => {
    const lookups = new NoteEmbedLookups(SOURCE);
    const { container } = render(<>{embed(lookups, "Peer")}{embed(lookups, "Peer")}{embed(lookups, "Source")}</>);
    await waitFor(() => expect(container.querySelectorAll("[data-test-card]")).toHaveLength(3));
    expect(vi.mocked(resolveNoteLink).mock.calls.map((call) => call[1])).toEqual(["Peer", "Source"]);
    await lookups.settled();
  });

  it("looks targets up again on vault-refreshed and changes the embed", async () => {
    const lookups = new NoteEmbedLookups(SOURCE);
    const { container } = render(embed(lookups, "Peer"));
    await waitFor(() => expect(container.querySelector("[data-test-card]")).not.toBeNull());
    vi.mocked(resolveNoteLink).mockResolvedValue(null);
    await act(async () => {
      lookups.refresh();
      await lookups.settled();
    });
    expect(container.querySelector("[data-note-embed='missing']")).not.toBeNull();
  });

  it("settles when every lookup has answered", async () => {
    const lookups = new NoteEmbedLookups(SOURCE);
    let answer: (slug: string | null) => void = () => undefined;
    vi.mocked(resolveNoteLink).mockReturnValueOnce(new Promise((done) => { answer = done; }));
    render(embed(lookups, "Peer"));
    let settled = false;
    await act(async () => { await Promise.resolve(); });
    void lookups.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await act(async () => {
      answer(null);
      await lookups.settled();
    });
    expect(settled).toBe(true);
  });

  it("treats a lookup that failed as a missing note and logs it", async () => {
    vi.mocked(resolveNoteLink).mockRejectedValue(new Error("index busy"));
    const lookups = new NoteEmbedLookups(SOURCE);
    const { container } = render(embed(lookups, "Peer"));
    await waitFor(() => expect(container.querySelector("[data-note-embed='missing']")).not.toBeNull());
  });
});
