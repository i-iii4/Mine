// The real Pele, not a stand-in (SPEC_READING_MODE.md, Ч7): what a note's
// diagram can and cannot bring into the article, drawn as `renderMermaid`
// draws it. The tests hold every new version of Pele to it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render } from "pele";
import { mermaidOptions, safeDiagramSvg, withoutDiagramSettings, type MermaidLayout } from "./mermaid";

const LAYOUT: MermaidLayout = { fontFamily: "system-ui", fontFamilyMono: "ui-monospace", width: 680 };

/** A diagram as `renderMermaid` draws it, without its queue. */
function draw(source: string): string {
  return safeDiagramSvg(render(withoutDiagramSettings(source), mermaidOptions(LAYOUT)).svg) ?? "";
}

/** One diagram of each type whose drawing a setting can reach. */
const DIAGRAMS: Readonly<Record<string, string>> = {
  flowchart: "flowchart LR\n  A[Start] --> B{Check}\n  B --> C[(Store)]",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi",
  class: "classDiagram\n  Animal <|-- Duck\n  Animal : +int age",
  state: "stateDiagram-v2\n  [*] --> Still\n  Still --> Moving",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 10d\n  Crit :crit, 2026-01-05, 3d",
  pie: "pie title Pets\n  \"Dogs\" : 386\n  \"Cats\" : 85",
  gitGraph: "gitGraph\n  commit\n  branch develop\n  commit\n  checkout main\n  merge develop",
  mindmap: "mindmap\n  root((Root))\n    A\n    B",
  timeline: "timeline\n  2002 : LinkedIn\n  2004 : Facebook",
  sankey: "sankey-beta\n\nA,B,10\nB,C,5",
  xychart: "xychart-beta\n  x-axis [a, b]\n  bar [1, 2]\n  line [2, 1]",
  architecture: "architecture-beta\n  service db(database)[Database]\n  service server(server)[Server]\n  db:L -- R:server",
  railroad: "railroad-ebnf-beta\ndigit = \"0\" | \"1\" ;",
  kanban: "kanban\n  Todo\n    [Write]",
  journey: "journey\n  section Work\n    Make tea: 5: Me",
  quadrantChart: "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]",
  treemap: "treemap-beta\n\"Section\"\n    \"Leaf\": 12",
};

/** Every colour and font a Mermaid setting can name, at the top and for
 *  every type: none of it may reach a drawing. */
const MARK_COLOR = "#ab1234";
const MARK_FONT = "ZzMarkFont";
const PER_TYPE = {
  fontFamily: MARK_FONT, fontSize: 41, sectionFontSize: 41, actorFontFamily: MARK_FONT, messageFontSize: 41,
  linkColor: MARK_COLOR, fill: MARK_COLOR, stroke: MARK_COLOR, textColor: MARK_COLOR, lineColor: MARK_COLOR,
  actorColours: [MARK_COLOR], sectionFills: [MARK_COLOR], useMaxWidth: false,
};
const SETTINGS = {
  theme: "dark", darkMode: true, look: "handDrawn", securityLevel: "loose", fontFamily: MARK_FONT, fontSize: 41,
  themeCSS: `.node rect { fill: ${MARK_COLOR}; }`,
  themeVariables: { primaryColor: MARK_COLOR, lineColor: MARK_COLOR, fontFamily: MARK_FONT, pie1: MARK_COLOR },
  ...Object.fromEntries(Object.keys(DIAGRAMS).map((type) => [type, PER_TYPE])),
};

/** What must never be in the SVG of a note's diagram: scripts, handlers,
 *  embedded HTML, links out and anything that would ask the network. */
const FORBIDDEN = [/<script/i, /\son[a-z]+\s*=/i, /<foreignObject/i, /<iframe/i, /<image/i, /<a[\s>]/i, /href\s*=/i, /url\(/i, /@import/i, /javascript:/i];

describe("a diagram's own settings", () => {
  it.each(Object.entries(DIAGRAMS))("change nothing in a %s, by directive or by front matter", (_type, body) => {
    const plain = draw(body);
    expect(draw(`%%{init: ${JSON.stringify(SETTINGS)}}%%\n${body}`)).toBe(plain);
    expect(draw(`---\nconfig: ${JSON.stringify(SETTINGS)}\n---\n${body}`)).toBe(plain);
  });

  it("keep the title of front matter", () => {
    expect(draw("---\ntitle: Plan of work\nconfig:\n  theme: dark\n---\npie\n  \"A\" : 1")).toContain("Plan of work");
  });
});

describe("the SVG of a note's diagram", () => {
  const hostile: Readonly<Record<string, string>> = {
    "HTML in a label": "flowchart LR\n  A[\"<img src=x onerror=alert(1)><script>alert(2)</script><b>bold</b>\"] --> B",
    "a markdown label": "flowchart LR\n  A[\"`**bold** <iframe src=https://example.com>`\"] --> B",
    "clicks and links": "flowchart LR\n  A --> B\n  click A \"javascript:alert(1)\"\n  click B \"https://example.com\" _blank\n  click A callback",
    "a link in a sequence": "sequenceDiagram\n  participant A\n  link A: Home @ https://example.com\n  A->>A: hi",
    "a link in C4": "C4Context\n  Person(a, \"A\", $link=\"https://example.com\")\n  System(b, \"B\")\n  Rel(a, b, \"uses\")",
    "a picture in a node": "flowchart LR\n  A@{ img: \"https://example.com/x.png\", label: \"pic\" } --> B",
    "a relative link and picture": "flowchart LR\n  A@{ img: \"x.png\", label: \"pic\" } --> B\n  click B \"page.html\"\n  click A href \"#frag\"",
    "a relative link in C4": "C4Context\n  Person(a, \"A\", $link=\"/relative\")\n  System(b, \"B\", $link=\"//host/share\")\n  Rel(a, b, \"uses\")",
    "an icon of a set": "architecture-beta\n  service s(logos:aws)[S]\n  service t(fa:fa-car)[T]\n  s:R -- L:t",
    "styles with resources": "flowchart LR\n  A --> B\n  classDef c fill:#0f0,color:red\n  class B c\n  style A fill:#f00,stroke:#00f",
    "a loose directive": "%%{init: {'securityLevel': 'loose', 'htmlLabels': true}}%%\nflowchart LR\n  A[\"<b onclick=alert(1)>x</b>\"] --> B",
  };

  it.each(Object.entries(hostile))("holds no script, handler, link or outside resource for %s", (_case, source) => {
    const svg = draw(source);
    for (const pattern of FORBIDDEN) expect(svg).not.toMatch(pattern);
  });

  it.each(Object.entries(hostile))("comes from Pele without a link or picture for %s, before Mine's guard", (_case, source) => {
    const svg = render(withoutDiagramSettings(source), mermaidOptions(LAYOUT)).svg;
    for (const pattern of [/<a[\s>]/i, /<image/i, /href\s*=/i]) expect(svg).not.toMatch(pattern);
  });

  it("fails a style that names a resource instead of drawing it", () => {
    expect(() => draw("flowchart LR\n  A --> B\n  style A fill:url(https://example.com/x)")).toThrow();
  });

  it("takes every colour from a variable the article sets (Ч7, закон цвета)", () => {
    const css = readFileSync("src/styles/article.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = new Set([...css.matchAll(/(--pele-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    // Not colours: the text font is the one Pele measured with, the rest are
    // shapes and weights of Pele's own style.
    const notColours = new Set(["--pele-font", "--pele-radius", "--pele-title-weight", "--pele-heading-weight", "--pele-bold-weight"]);
    for (const body of Object.values(DIAGRAMS)) {
      for (const [, name] of draw(body).matchAll(/var\((--pele-[a-z0-9-]+)/g)) {
        if (name && !notColours.has(name)) expect(declared, name).toContain(name);
      }
    }
  });
});
