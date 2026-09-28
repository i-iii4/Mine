import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// Card states share one look (SPEC_CARD_STATES.md): the card's own border
/// changes colour and, on a picture, the focus wash appears. Hover, keyboard
/// focus and the highlight from a hovered collection use --border-accent;
/// selection uses the brighter --feed-selection-frame and never draws outside
/// the card.
describe("card state styles", () => {
  const css = readFileSync("src/styles/global.css", "utf8");
  const ruleFor = (selectorPart: string, declaration: string) => {
    const blocks = css.split("}").filter((block) => block.includes(selectorPart));
    return blocks.some((block) => block.includes(declaration));
  };

  it("gives hover and the collection highlight the keyboard focus border", () => {
    expect(ruleFor('[data-feed-grid-item-live="true"]:hover [data-block-slug]', "border-color: var(--border-accent)")).toBe(true);
    expect(ruleFor('[data-feed-grid-item-collection-lit="true"] [data-block-slug]', "border-color: var(--border-accent)")).toBe(true);
    expect(ruleFor('[data-feed-grid-item-focused="true"] [data-block-slug]', "border-color: var(--border-accent)")).toBe(true);
  });

  it("marks a selected card with its own border in the bright colour", () => {
    expect(ruleFor('[data-feed-grid-item-selected="true"] [data-block-slug]', "border-color: var(--feed-selection-frame)")).toBe(true);
    expect(css).not.toContain("[data-feed-grid-selection-frame]");
    expect(css).not.toContain("--feed-selection-ring");
  });

  it("washes pictures in every state, and only pictures", () => {
    for (const state of [
      '[data-feed-grid-item-live="true"]:hover',
      '[data-feed-grid-item-collection-lit="true"]',
      '[data-feed-grid-item-selected="true"]',
      '[data-feed-grid-item-focused="true"]',
    ]) {
      expect(ruleFor(`${state} [data-card-graphic-surface]::after`, "opacity: 1")).toBe(true);
    }
  });

  it("lets selection win over the lighter states", () => {
    const lighter = css.indexOf('[data-feed-grid-item-collection-lit="true"] [data-block-slug]');
    const selected = css.indexOf('[data-feed-grid-item-selected="true"] [data-block-slug]');
    expect(lighter).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(lighter);
  });
});
