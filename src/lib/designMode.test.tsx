import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  applyDesign,
  getDesignMode,
  getStoredDesignMode,
  useDesignMode,
} from "./designMode";

function Probe() {
  return <span data-testid="mode">{useDesignMode()}</span>;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-design");
});

describe("designMode", () => {
  it("reads the data-design root attribute", () => {
    expect(getDesignMode()).toBe("default");
    document.documentElement.setAttribute("data-design", "alt");
    expect(getDesignMode()).toBe("alt");
  });

  it("keeps the second alternative apart from the first", () => {
    applyDesign("alt2");
    expect(localStorage.getItem("mine.design")).toBe("alt2");
    expect(document.documentElement.getAttribute("data-design")).toBe("alt2");
    expect(getDesignMode()).toBe("alt2");
    expect(getStoredDesignMode()).toBe("alt2");

    // An unknown value is not a variant: it falls back to the primary design
    // rather than leaving a stray attribute no stylesheet answers to.
    localStorage.setItem("mine.design", "alt9");
    expect(getStoredDesignMode()).toBe("default");
  });

  it("persists and applies the design variant independently of the theme", () => {
    applyDesign("alt");
    expect(localStorage.getItem("mine.design")).toBe("alt");
    expect(document.documentElement.getAttribute("data-design")).toBe("alt");
    // The color theme is untouched — the axes are orthogonal.
    expect(localStorage.getItem("theme")).toBeNull();

    applyDesign("default");
    expect(localStorage.getItem("mine.design")).toBe("default");
    expect(document.documentElement.hasAttribute("data-design")).toBe(false);
  });

  it("migrates the retired alt theme value into the design key", () => {
    localStorage.setItem("theme", "alt");
    expect(getStoredDesignMode()).toBe("alt");
    expect(localStorage.getItem("theme")).toBe("system");
    expect(localStorage.getItem("mine.design")).toBe("alt");
  });

  it("re-renders subscribers when the attribute flips", async () => {
    render(<Probe />);
    expect(screen.getByTestId("mode")).toHaveTextContent("default");

    document.documentElement.setAttribute("data-design", "alt");
    await waitFor(() => {
      expect(screen.getByTestId("mode")).toHaveTextContent("alt");
    });

    document.documentElement.removeAttribute("data-design");
    await waitFor(() => {
      expect(screen.getByTestId("mode")).toHaveTextContent("default");
    });
  });
});
