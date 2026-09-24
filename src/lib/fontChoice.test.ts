import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyContentFont,
  applyInterfaceFont,
  getStoredContentFont,
  getStoredInterfaceFont,
} from "./fontChoice";

describe("font choice", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-font-interface");
    document.documentElement.removeAttribute("data-font-content");
  });

  it("defaults to Geist for the interface and Geist Sans for content", () => {
    expect(getStoredInterfaceFont()).toBe("geist");
    expect(getStoredContentFont()).toBe("geist-sans");
  });

  it("normalizes retired font preferences to Geist", () => {
    localStorage.setItem("mine.fontInterface", "departure");
    localStorage.setItem("mine.fontContent", "geist-mono");
    applyInterfaceFont("departure");
    applyContentFont("geist-mono");
    expect(document.documentElement.getAttribute("data-font-interface")).toBe("geist");
    expect(document.documentElement.getAttribute("data-font-content")).toBe("geist-sans");
    expect(getStoredInterfaceFont()).toBe("geist");
    expect(getStoredContentFont()).toBe("geist-sans");
  });

  it("ships the fonts and the switch rules in the stylesheet", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    expect(css).toContain('font-family: "Departure Mono"');
    expect(css).toContain("/fonts/DepartureMono-Regular.woff2");
    // The font utilities are compiled inline, so the switch must restate the
    // family on the utilities — repointing --font-sans alone would not stick.
    expect(css).toMatch(/data-font-interface="departure"\] \.font-sans/);
    expect(css).toContain("[data-content-font]");
    expect(css).toMatch(/data-font-content="geist-mono"/);
  });

  it("keeps the article body opted into the content font", () => {
    const detail = readFileSync("src/components/Detail.tsx", "utf8");
    expect(detail).toMatch(/data-article-body\s+data-content-font/);
  });
});
