import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MERMAID_MAX_TEXT_SIZE,
  MERMAID_TEXT_TOO_LONG,
  mermaidConfig,
  readMermaidTheme,
  renderMermaid,
  resetMermaidForTests,
  type MermaidTheme,
} from "./mermaid";

const engine = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async () => ({ diagramType: "flowchart" })),
  render: vi.fn(async (id: string, source: string) => ({ svg: `<svg id="${id}">${source}</svg>` })),
}));
vi.mock("mermaid", () => ({ default: engine }));

const LIGHT: MermaidTheme = { dark: false, fontFamily: "system-ui", width: 680, variables: { primaryColor: "#fafafa" } };
const DARK: MermaidTheme = { ...LIGHT, dark: true, variables: { primaryColor: "#0f0f0f" } };

beforeEach(() => {
  resetMermaidForTests();
  engine.initialize.mockClear();
  engine.parse.mockClear();
  engine.render.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// SPEC_READING_MODE.md, Ч7.
describe("renderMermaid", () => {
  it("draws one diagram at a time, in the order asked", async () => {
    let releaseFirst: () => void = () => undefined;
    engine.render.mockImplementationOnce((id: string) => new Promise((resolve) => {
      releaseFirst = () => resolve({ svg: `<svg id="${id}"/>` });
    }));
    const first = renderMermaid("graph A", LIGHT);
    const second = renderMermaid("graph B", LIGHT);
    await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(engine.render).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await second;
    expect(engine.render.mock.calls.map((call) => call[1])).toEqual(["graph A", "graph B"]);
    expect(new Set(engine.render.mock.calls.map((call) => call[0])).size).toBe(2);
  });

  it("keeps a finished diagram by its text and theme", async () => {
    await renderMermaid("graph A", LIGHT);
    await renderMermaid("graph A", LIGHT);
    expect(engine.render).toHaveBeenCalledTimes(1);
    await renderMermaid("graph A", DARK);
    expect(engine.render).toHaveBeenCalledTimes(2);
  });

  it("sets the page's settings once per theme, not per diagram", async () => {
    await renderMermaid("graph A", LIGHT);
    await renderMermaid("graph B", LIGHT);
    expect(engine.initialize).toHaveBeenCalledTimes(1);
    await renderMermaid("graph C", DARK);
    expect(engine.initialize).toHaveBeenCalledTimes(2);
    expect(engine.initialize).toHaveBeenLastCalledWith(mermaidConfig(DARK));
  });

  it("gives back the reason when the text does not parse, without drawing", async () => {
    engine.parse.mockRejectedValueOnce(new Error("Parse error on line 2"));
    expect(await renderMermaid("graph ((", LIGHT)).toEqual({ kind: "failed", message: "Parse error on line 2" });
    expect(engine.render).not.toHaveBeenCalled();
  });

  it("takes away the temporary node after a failed drawing", async () => {
    engine.render.mockImplementationOnce(async (id: string) => {
      const box = document.createElement("div");
      box.id = `d${id}`;
      document.body.appendChild(box);
      throw new Error("draw failed");
    });
    expect(await renderMermaid("graph X", LIGHT)).toEqual({ kind: "failed", message: "draw failed" });
    expect(document.body.children).toHaveLength(0);
  });

  it("refuses a text longer than Mermaid draws without loading it", async () => {
    const result = await renderMermaid("x".repeat(MERMAID_MAX_TEXT_SIZE + 1), LIGHT);
    expect(result).toEqual({ kind: "failed", message: MERMAID_TEXT_TOO_LONG });
    expect(engine.parse).not.toHaveBeenCalled();
  });
});

describe("mermaidConfig", () => {
  it("draws safely, in the base theme over the tokens, classic and with dagre", () => {
    const config = mermaidConfig(LIGHT);
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      look: "classic",
      layout: "dagre",
      darkMode: false,
      fontFamily: "system-ui",
      themeVariables: { primaryColor: "#fafafa", darkMode: false },
      gantt: { useWidth: 680 },
    });
  });

  it("keeps colour and font out of a diagram's own directives", () => {
    expect(mermaidConfig(LIGHT).secure).toEqual(expect.arrayContaining(
      ["secure", "securityLevel", "theme", "themeVariables", "themeCSS", "darkMode", "fontFamily", "look"],
    ));
  });
});

describe("readMermaidTheme", () => {
  it("turns each token into #rrggbb by a pixel of a canvas", () => {
    const original = HTMLCanvasElement.prototype.getContext;
    const fills: string[] = [];
    // A canvas that reads one fixed pixel back: jsdom draws nothing, and the
    // test needs only the parts the theme reader calls.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      set fillStyle(value: string) { fills.push(value); },
      getImageData: () => ({ data: new Uint8ClampedArray([12, 34, 255, 255]) }),
    })) as unknown as typeof original;
    try {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const theme = readMermaidTheme(host, true);
      expect(theme.dark).toBe(true);
      expect(theme.variables).toMatchObject({
        primaryColor: "#0c22ff",
        mainBkg: "#0c22ff",
        lineColor: "#0c22ff",
        primaryTextColor: "#0c22ff",
        fontSize: "14px",
      });
      expect(host.children).toHaveLength(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});
