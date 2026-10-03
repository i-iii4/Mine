import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayoutSection } from "./LayoutSection";
import {
  getVaultWriteLayout,
  listSpaces,
  setVaultWriteLayout,
  spacesInTabs,
} from "@/lib/commands";
import type { SpaceEntry } from "@/types";

vi.mock("@/lib/commands", () => ({
  getVaultWriteLayout: vi.fn(),
  setVaultWriteLayout: vi.fn(),
  listSpaces: vi.fn(),
  spacesInTabs: vi.fn(),
}));

const getMock = vi.mocked(getVaultWriteLayout);
const setMock = vi.mocked(setVaultWriteLayout);

const STANDARD = { cards: "Cards", media: "Media", collections: "Collections" };
const FLAT = { cards: "", media: "", collections: "" };

const MINE = "mine-id";
const ARCHIVE = "archive-id";
const KNOWN: SpaceEntry[] = [
  { vault_id: MINE, path: "/Users/me/Mine", name: "Mine", available: true, current: false },
  { vault_id: ARCHIVE, path: "/Users/me/Archive", name: "Archive", available: true, current: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSpaces).mockResolvedValue(KNOWN);
  vi.mocked(spacesInTabs).mockResolvedValue([MINE]);
});

describe("LayoutSection", () => {
  it("asks for an open space when no tab shows one", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([]);
    render(<LayoutSection />);

    expect(await screen.findByText("Open a space to configure its folders.")).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("reads and writes the folders of the space chosen in the section", async () => {
    vi.mocked(spacesInTabs).mockResolvedValue([MINE, ARCHIVE]);
    getMock.mockImplementation(async (vaultId?: string) => (vaultId === ARCHIVE ? FLAT : STANDARD));
    setMock.mockResolvedValue({ ...FLAT, media: "Assets" });
    const user = userEvent.setup();
    render(<LayoutSection />);

    // The first open space by default.
    expect(await screen.findByLabelText("Cards")).toHaveValue("Cards");
    expect(getMock).toHaveBeenCalledWith(MINE);

    const trigger = screen.getByRole("button", { name: "Space: Mine" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Archive" }));

    await waitFor(() => expect(screen.getByLabelText("Cards")).toHaveValue(""));
    expect(getMock).toHaveBeenLastCalledWith(ARCHIVE);
    expect(screen.getByRole("button", { name: "Space: Archive" })).toBeInTheDocument();

    const media = screen.getByLabelText("Media");
    await user.type(media, "Assets");
    await user.tab();
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith({ ...FLAT, media: "Assets" }, ARCHIVE),
    );
  });

  it("shows the configured folders", async () => {
    getMock.mockResolvedValue(STANDARD);
    render(<LayoutSection />);

    expect(await screen.findByLabelText("Cards")).toHaveValue("Cards");
    expect(screen.getByLabelText("Media")).toHaveValue("Media");
    expect(screen.getByLabelText("Collections")).toHaveValue("Collections");
  });

  it("names the root instead of showing an empty field as a mystery", async () => {
    getMock.mockResolvedValue(FLAT);
    render(<LayoutSection />);

    // The fields are empty, but each caption says what empty means — one per
    // configurable folder.
    expect(await screen.findAllByText(/currently Space root/)).toHaveLength(3);
  });

  it("saves a changed folder on blur", async () => {
    getMock.mockResolvedValue(STANDARD);
    setMock.mockResolvedValue({ ...STANDARD, media: "Assets" });
    const user = userEvent.setup();
    render(<LayoutSection />);

    const media = await screen.findByLabelText("Media");
    await user.clear(media);
    await user.type(media, "Assets");
    await user.tab();

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith({ ...STANDARD, media: "Assets" }, MINE),
    );
  });

  it("allows one destination to be root while the others stay configured", async () => {
    getMock.mockResolvedValue(STANDARD);
    setMock.mockResolvedValue({ ...STANDARD, media: "" });
    const user = userEvent.setup();
    render(<LayoutSection />);

    const media = await screen.findByLabelText("Media");
    await user.clear(media);
    await user.tab();

    await waitFor(() => expect(setMock).toHaveBeenCalledWith({ ...STANDARD, media: "" }, MINE));
    expect(await screen.findByText(/New images and video, currently Space root/)).toBeInTheDocument();
  });

  it("surfaces a rejected folder and keeps the saved value", async () => {
    getMock.mockResolvedValue(STANDARD);
    setMock.mockRejectedValue(new Error("write folder must stay inside the vault: ../outside"));
    const user = userEvent.setup();
    render(<LayoutSection />);

    const cards = await screen.findByLabelText("Cards");
    await user.clear(cards);
    await user.type(cards, "../outside");
    await user.tab();

    expect(await screen.findByText(/must stay inside the vault/)).toBeInTheDocument();
  });
});
