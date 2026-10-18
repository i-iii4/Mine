import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Root } from "hast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { highlightCode } from "@/lib/reading/highlight";
import { CodeBlock, COPY_CODE_FAILED_TITLE } from "./CodeBlock";

const writeText = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));
vi.mock("@/lib/reading/highlight", () => ({ highlightCode: vi.fn() }));
const logFailure = vi.hoisted(() => vi.fn());
vi.mock("@/lib/appLog", () => ({ logFailure }));

const HIGHLIGHTED: Root = {
  type: "root",
  children: [{ type: "element", tagName: "span", properties: { className: ["hljs-keyword"] }, children: [{ type: "text", value: "const" }] }, { type: "text", value: " a = 1" }],
};

function renderBlock(code = "const a = 1", language: string | null = "ts") {
  return render(<TooltipProvider><CodeBlock code={code} language={language} /></TooltipProvider>);
}

beforeEach(() => {
  writeText.mockClear();
  logFailure.mockClear();
  vi.mocked(highlightCode).mockReset();
});

// SPEC_READING_MODE.md, Ч6.
describe("CodeBlock", () => {
  it("stands as the same text until the highlighting comes, then shows its classes", async () => {
    let resolve: (tree: Root) => void = () => undefined;
    vi.mocked(highlightCode).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { container } = renderBlock();
    const code = container.querySelector("pre code")!;
    expect(code.textContent).toBe("const a = 1");
    expect(code).not.toHaveAttribute("data-code-highlighted");
    await act(async () => resolve(HIGHLIGHTED));
    expect(code.textContent).toBe("const a = 1");
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(highlightCode).toHaveBeenCalledWith("const a = 1", "ts");
  });

  it("stays plain for an unknown language and for none", async () => {
    vi.mocked(highlightCode).mockResolvedValue(null);
    const { container } = renderBlock("x", "unknown");
    await waitFor(() => expect(highlightCode).toHaveBeenCalled());
    expect(container.querySelector("[data-code-highlighted]")).toBeNull();
    renderBlock("y", null);
    expect(highlightCode).toHaveBeenCalledTimes(1);
  });

  it("logs grammars that could not load and keeps the text", async () => {
    vi.mocked(highlightCode).mockRejectedValue(new Error("chunk failed"));
    const { container } = renderBlock();
    await waitFor(() => expect(logFailure).toHaveBeenCalled());
    expect(container.querySelector("pre")?.textContent).toBe("const a = 1");
  });

  it("copies the code as written and shows Check until the pointer leaves", async () => {
    vi.mocked(highlightCode).mockResolvedValue(null);
    const { container } = renderBlock("line one\nline two", null);
    const button = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("line one\nline two"));
    expect(button.querySelector(".lucide-check")).not.toBeNull();
    fireEvent.pointerLeave(container.querySelector("[data-code-block]")!);
    expect(button.querySelector(".lucide-copy")).not.toBeNull();
  });

  it("logs a copy that failed under its own line", async () => {
    vi.mocked(highlightCode).mockResolvedValue(null);
    writeText.mockRejectedValueOnce(new Error("denied"));
    renderBlock("x", null);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(logFailure).toHaveBeenCalledWith(COPY_CODE_FAILED_TITLE, expect.any(Error)));
  });

  it("is reachable by the keyboard, and Check leaves with the focus", () => {
    vi.mocked(highlightCode).mockResolvedValue(null);
    const { container } = renderBlock("x", null);
    const button = screen.getByRole("button", { name: "Copy" });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(button.querySelector(".lucide-check")).not.toBeNull();
    fireEvent.blur(container.querySelector("[data-code-block]")!, { relatedTarget: document.body });
    expect(button.querySelector(".lucide-copy")).not.toBeNull();
  });
});
