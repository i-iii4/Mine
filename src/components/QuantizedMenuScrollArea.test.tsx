import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  QuantizedMenuScrollArea,
  quantizedMenuListMaxHeight,
} from "./QuantizedMenuScrollArea";

describe("quantizedMenuListMaxHeight", () => {
  it("caps list height to a whole number of default rows", () => {
    expect(
      quantizedMenuListMaxHeight({
        rowCount: 20,
        rowHeightPx: 32,
        paddingYPx: 8,
        maxRows: 8,
      }),
    ).toBe(264);
  });

  it("subtracts fixed menu chrome before quantizing available rows", () => {
    expect(
      quantizedMenuListMaxHeight({
        rowCount: 20,
        rowHeightPx: 32,
        paddingYPx: 8,
        maxRows: 8,
        availableHeightPx: 300,
        fixedHeightPx: 40,
      }),
    ).toBe(232);
  });

  it("shrinks to content when the list has fewer rows than the cap", () => {
    expect(
      quantizedMenuListMaxHeight({
        rowCount: 3,
        rowHeightPx: 40,
        paddingYPx: 8,
        maxRows: 7,
      }),
    ).toBe(128);
  });
});

describe("QuantizedMenuScrollArea", () => {
  it("applies a max height that is exactly row-height quantized", () => {
    const { container } = render(
      <QuantizedMenuScrollArea rowCount={12} rowSize="default" maxRows={8}>
        <div />
      </QuantizedMenuScrollArea>,
    );

    const scrollArea = container.querySelector("[data-quantized-menu-scroll-area]") as HTMLElement;

    expect(scrollArea).toHaveStyle({ maxHeight: "264px" });
    expect(scrollArea.style.getPropertyValue("--menu-row-height")).toBe("32px");
  });
});
