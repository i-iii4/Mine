import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderMermaid, type MermaidRender } from "@/lib/reading/mermaid";
import { MERMAID_FAILED_LINE, MermaidDiagram } from "./MermaidDiagram";

vi.mock("@/lib/reading/mermaid", () => ({
  readMermaidTheme: vi.fn((_host: HTMLElement, dark: boolean) => ({ dark, fontFamily: "system-ui", width: 680, variables: {} })),
  renderMermaid: vi.fn(),
}));
vi.mock("@/lib/appLog", () => ({ logFailure: vi.fn() }));
vi.mock("@/lib/reading/highlight", () => ({ highlightCode: vi.fn(async () => null) }));

function renderDiagram(source = "graph TD\n  A --> B") {
  return render(<TooltipProvider><MermaidDiagram source={source} /></TooltipProvider>);
}

beforeEach(() => {
  vi.mocked(renderMermaid).mockReset();
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

// SPEC_READING_MODE.md, Ч7.
describe("MermaidDiagram", () => {
  it("shows its source as code until the diagram comes, then the SVG", async () => {
    let resolve: (render: MermaidRender) => void = () => undefined;
    vi.mocked(renderMermaid).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { container } = renderDiagram();
    expect(container.querySelector("[data-code-block] pre")?.textContent).toBe("graph TD\n  A --> B");
    await act(async () => resolve({ kind: "rendered", svg: "<svg data-test-svg></svg>" }));
    expect(container.querySelector("[data-mermaid-diagram] svg")).not.toBeNull();
    expect(container.querySelector("[data-code-block]")).toBeNull();
  });

  it("stays code under a quiet line when Mermaid cannot draw it", async () => {
    vi.mocked(renderMermaid).mockResolvedValue({ kind: "failed", message: "Parse error on line 2" });
    const { container } = renderDiagram("graph ((");
    await waitFor(() => expect(container.querySelector("[data-mermaid-failed]")).not.toBeNull());
    expect(container.querySelector("[data-mermaid-failed]")).toHaveTextContent(MERMAID_FAILED_LINE);
    expect(container.querySelector("[data-mermaid-failed]")).toHaveClass("text-sm", "text-muted-foreground");
    expect(container.querySelector("[data-code-block]")).toHaveAttribute("title", "Parse error on line 2");
  });

  it("stays code when Mermaid could not be loaded", async () => {
    vi.mocked(renderMermaid).mockRejectedValue(new Error("chunk failed"));
    const { container } = renderDiagram();
    await waitFor(() => expect(container.querySelector("[data-mermaid-failed]")).not.toBeNull());
    expect(container.querySelector("[data-code-block]")).not.toBeNull();
  });

  it("draws again in a new theme and keeps the last drawing until then", async () => {
    vi.mocked(renderMermaid).mockResolvedValueOnce({ kind: "rendered", svg: "<svg data-light></svg>" });
    const { container } = renderDiagram();
    await waitFor(() => expect(container.querySelector("svg[data-light]")).not.toBeNull());
    let resolve: (render: MermaidRender) => void = () => undefined;
    vi.mocked(renderMermaid).mockReturnValue(new Promise((done) => { resolve = done; }));
    await act(async () => document.documentElement.setAttribute("data-theme", "dark"));
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2));
    expect(vi.mocked(renderMermaid).mock.calls[1]?.[1]).toMatchObject({ dark: true });
    expect(container.querySelector("svg[data-light]")).not.toBeNull();
    await act(async () => resolve({ kind: "rendered", svg: "<svg data-dark></svg>" }));
    expect(container.querySelector("svg[data-dark]")).not.toBeNull();
  });
});
