import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClipperSetupStatus } from "@/types";
import { ClipperStatus } from "./ClipperStatus";

const status: ClipperSetupStatus = {
  host_installed: true,
  host_current: true,
  app_version: "0.1.0",
  browsers: [{ label: "Dia", detected: true, connected: true }],
  last_connection_check: null,
  connection_check_error: null,
};

describe("clipper historical connection diagnostic", () => {
  it("does not infer a handshake from a registered host", () => {
    render(<ClipperStatus status={status} />);
    expect(screen.getByText(/No confirmed connection check recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/Last confirmed connection:/)).not.toBeInTheDocument();
  });

  it("shows confirmed date/version as historical, including when registration is missing", () => {
    const { container } = render(<ClipperStatus status={{ ...status, browsers: [], last_connection_check: {
      schema_version: 1,
      check_id: "dd830aea-79ae-4b2e-9e09-66c37c70f96c",
      confirmed_at: "2026-08-31T15:20:30Z",
      host_version: "0.0.9",
      host_api_version: 2,
      extension_id: "eioalidaccoahofcggkbinalibpajokh",
    } }} />);
    expect(screen.getByText(/31\.08\.2026/)).toBeInTheDocument();
    expect(screen.getByText(/Host 0\.0\.9, protocol 2/)).toBeInTheDocument();
    expect(screen.getByText(/Historical result — not a live connection check/)).toBeInTheDocument();
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-31T15:20:30Z");
  });

  it("reports an unreadable record without inventing a connection failure", () => {
    render(<ClipperStatus status={{ ...status, connection_check_error: "Last connection check could not be read" }} />);
    expect(screen.getByText("Last connection check could not be read")).toBeInTheDocument();
    expect(screen.getByText(/Helper installed — matches Mine/)).toBeInTheDocument();
  });
});
