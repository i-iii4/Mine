import { describe, expect, it } from "vitest";
import { deriveCardContent } from "./cardLayout";
import { lightBlock } from "@/test/blocks";

/// The preview of a body without an indexed one is worked out from a start
/// of the body, and is for every body the one the whole body gave (user's
/// decision of 15.11.2026): the expression below, as cardLayout.ts had it.

function referenceStripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function referenceStripFirstMarkdownH1(body: string): string {
  const out: string[] = [];
  let inFence = false;
  let stripped = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && !stripped && trimmed.startsWith("# ")) {
      stripped = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trimStart();
}

const reference = (body: string) => referenceStripMarkdown(referenceStripFirstMarkdownH1(body)).slice(0, 400).trim();

/// What the card shows for `body` with no indexed preview.
const preview = (body: string) => deriveCardContent(lightBlock({ body, preview_text: null })).text.text;

const prose = (count: number, word = "слово") => Array.from({ length: count }, (_, index) => `${word}${index}`).join(" ");

describe("the preview of a body without an indexed one", () => {
  const samples: [string, string][] = [
    ["an empty body", ""],
    ["a body of spaces", "   \n\n  \n"],
    ["a body shorter than the preview", "Короткий текст."],
    ["a first heading", "# Заголовок\n\nТекст под ним."],
    ["only a first heading", "# Заголовок"],
    ["headings", `# Первый\n\n## Второй\n\n${prose(300)}\n\n### Третий\n\n${prose(300)}`],
    ["lists and quotes", `${Array.from({ length: 200 }, (_, index) => `- пункт ${index}\n* звезда ${index}\n> цитата ${index}`).join("\n")}`],
    ["code blocks", `# Код\n\n\`\`\`\n# не заголовок\nconst a = 1;\n\`\`\`\n\n${prose(400)}\n\n\`\`\`js\n${"x();\n".repeat(400)}\`\`\`\n\n${prose(400)}`],
    ["a heading inside a fence first", `\`\`\`\n# внутри\n\`\`\`\n# Настоящий\n\n${prose(500)}`],
    ["tables", `| a | b |\n|---|---|\n${Array.from({ length: 300 }, (_, index) => `| ${index} | ячейка ${index} |`).join("\n")}`],
    ["links and wikilinks", Array.from({ length: 300 }, (_, index) => `Слово [ссылка ${index}](https://example.com/${index}) и [[Заметка ${index}]] и [[Цель|Имя ${index}]] и ![[Картинка ${index}.png]] и ![alt](a${index}.png).`).join("\n")],
    ["inline markup", Array.from({ length: 300 }, (_, index) => `**жирное ${index}** и *курсив* и \`код ${index}\` и ==маркер==.`).join("\n\n")],
    ["a long line without breaks", prose(5000)],
    ["long lines with breaks far apart", `${prose(3000)}\n${prose(3000)}\nКонец`],
    ["a rule and blank lines", `${prose(200)}\n\n---\n\n\n\n${prose(200)}\n---\n${prose(500)}`],
    ["an open backtick closed far on", `Начало \`открыт\n${prose(2000, "a")}\nи закрыт\` здесь\n${prose(500)}`],
    ["an open backtick never closed", `Начало \`открыт\n${prose(3000, "b")}\n${prose(500)}`],
    ["an open link bracket far from its close", `Текст ![картинка\n${prose(2000, "c")}\n](адрес\n${prose(1000)}\n) хвост\n${prose(500)}`],
    ["an open wikilink far from its close", `Текст [[цель\n${prose(2000, "d")}\n|имя]]\n${prose(500)}`],
    ["markers at the start of lines across the cut", `${Array.from({ length: 400 }, (_, index) => (index % 3 === 0 ? "#\n" : index % 3 === 1 ? "-\n" : `${prose(20)}\n`)).join("")}`],
    ["CRLF line ends", `# Заголовок\r\n\r\n${prose(800).replace(/ /g, "\r\n")}`],
  ];

  it.each(samples)("is the whole body's for %s", (_name, body) => {
    expect(preview(body)).toBe(reference(body));
  });

  it("is the whole body's for bodies made at random of every kind of markup", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const parts = ["слово", "word", " ", "  ", "\n", "\n\n", "\n\n\n", "# ", "## ", "#", "- ", "* ", "+ ", "> ", "---", "```", "~~~", "`", "**", "*", "[", "]", "(", ")", "![", "![[", "[[", "]]", "|", "1. ", "\t", "Заголовок", "x"];
    for (let round = 0; round < 300; round += 1) {
      const length = Math.floor(next() * 6000);
      const pieces: string[] = [];
      let size = 0;
      while (size < length) {
        const piece = parts[Math.floor(next() * parts.length)]!;
        pieces.push(piece);
        size += piece.length;
      }
      const body = pieces.join("");
      expect(preview(body), `round ${round}`).toBe(reference(body));
    }
  });
});
