import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/// Card states (SPEC_CARD_STATES.md): keyboard focus colours the card's own
/// border with --border-accent and washes a picture; a chosen collection's
/// highlight colours the border only. Pointer hover adds no border and no wash, only the card's
/// buttons. Selection uses the brighter --feed-selection-frame, never draws
/// outside the card, and outranks every other state.
describe("card state styles", () => {
  const css = readFileSync("src/styles/global.css", "utf8");
  const rules = css.split("}");
  const ruleFor = (selectorPart: string, declaration: string) =>
    rules.some((block) => block.includes(selectorPart) && block.includes(declaration));

  it("gives keyboard focus and the collection highlight the accent border", () => {
    expect(ruleFor('[data-feed-grid-item-focused="true"] [data-block-slug]', "border-color: var(--border-accent)")).toBe(true);
    expect(ruleFor('[data-feed-grid-item-collection-lit="true"] [data-block-slug]', "border-color: var(--border-accent)")).toBe(true);
  });

  it("leaves pointer hover without a border or a wash", () => {
    expect(css).not.toMatch(/\[data-feed-grid-item[^\]]*\]:hover/);
  });

  it("marks a selected card with its own border in the bright colour", () => {
    expect(ruleFor('[data-feed-grid-item-selected="true"] [data-block-slug]', "border-color: var(--feed-selection-frame)")).toBe(true);
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
      expect(ruleFor(`${state} [data-card-graphic-surface]::after`, "opacity: 1")).toBe(true);
    }
  });

  it("lights a chosen collection's cards with the border only, never the wash (С3, С7)", () => {
    expect(ruleFor('[data-feed-grid-item-collection-lit="true"] [data-card-graphic-surface]::after', "opacity: 1")).toBe(false);
  });
});
