import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayoutSection } from "./LayoutSection";
import {
  getVaultWriteLayout,
  organizeVaultLayout,
  setVaultWriteLayout,
} from "@/lib/commands";

vi.mock("@/lib/commands", () => ({
  getVaultWriteLayout: vi.fn(),
  setVaultWriteLayout: vi.fn(),
  organizeVaultLayout: vi.fn(),
}));

const getMock = vi.mocked(getVaultWriteLayout);
const setMock = vi.mocked(setVaultWriteLayout);
const organizeMock = vi.mocked(organizeVaultLayout);

const STANDARD = { cards: "Cards", media: "Media", collections: "Collections" };
const FLAT = { cards: "", media: "", collections: "" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LayoutSection", () => {
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
    expect(await screen.findAllByText(/currently Vault root/)).toHaveLength(3);
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
      expect(setMock).toHaveBeenCalledWith({ ...STANDARD, media: "Assets" }),
    );
  });

  it("offers organizing only while the space is flat", async () => {
    getMock.mockResolvedValue(FLAT);
    organizeMock.mockResolvedValue(STANDARD);
    const user = userEvent.setup();
    render(<LayoutSection />);

    const organize = await screen.findByRole("button", { name: /organize/i });
    await user.click(organize);

    await waitFor(() => expect(organizeMock).toHaveBeenCalled());
    // The command returns the new layout, so the offer disappears without a
    // reload — folders now exist.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /organize/i })).not.toBeInTheDocument(),
    );
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
