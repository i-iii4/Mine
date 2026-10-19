// The notes of the editor's performance check (SPEC_EDITING.md, Л14.2), the
// bodies of `/__editing?body=<name>`: prose of 1 MB and 10 MB, 10 000
// headings with their links, 10 000 list items and tasks with nesting,
// 1 000 pictures, 100 Mermaid diagrams, 200 tables of 20 rows. The long table
// of 5 000 rows and the table of 30 columns are the table cases
// (`editingTables.ts`), the reading mode's fixture is the page's own note.
// Generated the same way every time, so a check carries no megabytes of
// fixtures and two runs edit the same text. Dev only.

/** The paragraph a check types into near the top of every set. */
export const PERF_TYPING_MARK = "Абзац для набора в начале заметки.";
/** The paragraph a check types into in the middle of a set. */
export const PERF_MIDDLE_MARK = "Абзац для набора в середине заметки.";

/** The sets by name, with the size or count each one is made to. */
export const PERF_SETS = {
  "prose-1mb": { kind: "prose", bytes: 1024 * 1024 },
  "prose-10mb": { kind: "prose", bytes: 10 * 1024 * 1024 },
  "headings-10k": { kind: "headings", count: 10_000 },
  "tasks-10k": { kind: "tasks", count: 10_000 },
  "images-1000": { kind: "images", count: 1_000 },
  "mermaid-100": { kind: "mermaid", count: 100 },
  "tables-200": { kind: "tables", count: 200 },
} as const;

export type PerfSetName = keyof typeof PERF_SETS;

/** Rows of every table of `tables-200`. */
const TABLE_ROWS = 20;
/** Items of one list of `tasks-10k`: the lists stand under headings, as a
 *  long note of tasks does. */
const LIST_ITEMS = 1_000;
/** A heading every so many paragraphs of prose. */
const PROSE_SECTION_PARAGRAPHS = 40;

const WORDS = [
  "заметка", "карточка", "файл", "строка", "текст", "абзац", "пространство", "коллекция", "ссылка", "редактор",
  "проверка", "правка", "таблица", "картинка", "список", "задача", "время", "место", "версия", "запись",
  "note", "editor", "markdown", "frame", "parse", "window", "widget", "layout", "source", "change",
  "длинное", "короткое", "новое", "старое", "своё", "общее", "живое", "тихое", "быстрое", "точное",
];

/** A small generator of the same numbers for the same seed (mulberry32). */
function numbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function sentence(next: () => number): string {
  const count = 6 + Math.floor(next() * 12);
  const words = Array.from({ length: count }, () => pick(next, WORDS));
  const first = words[0] ?? "";
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(" ")}.`;
}

/** A paragraph of prose; one in three carries inline markup of every kind
 *  the editor conceals. */
function paragraph(next: () => number, index: number): string {
  const sentences = Array.from({ length: 4 + Math.floor(next() * 5) }, () => sentence(next));
  if (index % 3 === 0) {
    sentences.push(`Здесь **жирное**, *курсив*, \`код\`, ==маркер==, [ссылка ${index}](https://example.com/${index}) и [[Пример заметки]].`);
  }
  return sentences.join(" ");
}

const encoder = new TextEncoder();

function prose(bytes: number): string {
  const next = numbers(1);
  const parts = [`# Проза\n\n${PERF_TYPING_MARK}\n\n`];
  let size = encoder.encode(parts[0]).length;
  let index = 0;
  let middle = false;
  while (size < bytes) {
    let part: string;
    if (!middle && size >= bytes / 2) {
      part = `${PERF_MIDDLE_MARK}\n\n`;
      middle = true;
    } else if (index % PROSE_SECTION_PARAGRAPHS === 0) {
      part = `## Раздел ${index / PROSE_SECTION_PARAGRAPHS + 1}\n\n`;
    } else {
      part = `${paragraph(next, index)}\n\n`;
    }
    index += 1;
    parts.push(part);
    size += encoder.encode(part).length;
  }
  return parts.join("");
}

function headings(count: number): string {
  const parts = [`# Заголовки\n\n${PERF_TYPING_MARK}\n\n`];
  for (let index = 1; index <= count; index += 1) {
    if (index === Math.floor(count / 2)) parts.push(`${PERF_MIDDLE_MARK}\n\n`);
    const level = index % 10 === 1 ? "##" : "###";
    parts.push(`${level} Заголовок ${index}\n\nСсылка на [[Заметка ${index}]] и [адрес ${index}](https://example.com/${index}).\n\n`);
  }
  return parts.join("");
}

function tasks(count: number): string {
  const next = numbers(2);
  const parts = [`# Задачи\n\n${PERF_TYPING_MARK}\n\n`];
  for (let index = 0; index < count; index += 1) {
    const local = index % LIST_ITEMS;
    if (local === 0) {
      // A blank line ends the list before: a paragraph would join its last
      // item.
      if (index > 0) parts.push("\n");
      if (index === count / 2) parts.push(`${PERF_MIDDLE_MARK}\n\n`);
      parts.push(`## Список ${index / LIST_ITEMS + 1}\n\n`);
    }
    // Two levels of nesting in every seven items of a list.
    const depth = local % 7 === 3 ? 1 : local % 7 === 4 ? 2 : 0;
    const marker = index % 3 === 0 ? "- [ ] " : index % 3 === 1 ? "- [x] " : "- ";
    // One item in five is long enough to wrap.
    const text = index % 5 === 0 ? `Пункт ${index + 1}: ${sentence(next)} ${sentence(next)} ${sentence(next)}` : `Пункт ${index + 1}`;
    parts.push(`${"  ".repeat(depth)}${marker}${text}\n`);
  }
  return parts.join("");
}

/** The picture of `images-1000` number `index`: an even one has its file,
 *  an odd one has none (the check's server answers 404 for it). */
export function perfImageName(index: number): string {
  return `Картинка ${index}.png`;
}

function images(count: number): string {
  const parts = [`# Картинки\n\n${PERF_TYPING_MARK}\n\n`];
  for (let index = 1; index <= count; index += 1) {
    if (index === count / 2) parts.push(`${PERF_MIDDLE_MARK}\n\n`);
    parts.push(`Абзац перед картинкой ${index}.\n\n![[${perfImageName(index)}]]\n\n`);
  }
  return parts.join("");
}

function mermaid(count: number): string {
  const parts = [`# Диаграммы\n\n${PERF_TYPING_MARK}\n\n`];
  for (let index = 1; index <= count; index += 1) {
    if (index === count / 2) parts.push(`${PERF_MIDDLE_MARK}\n\n`);
    parts.push(
      `Диаграмма ${index}:\n\n\`\`\`mermaid\nflowchart LR\n  A${index}[Начало ${index}] --> B${index}{Проверка}\n`
      + `  B${index} -- да --> C${index}[Готово]\n  B${index} -- нет --> A${index}\n\`\`\`\n\n`,
    );
  }
  return parts.join("");
}

function tables(count: number): string {
  const parts = [`# Таблицы\n\n${PERF_TYPING_MARK}\n\n`];
  for (let index = 1; index <= count; index += 1) {
    if (index === count / 2) parts.push(`${PERF_MIDDLE_MARK}\n\n`);
    const rows = Array.from({ length: TABLE_ROWS }, (_, row) => `| ${row + 1} | Строка ${row + 1} | ${(index * 100 + row) / 10} | примечание ${index}.${row + 1} |`);
    parts.push(`### Таблица ${index}\n\n| № | Название | Значение | Примечание |\n|---|---|---|---|\n${rows.join("\n")}\n\n`);
  }
  return parts.join("");
}

/** Prose of any whole number of megabytes, `prose-<n>mb`: the size from
 *  which typing no longer holds its limit is found among them (Л14.4). */
const PROSE_SIZE = /^prose-(\d{1,2})mb$/;

/** The body of the set `name`, or `null` for another variant. */
export function perfSetBody(name: string | null): string | null {
  if (name === null) return null;
  if (!(name in PERF_SETS)) {
    const megabytes = PROSE_SIZE.exec(name)?.[1];
    return megabytes === undefined ? null : prose(Number(megabytes) * 1024 * 1024);
  }
  // `name` is a key of the sets: checked just above.
  const set = PERF_SETS[name as PerfSetName];
  switch (set.kind) {
    case "prose":
      return prose(set.bytes);
    case "headings":
      return headings(set.count);
    case "tasks":
      return tasks(set.count);
    case "images":
      return images(set.count);
    case "mermaid":
      return mermaid(set.count);
    case "tables":
      return tables(set.count);
  }
}
