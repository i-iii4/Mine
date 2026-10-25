import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarReorderAuditRoute } from "./SidebarReorderAuditRoute";

/// The reorder audit (scripts/sidebar-reorder-audit.mjs) measures the
/// gesture on this route: the sidebar it mounts stands still at its width, so
/// no width motion runs under the measured drag.
describe("SidebarReorderAuditRoute", () => {
  it("mounts the sidebar with its collections at a fixed width", () => {
    render(
      <TooltipProvider>
        <SidebarReorderAuditRoute />
      </TooltipProvider>,
    );
    const route = document.querySelector<HTMLElement>("[data-sidebar-reorder-audit-route]");
    // The width as useSidebarResize writes it: on the root and on the panel,
    // which it does not leave (sidebarWidth.ts).
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("420px");
    const aside = route?.querySelector("aside");
    expect(aside?.style.getPropertyValue("--sidebar-width")).toBe("420px");
    expect(aside).toHaveStyle({ width: "var(--sidebar-width)", transition: "none" });
    expect(screen.getByText("c00-collection")).toBeInTheDocument();
  });
});
