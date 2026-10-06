import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// Card states (SPEC_CARD_STATES.md): keyboard focus colours the card's own
/// frame (its line and its media's outline, --card-frame-color) with --border-accent and washes a picture; a chosen collection's
/// highlight colours the border only. Pointer hover adds no border and no wash, only the card's
/// buttons. Selection uses the brighter --feed-selection-frame, never draws
/// outside the card, and outranks every other state.
describe("card state styles", () => {
  // Comments mention selectors too; only the rules count.
  const css = readFileSync("src/styles/global.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = css.split("}");
  const ruleFor = (selectorPart: string, declaration: string) =>
    rules.some((block) => block.includes(selectorPart) && block.includes(declaration));

  it("gives keyboard focus and the collection highlight the accent border", () => {
    expect(ruleFor('[data-feed-grid-item-focused="true"] [data-block-slug]', "--card-frame-color: var(--border-accent)")).toBe(true);
    expect(ruleFor('[data-feed-grid-item-collection-lit="true"] [data-block-slug]', "--card-frame-color: var(--border-accent)")).toBe(true);
  });

  it("draws the frame's line over what the frame holds, clipped at the line's middle", () => {
    expect(ruleFor("[data-feed-card-frame]::after {", "border: 1px solid var(--card-frame-color)")).toBe(true);
    expect(ruleFor("[data-feed-card-frame]::after {", "z-index: 1")).toBe(true);
    expect(ruleFor("[data-feed-card-frame]::after {", "border-color var(--card-frame-fade")).toBe(true);
    expect(ruleFor("[data-feed-card-frame] {", "--card-frame-line-radius: max(0px, calc(var(--card-frame-outer-radius) - 0.5px))")).toBe(true);
  });

  it("draws the media outline as the frame's ring mirrored, in its colour and fade, rising with the media (Д20)", () => {
    expect(ruleFor("[data-card-media-outline] {", "border: 1px solid var(--card-frame-color)")).toBe(true);
    expect(ruleFor("[data-card-media-outline] {", "border-radius: var(--card-frame-outer-radius)")).toBe(true);
    expect(ruleFor("[data-card-media-outline] {", "clip-path: inset(var(--media-outline-half) 0 0 0)")).toBe(true);
    expect(ruleFor("[data-card-media-outline] {", "border-color var(--card-frame-fade")).toBe(true);
    expect(ruleFor('[data-card-lift-pinned] [data-card-media-outline="on-lift"]', "translateY(calc(-1 * var(--card-lift)))")).toBe(true);
  });

  it("leaves pointer hover without a border or a wash", () => {
    expect(css).not.toMatch(/\[data-feed-grid-item[^\]]*\]:hover/);
  });

  it("marks a selected card with its own border in the bright colour", () => {
    expect(ruleFor('[data-feed-grid-item-selected="true"] [data-block-slug]', "--card-frame-color: var(--feed-selection-frame)")).toBe(true);
    expect(css).not.toContain("[data-feed-grid-selection-frame]");
    expect(css).not.toContain("--feed-selection-ring");
  });

  it("lets selection outrank keyboard focus and the collection highlight", () => {
    const count = (selector: string) => (selector.match(/\[/g) ?? []).length;
    const selectorOf = (part: string, declaration: string) => {
      const block = rules.find((candidate) => candidate.includes(part) && candidate.includes(declaration))!;
      return block.slice(block.lastIndexOf("\n\n") + 2, block.indexOf("{")).split(",").find((line) => line.includes(part))!;
    };
    const selected = selectorOf('[data-feed-grid-item-selected="true"] [data-block-slug]', "--feed-selection-frame");
    const focused = selectorOf('[data-feed-grid-item-focused="true"] [data-block-slug]', "--border-accent");
    expect(count(selected)).toBeGreaterThan(count(focused));
  });

  it("washes pictures when focused or selected", () => {
    for (const state of [
      '[data-feed-grid-item-selected="true"]',
      '[data-feed-grid-item-focused="true"]',
    ]) {
      expect(ruleFor(`${state} [data-card-media-clip] > [data-card-lift="window"]::after`, "opacity: 1")).toBe(true);
    }
  });

  it("lights a chosen collection's cards with the border only, never the wash (С3, С7)", () => {
    expect(ruleFor('[data-feed-grid-item-collection-lit="true"] [data-card-media-clip] > [data-card-lift="window"]::after', "opacity: 1")).toBe(false);
  });
});
