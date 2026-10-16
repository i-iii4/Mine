import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { ImagePreviewOverlay } from "../ImagePreviewOverlay";
import { SidebarOverlay } from "../SidebarOverlay";

/// One scrim for every layer over the tab's page (SPEC_COLOR_RULES.md, 3.9.1;
/// user's decisions of 16.10.2026): the windows on the dialog's scrim, the
/// image preview and the sidebar over the feed share `.modal-scrim` and its
/// values, taken from benchmarks.
describe("the scrim", () => {
  const css = readFileSync("src/styles/global.css", "utf8");

  it("is one surface with one set of values: Apple's thin material, Material 3's 32 % dim", () => {
    expect(css).toContain("--scrim-blur: 20px;");
    expect(css).toContain("--scrim-saturate: 150%;");
    expect(css).toContain("--scrim-color: color-mix(in oklch, var(--background) 32%, transparent);");
    const surface = /\.modal-scrim \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(surface).toContain("background-color: var(--scrim-color);");
    expect(surface).toContain("backdrop-filter: blur(var(--scrim-blur)) saturate(var(--scrim-saturate));");
    // No layer keeps a dim or a filter of its own.
    const overlay = /\.sidebar-overlay-scrim \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(overlay).not.toMatch(/background|backdrop-filter/);
    expect(css).not.toMatch(/\.image-preview-secondary-plane \{/);
    expect(css).not.toContain("--sidebar-overlay-blur");
    expect(css).not.toContain("--modal-scrim-blur");
  });

  it("draws no frame around the previewed image (user decision 16.10.2026)", () => {
    expect(css).not.toMatch(/\.image-preview-primary-media \{/);
  });

  it("lies under a Dialog and an AlertDialog over the whole page", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Merge</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    render(
      <AlertDialog open>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>Delete element?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const scrims = document.querySelectorAll("[data-slot='dialog-overlay'], [data-slot='alert-dialog-overlay']");
    expect(scrims).toHaveLength(2);
    for (const scrim of scrims) {
      expect(scrim).toHaveClass("modal-scrim", "fixed", "inset-0");
      expect(scrim).not.toHaveClass("bg-glass");
    }
  });

  it("lies under the image preview over the whole page", () => {
    const { getByRole } = render(
      <ImagePreviewOverlay preview={{ src: "asset://localhost/photo.jpg", mediaRef: "photo.jpg" }} onClose={vi.fn()} />,
    );
    expect(getByRole("dialog", { name: "Image preview" })).toHaveClass("modal-scrim", "fixed", "inset-0");
  });

  it("lies under the sidebar over the feed", () => {
    const { container } = render(
      <SidebarOverlay open onClose={vi.fn()} header={null}>
        {null}
      </SidebarOverlay>,
    );
    expect(container.querySelector("[data-sidebar-overlay-scrim]")).toHaveClass("modal-scrim", "absolute", "inset-0");
  });
});
