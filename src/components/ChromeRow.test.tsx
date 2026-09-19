import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChromeRow, ChromeShell } from "./ChromeRow";

describe("shared chrome geometry", () => {
  it.each(["top", "bottom"] as const)("keeps the %s divider outside the content and forwards the ref", (separator) => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<ChromeRow ref={ref} separator={separator}>Contents</ChromeRow>);
    const row = screen.getByText("Contents");
    expect(ref.current).toBe(row);
    expect(row).toHaveClass("chrome-row");
    expect(row.querySelector("[data-slot=separator]")).toBeNull();
    expect(container.querySelectorAll("[data-chrome-divider]")).toHaveLength(1);
    const sibling = separator === "top" ? row.previousElementSibling : row.nextElementSibling;
    expect(sibling).toHaveAttribute("data-chrome-divider");
  });

  it("owns outer boundaries once and shares a single separator between upper rows", () => {
    const { container } = render(
      <ChromeShell>
        <ChromeRow as="header" separator="bottom">Header</ChromeRow>
        <ChromeRow separator="bottom">Metadata</ChromeRow>
        <main>Body</main>
        <ChromeRow separator="top">Actions</ChromeRow>
      </ChromeShell>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("Header");
    expect(container.querySelectorAll("[data-chrome-frame-edge]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-chrome-divider]")).toHaveLength(3);
    expect(screen.getByText("Metadata").previousElementSibling).toBe(screen.getByText("Header").nextElementSibling);
    expect(container.querySelector("[data-slot=separator] + [data-slot=separator]")).toBeNull();
  });
});
