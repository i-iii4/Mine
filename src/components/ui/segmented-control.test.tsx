import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./segmented-control";

describe("SegmentedControl", () => {
  it("uses the compact app switch geometry by default", () => {
    render(
      <SegmentedControl
        value="all"
        options={[
          { value: "all", label: "All" },
          { value: "linked", label: "Connected" },
        ]}
        onChange={vi.fn()}
        aria-label="Channel filter"
      />,
    );

    const control = screen.getByRole("group", { name: "Channel filter" });
    expect(control).toHaveClass(
      "h-6",
      "p-[2px]",
      "font-mono",
      "text-sm",
      "text-muted-foreground",
      "hover:bg-component-fill-hover",
    );
    expect(control).not.toHaveClass("hover:outline-component-fill-hover");
    expect(screen.getByRole("button", { name: "All" })).toHaveClass(
      "h-5",
      "bg-component-fill-inner",
    );
    expect(screen.getByRole("button", { name: "Connected" })).not.toHaveClass(
      "bg-component-fill-inner",
    );
    expect(screen.getByRole("button", { name: "Connected" })).not.toHaveClass(
      "hover:text-foreground",
    );
  });

  it("can scale the same switch contract to standard 32px controls", () => {
    render(
      <SegmentedControl
        value="screenshot"
        options={[
          { value: "content", label: "Content" },
          { value: "screenshot", label: "Screenshot" },
          { value: "link", label: "Link" },
        ]}
        onChange={vi.fn()}
        aria-label="Clip type"
        size="default"
      />,
    );

    const control = screen.getByRole("group", { name: "Clip type" });
    expect(control).toHaveClass("h-8", "p-[2px]", "text-base");
    expect(screen.getByRole("button", { name: "Screenshot" })).toHaveClass(
      "h-6",
      "bg-component-fill-inner",
    );
  });

  it("can scale the same switch contract to clipper 32px controls", () => {
    render(
      <SegmentedControl
        value="screenshot"
        options={[
          { value: "content", label: "Content" },
          { value: "screenshot", label: "Screenshot" },
          { value: "link", label: "Link" },
        ]}
        onChange={vi.fn()}
        aria-label="Clip type"
        size="clipper"
      />,
    );

    const control = screen.getByRole("group", { name: "Clip type" });
    expect(control).toHaveClass("h-8", "p-[2px]", "text-base");
    expect(screen.getByRole("button", { name: "Screenshot" })).toHaveClass(
      "h-7",
      "bg-component-fill-inner",
    );
  });

  it("emits selected value changes through one shared handler", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        value="content"
        options={[
          { value: "content", label: "Content" },
          { value: "link", label: "Link" },
        ]}
        onChange={onChange}
        aria-label="Clip type"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    expect(onChange).toHaveBeenCalledWith("link");
  });

  it("allows secondary chrome to set the inactive text tone", () => {
    render(
      <SegmentedControl
        value="grid"
        options={[
          { value: "grid", label: "Grid" },
          { value: "graph", label: "Graph" },
        ]}
        onChange={vi.fn()}
        aria-label="View mode"
        className="text-tertiary-foreground"
      />,
    );

    const control = screen.getByRole("group", { name: "View mode" });
    expect(control).toHaveClass("text-tertiary-foreground");
    expect(screen.getByRole("button", { name: "Graph" })).toHaveClass("text-current");
  });

  it("keeps inactive segment text stable on hover", () => {
    render(
      <SegmentedControl
        value="all"
        options={[
          { value: "all", label: "All" },
          { value: "linked", label: "Connected" },
        ]}
        onChange={vi.fn()}
        aria-label="Collection filter"
      />,
    );

    const inactive = screen.getByRole("button", { name: "Connected" });
    expect(inactive).toHaveClass("text-current");
    expect(inactive).not.toHaveClass("hover:text-foreground");
    expect(screen.getByRole("group", { name: "Collection filter" })).toHaveClass(
      "hover:bg-component-fill-hover",
    );
  });
});
