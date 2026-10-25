import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MERMAID_MAX_TEXT_SIZE,
  MERMAID_NOT_SVG,
  MERMAID_TEXT_TOO_LONG,
  mermaidOptions,
  readMermaidLayout,
  renderMermaid,
  resetMermaidForTests,
  safeDiagramSvg,
  withoutDiagramSettings,
  type MermaidLayout,
} from "./mermaid";

const svgOf = vi.hoisted(() => (text: string) => `<svg xmlns="http://www.w3.org/2000/svg">${text}</svg>`);
const engine = vi.hoisted(() => ({
  detectType: vi.fn((_text: string): string | null => "flowchart"),
  load: vi.fn(async (_type: string | null) => true),
  render: vi.fn((source: string, _options: unknown) => ({ svg: svgOf(source) })),
}));
vi.mock("pele/lazy", () => engine);

const LAYOUT: MermaidLayout = { fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 };

beforeEach(() => {
  resetMermaidForTests();
  engine.detectType.mockClear();
  engine.load.mockClear();
  engine.render.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// SPEC_READING_MODE.md, Ч7.
describe("renderMermaid", () => {
  it("draws the diagrams in the order asked", async () => {
    let releaseLoad: () => void = () => undefined;
    engine.load.mockImplementationOnce(() => new Promise((resolve) => {
      releaseLoad = () => resolve(true);
    }));
    const first = renderMermaid("graph A", LAYOUT);
    const second = renderMermaid("graph B", LAYOUT);
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledTimes(1));
    expect(engine.render).not.toHaveBeenCalled();
    releaseLoad();
    expect(await first).toEqual({ kind: "rendered", svg: svgOf("graph A") });
    expect(await second).toEqual({ kind: "rendered", svg: svgOf("graph B") });
    expect(engine.render.mock.calls.map((call) => call[0])).toEqual(["graph A", "graph B"]);
  });

  it("loads the part of the diagram's own type before drawing it", async () => {
    engine.detectType.mockReturnValueOnce("sequence");
    await renderMermaid("sequenceDiagram\n  A->>B: hi", LAYOUT);
    expect(engine.load).toHaveBeenCalledWith("sequence");
  });

  it("draws with the layout's fonts and width, without links or pictures", async () => {
    await renderMermaid("graph A", LAYOUT);
    expect(engine.render).toHaveBeenCalledWith("graph A", mermaidOptions(LAYOUT));
    expect(mermaidOptions(LAYOUT)).toEqual({
      fontFamily: "system-ui",
      fontFamilyMono: "ui-monospace",
      fontSize: 14,
      maxWidth: 680,
      limit: MERMAID_MAX_TEXT_SIZE,
      links: false,
      images: false,
      linkSchemes: [],
      imageSchemes: [],
    });
  });

  it("does not give a width it could not read", () => {
    expect(mermaidOptions({ ...LAYOUT, width: 0 })).not.toHaveProperty("maxWidth");
  });

  it("draws the text without the diagram's own settings", async () => {
    await renderMermaid("%%{init: {'theme': 'dark'}}%%\ngraph A", LAYOUT);
    expect(engine.render.mock.calls[0]?.[0]).toBe("\ngraph A");
    expect(engine.detectType).toHaveBeenCalledWith("\ngraph A");
  });

  it("gives back the reason when the text does not draw", async () => {
    engine.render.mockImplementationOnce(() => {
      throw new Error("Parse error on line 2");
    });
    expect(await renderMermaid("graph ((", LAYOUT)).toEqual({ kind: "failed", message: "Parse error on line 2" });
  });

  it("still draws text whose type cannot be read, and says why it does not", async () => {
    engine.detectType.mockImplementationOnce(() => {
      throw new Error("unreadable");
    });
    engine.render.mockImplementationOnce(() => {
      throw new Error("No diagram type detected for the given text.");
    });
    expect(await renderMermaid("hello", LAYOUT)).toEqual({ kind: "failed", message: "No diagram type detected for the given text." });
    expect(engine.load).toHaveBeenCalledWith(null);
  });

  it("refuses a text longer than Pele draws without loading it", async () => {
    const result = await renderMermaid("x".repeat(MERMAID_MAX_TEXT_SIZE + 1), LAYOUT);
    expect(result).toEqual({ kind: "failed", message: MERMAID_TEXT_TOO_LONG });
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.render).not.toHaveBeenCalled();
  });

  it("rejects when the part of the type could not load, and the next diagram still draws", async () => {
    engine.load.mockRejectedValueOnce(new Error("chunk failed"));
    await expect(renderMermaid("graph A", LAYOUT)).rejects.toThrow("chunk failed");
    expect(await renderMermaid("graph B", LAYOUT)).toEqual({ kind: "rendered", svg: svgOf("graph B") });
  });

  it("fails a drawing that is no SVG", async () => {
    engine.render.mockImplementationOnce(() => ({ svg: "<div>not a drawing</div>" }));
    expect(await renderMermaid("graph A", LAYOUT)).toEqual({ kind: "failed", message: MERMAID_NOT_SVG });
  });

  it("gives back only the drawing of what Pele wrote", async () => {
    engine.render.mockImplementationOnce(() => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><a href="page.html"><rect width="1"/></a></svg>' }));
    expect(await renderMermaid("graph A", LAYOUT)).toEqual({ kind: "rendered", svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>' });
  });
});

describe("safeDiagramSvg", () => {
  const SVG = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

  it("keeps a link's contents and drops the link", () => {
    expect(safeDiagramSvg(`<svg ${SVG}><g><a href="/relative" target="_blank"><rect width="2"/><text>A</text></a></g></svg>`))
      .toBe(`<svg ${SVG}><g><rect width="2"/><text>A</text></g></svg>`);
  });

  it("takes out pictures, scripts, embedded HTML and other elements with what they hold", () => {
    const svg = safeDiagramSvg(`<svg ${SVG}><image href="x.png"/><script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><use xlink:href="#a"/><style>@import url(x.css);</style><rect/></svg>`);
    expect(svg).toBe(`<svg ${SVG}><rect/></svg>`);
  });

  it("takes out attributes that run code or name a resource, on the root too", () => {
    const svg = safeDiagramSvg(`<svg ${SVG} onload="alert(1)"><rect onclick="alert(2)" xlink:href="#x" fill="var(--pele-bg)"/><text src="x">A</text></svg>`);
    expect(svg).toBe(`<svg ${SVG}><rect fill="var(--pele-bg)"/><text>A</text></svg>`);
  });

  it("gives nothing for text that is no SVG", () => {
    expect(safeDiagramSvg("<svg")).toBeNull();
    expect(safeDiagramSvg("<div>x</div>")).toBeNull();
  });
});

describe("withoutDiagramSettings", () => {
  it("takes out the init and initialize directives and keeps the others", () => {
    expect(withoutDiagramSettings("%%{init: {'theme': 'dark'}}%%\ngraph A")).toBe("\ngraph A");
    expect(withoutDiagramSettings("%%{ initialize: { \"fontFamily\": \"x\" } }%%\ngraph A")).toBe("\ngraph A");
    expect(withoutDiagramSettings("%%{wrap}%%\nsequenceDiagram")).toBe("%%{wrap}%%\nsequenceDiagram");
  });

  it("keeps the line numbers of a directive over several lines", () => {
    const source = "%%{init: {\n  'sankey': {'linkColor': '#ff0000'}\n}}%%\nsankey-beta\nA,B,1";
    expect(withoutDiagramSettings(source)).toBe("\n\n\nsankey-beta\nA,B,1");
  });

  it("takes the config key out of front matter and keeps its title and line numbers", () => {
    const source = "---\ntitle: Plan\nconfig:\n  gantt:\n    fontSize: 40\ndisplayMode: compact\n---\ngantt\n  Task :a1, 2026-01-01, 3d";
    expect(withoutDiagramSettings(source)).toBe("---\ntitle: Plan\n\n\n\ndisplayMode: compact\n---\ngantt\n  Task :a1, 2026-01-01, 3d");
  });

  it("takes out a config key written in flow style or quoted", () => {
    expect(withoutDiagramSettings("---\nconfig: {theme: dark}\n---\ngraph A")).toBe("---\n\n---\ngraph A");
    expect(withoutDiagramSettings("---\n\"config\":\n  theme: dark\n---\ngraph A")).toBe("---\n\n\n---\ngraph A");
  });

  it("reads indented front matter as Pele does", () => {
    expect(withoutDiagramSettings("  ---\n  config:\n    theme: dark\n  ---\n  graph A")).toBe("  ---\n\n\n  ---\n  graph A");
  });

  it("leaves a text without settings as it is", () => {
    const source = "flowchart LR\n  A[\"---\"] --> B\n  %% a comment\n  config: not front matter";
    expect(withoutDiagramSettings(source)).toBe(source);
    expect(withoutDiagramSettings("---\nconfig:\n  theme: dark")).toBe("---\nconfig:\n  theme: dark");
  });
});

describe("readMermaidLayout", () => {
  it("reads the block's font, the article's code font and the block's width", () => {
    const host = document.createElement("div");
    host.style.fontFamily = "Inter";
    document.body.appendChild(host);
    Object.defineProperty(host, "clientWidth", { value: 680.4 });
    const layout = readMermaidLayout(host);
    expect(layout).toEqual({ fontFamily: "Inter", fontFamilyMono: "var(--article-code-font)", width: 680 });
    expect(host.children).toHaveLength(0);
  });
});
