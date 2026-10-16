import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphAuditRoute } from "./GraphAuditRoute";

/// The graph audit (scripts/graph-view-audit.mjs) turns the extra links off
/// and on through this route and checks the layout stays where it is
/// (SPEC_GRAPH_VIEW.md, «Панель графа», ГП4): the switch must reach the
/// graph's request as the panel's does.
describe("GraphAuditRoute", () => {
  beforeEach(() => {
    // The graph follows the system theme; jsdom has no media queries.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("switches both extra kinds of link off and back on in the graph's request", async () => {
    render(<GraphAuditRoute />);
    const options = () => window.__MINE_GRAPH_AUDIT__?.lastOptions;
    await waitFor(() => expect(options()).toMatchObject({
      include_wikilinks: true,
      include_related_notes: true,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Hide extra links" }));
    await waitFor(() => expect(options()).toMatchObject({
      include_wikilinks: false,
      include_related_notes: false,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Show extra links" }));
    await waitFor(() => expect(options()).toMatchObject({
      include_wikilinks: true,
      include_related_notes: true,
    }));
  });
});
