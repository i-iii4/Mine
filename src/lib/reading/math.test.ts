import { describe, expect, it } from "vitest";
import { renderMath } from "./math";

// SPEC_READING_MODE.md, Ч9.
describe("renderMath", () => {
  it("draws a formula in a line with MathML for screen readers", async () => {
    const result = await renderMath("a^2 + b^2", { display: false });
    expect(result.kind).toBe("rendered");
    expect(result.kind === "rendered" && result.html).toContain("katex-mathml");
    expect(result.kind === "rendered" && result.html).not.toContain("katex-display");
  });

  it("draws a formula on a line of its own", async () => {
    const result = await renderMath("\\int_0^1 x^2 \\, dx", { display: true });
    expect(result.kind === "rendered" && result.html).toContain("katex-display");
  });

  it("gives back KaTeX's message for a formula it cannot read", async () => {
    const result = await renderMath("\\frac{1}{", { display: false });
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.message).toMatch(/KaTeX parse error/);
  });

  it("draws Cyrillic without complaint and keeps no link of the note", async () => {
    expect((await renderMath("\\text{длина} = 5", { display: false })).kind).toBe("rendered");
    const linked = await renderMath("\\href{https://example.com}{x}", { display: false });
    expect(linked.kind === "rendered" && linked.html).not.toContain("<a ");
  });
});
