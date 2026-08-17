// The recommendation must reach exactly the person who lives with the problem
// and no one else — and closing it must record the right scope of "no".

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloudRecommendation } from "./CloudRecommendation";
import {
  cloudRecommendationState,
  dismissCloudRecommendation,
} from "@/lib/commands";

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  cloudRecommendationState: vi.fn(),
  dismissCloudRecommendation: vi.fn(),
}));

const stateMock = vi.mocked(cloudRecommendationState);
const dismissMock = vi.mocked(dismissCloudRecommendation);

beforeEach(() => {
  stateMock.mockReset();
  dismissMock.mockReset();
  dismissMock.mockResolvedValue(null);
});

describe("CloudRecommendation", () => {
  it("stays silent when the backend says the advice is not due", async () => {
    stateMock.mockResolvedValue({ due: false });
    const { container } = render(<CloudRecommendation vaultPath="/v" />);
    await waitFor(() => expect(stateMock).toHaveBeenCalled());
    expect(container.querySelector("[data-cloud-recommendation]")).toBeNull();
  });

  it("shows once due and closes for this space only", async () => {
    stateMock.mockResolvedValue({ due: true });
    render(<CloudRecommendation vaultPath="/v" />);
    await screen.findByText("Cards keep arriving slowly");

    // Honest about agency: the setting belongs to the system.
    expect(screen.getByText(/Mine cannot turn it on for you/)).toBeInTheDocument();
    // Х22: the alternative is named with its blast radius.
    expect(screen.getByText(/all of iCloud Drive/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss recommendation"));
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith(false));
    expect(screen.queryByText("Cards keep arriving slowly")).not.toBeInTheDocument();
  });

  it("passes the checkbox through as the global no", async () => {
    stateMock.mockResolvedValue({ due: true });
    render(<CloudRecommendation vaultPath="/v" />);
    await screen.findByText("Cards keep arriving slowly");

    fireEvent.click(screen.getByText("Don’t show again"));
    fireEvent.click(screen.getByLabelText("Dismiss recommendation"));
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith(true));
  });

  it("re-evaluates when a sync pass lands", async () => {
    stateMock.mockResolvedValue({ due: false });
    const { rerender } = render(<CloudRecommendation vaultPath="/v" refreshToken={0} />);
    await waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));

    stateMock.mockResolvedValue({ due: true });
    rerender(<CloudRecommendation vaultPath="/v" refreshToken={1} />);
    await screen.findByText("Cards keep arriving slowly");
    expect(stateMock).toHaveBeenCalledTimes(2);
  });
});
