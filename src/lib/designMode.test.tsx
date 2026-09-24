import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { applyDesign, getDesignMode, getStoredDesignMode, useDesignMode } from "./designMode";

function Probe() {
  return <span data-testid="mode">{useDesignMode()}</span>;
}

beforeEach(() => localStorage.clear());
afterEach(() => document.documentElement.removeAttribute("data-design"));

describe("designMode", () => {
  it("uses Alt 1 on a fresh installation", () => {
    expect(getStoredDesignMode()).toBe("alt");
    applyDesign(getStoredDesignMode());
    expect(document.documentElement.getAttribute("data-design")).toBe("alt");
  });

  it.each(["default", "alt2", "alt9"])("normalizes the retired %s mode", (mode) => {
    localStorage.setItem("mine.design", mode);
    applyDesign(getStoredDesignMode());
    expect(localStorage.getItem("mine.design")).toBe("alt");
    expect(getDesignMode()).toBe("alt");
  });

  it("migrates the retired alt theme value without changing the chosen design", () => {
    localStorage.setItem("theme", "alt");
    expect(getStoredDesignMode()).toBe("alt");
    expect(localStorage.getItem("theme")).toBe("system");
  });

  it("reports Alt 1 to layout consumers", () => {
    render(<Probe />);
    expect(screen.getByTestId("mode")).toHaveTextContent("alt");
  });
});
