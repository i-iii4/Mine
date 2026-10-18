import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderMath, type MathRender } from "@/lib/reading/math";
import { MathView } from "./MathView";

vi.mock("@/lib/reading/math", () => ({ renderMath: vi.fn() }));
vi.mock("@/lib/reading/highlight", () => ({ highlightCode: vi.fn(async () => null) }));
vi.mock("@/lib/appLog", () => ({ logFailure: vi.fn() }));

beforeEach(() => {
  vi.mocked(renderMath).mockReset();
});

// SPEC_READING_MODE.md, Ч9.
describe("MathView", () => {
  it("stands as its source in a line until KaTeX draws it", async () => {
    let resolve: (render: MathRender) => void = () => undefined;
    vi.mocked(renderMath).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { container } = render(<MathView source="a^2" display={false} />);
    expect(container.querySelector("code[data-math-source]")?.textContent).toBe("a^2");
    await act(async () => resolve({ kind: "rendered", html: "<span class=\"katex\">a²</span>" }));
    expect(container.querySelector("[data-math-inline] .katex")).not.toBeNull();
  });

  it("stands as a code block on a line of its own until drawn, then centred", async () => {
    vi.mocked(renderMath).mockResolvedValue({ kind: "rendered", html: "<span class=\"katex-display\"></span>" });
    const { container } = render(<TooltipProvider><MathView source={"\\int x"} display /></TooltipProvider>);
    expect(container.querySelector("[data-code-block] pre")?.textContent).toBe("\\int x");
    await waitFor(() => expect(container.querySelector("[data-math-display]")).not.toBeNull());
    expect(container.querySelector("[data-math-display]")).toHaveClass("text-center", "overflow-x-auto");
    expect(renderMath).toHaveBeenCalledWith("\\int x", { display: true });
  });

  it("shows a formula KaTeX cannot read as its source, the message in title", async () => {
    vi.mocked(renderMath).mockResolvedValue({ kind: "failed", message: "KaTeX parse error: Expected '}'" });
    const inline = render(<MathView source={"\\frac{1}{"} display={false} />);
    await waitFor(() => expect(inline.container.querySelector("code[data-math-source]")).toHaveAttribute("title", "KaTeX parse error: Expected '}'"));
    const block = render(<TooltipProvider><MathView source={"\\frac{1}{"} display /></TooltipProvider>);
    await waitFor(() => expect(block.container.querySelector("[data-code-block]")).toHaveAttribute("title", "KaTeX parse error: Expected '}'"));
  });
});
