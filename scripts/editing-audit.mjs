// The note's editor in headless Chromium (SPEC_EDITING.md, Л17): the open card
// in the editor on the dev page `/__editing` (`src/dev/EditingPage.tsx`, its
// made-up backend checking every write against its base), with the reading
// mode's fixture `scripts/fixtures/reading-mode.md`, its variants and the
// table cases, in the light and the dark theme, at 1600 × 800 and 900 × 800.
// Real layout, fonts, lazy parts and events, which the jsdom tests cannot
// see:
//
// - the field's name and role, Escape and Tab out of it, the task boxes'
//   names, the table and its active cell, the `Table` menu by its keys (Л16);
// - nothing written on opening, an edit in every kind of block writes its own
//   bytes only, and its undo gives the file back byte for byte, in the note
//   with `\n`, `\r\n`, mixed line endings, a byte order mark and no final
//   line break (Л3.4, Л17);
// - Live Preview reveals one element under the caret, a block by a click and
//   by the arrows (Л5);
// - lists and tasks (Л7); block widgets as tall and wide as the reading
//   mode's elements (Л8); the table editor (Л9); a change of the file applied
//   by itself, and kept apart from unsaved edits (Л4); the `[[` menu (Л10);
//   the open card's selection bar and jumps (Л11); a composition through CDP
//   writes nothing until it ends (Л13.1);
// - the page never scrolls sideways, and nothing is asked of the network.
//
// What waits for the user's decisions is reported as PENDING with the
// decision's name, never passed. Starts and stops its own Vite.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { COLD_START_MS, startAuditVite } from './audit-vite.mjs';

const PAGE = '/__editing';
const THEMES = ['light', 'dark'];
const WIDE = { width: 1600, height: 800 };
const NARROW = { width: 900, height: 800 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const FILE_NAME = 'Проверка просмотрщика.md';
/** What the checks type: one sign, not on any keyboard of the fixture. */
const MARK = '✎';

const fixture = readFileSync(new URL('./fixtures/reading-mode.md', import.meta.url), 'utf8');
const fixtureBody = fixture.replace(/^---\n[\s\S]*?\n---\n/, '');

/** The bodies of `?body=` the byte checks open, as the page makes them. */
const VARIANTS = {
  lf: fixtureBody,
  crlf: fixtureBody.replace(/\n/g, '\r\n'),
  mixed: fixtureBody.split('\n').map((line, index) => (index % 2 === 0 ? `${line}\r` : line)).join('\n'),
  bom: `﻿${fixtureBody}`,
  'no-final-newline': fixtureBody.replace(/\n+$/, ''),
};

/** Where an edit goes in each kind of block: a text right before the place,
 *  and the widget to press first when the block is drawn as one. */
const EDITS = [
  { kind: 'paragraph', after: 'Короткий абзац с ' },
  { kind: 'heading', after: '## Заголовок второго ' },
  { kind: 'list item', after: '- Пункт маркированного ' },
  { kind: 'task', after: '- [ ] Невыполненная ' },
  { kind: 'code', after: 'interface Card', widget: "[data-editor-block='code']", widgetText: 'interface Card' },
  { kind: 'callout', after: 'Выноска Obsidian типа ', widget: "[data-editor-block='callout']", widgetText: 'Выноска Obsidian типа note' },
  { kind: 'formula', after: '\\int_0^1 ', widget: "[data-editor-block='math']", widgetText: '' },
];

/** Waiting for the user's decisions: named, never passed. */
const PENDING = [
  ['entering and leaving editing, the first visible line kept (Л1)', 'ЛВ1, row 50.12'],
  ['how a conflict is shown and decided (Л4.3)', 'ЛВ2 (а), row 50.16'],
  ['what the person is offered for a note deleted during the session (Л4.9)', 'ЛВ2 (б), row 50.16'],
  ['`New note` in the `[[` menu and a click on a link to a missing note (Л10)', 'ЛВ4, row 50.22'],
  ['⌘K from a cell to the open card\'s menu, ⌘L, ⌘[ ⌘] in the editor (Л12, Л16)', 'ЛВ5, row 50.24'],
  ['Undo, Redo and Select All of the Edit menu (Л12)', 'row 50.24'],
  ['Enter in a cell (Л9.6)', 'ЛВ6'],
  ['the handles and the add strips of a table, their names, the row and column drag (Л9.8, Л16)', 'ЛВ7 (а), (б), (е), (ж)'],
  ['how the active cell, a range, a chosen block look (Л15)', 'ЛВ7 (в), (г), (д), row 50.26'],
  ['pictures, files and formatted text pasted or dropped (Л13.3, Л13.5)', 'ЛВ3, row 50.25'],
  ['spelling and the substitutions of macOS (Л13.2)', 'ЛВ8, row 50.25'],
  ['input methods, dead keys, the menu\'s Undo in WKWebView (Л13)', 'row 50.25, the user\'s live acceptance 50.31'],
];

const results = [];
function check(label, name, ok, detail = '') {
  results.push({ label, name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${name}${ok || !detail ? '' : ` (${detail})`}`);
}

const vite = await startAuditVite();
let browser;

// ─── Page helpers ───────────────────────────────────────────────────────────

async function open(theme, size, query = '') {
  const page = await browser.newPage({ viewport: size });
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${vite.origin}${PAGE}?theme=${theme}${query}`, { waitUntil: 'domcontentloaded', timeout: COLD_START_MS });
  await page.waitForSelector('.mine-note-editor .cm-content', { timeout: COLD_START_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return { page, errors, requests };
}

const body = (page) => page.evaluate(() => window.__editing.body());
const docText = (page) => page.evaluate(() => window.__editing.editor.text());
const writes = (page) => page.evaluate(() => window.__editing.record.writes.length);
const allAccepted = (page) => page.evaluate(() => window.__editing.record.writes.every((write) => write.accepted));

/** Wait until the made-up file holds `expected`, or a while. */
async function bodyBecomes(page, expected, timeout = 4000) {
  try {
    await page.waitForFunction((text) => window.__editing.body() === text, expected, { timeout, polling: 50 });
    return true;
  } catch {
    return false;
  }
}

/** The caret right after `fragment` of the document, as a press there puts
 *  it (the editor scrolls to it). Positions count a line break as one, as
 *  CodeMirror does, whatever the note's line endings. */
async function caretAfter(page, fragment) {
  const at = await page.evaluate((text) => window.__editing.editor.after(text), fragment);
  if (at === null) throw new Error(`the note has no “${fragment}”`);
  await page.evaluate((pos) => window.__editing.editor.select(pos), at);
  await page.waitForTimeout(80);
  return at;
}

/** The point of the sign at `offset` of the first text of the editor's own
 *  lines holding `fragment`, scrolled into view. */
async function pointOf(page, fragment, offset = 0) {
  return page.evaluate(([text, at]) => {
    const content = document.querySelector('.mine-note-editor .cm-content');
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('[data-editor-block], .cm-md-inline-math')) continue;
      const index = node.textContent.indexOf(text);
      if (index < 0) continue;
      node.parentElement.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, index + at);
      range.setEnd(node, index + at + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + Math.min(2, rect.width / 2), y: rect.top + rect.height / 2 };
    }
    return null;
  }, [fragment, offset]);
}

/** The text of the editor's line that holds `fragment`, as drawn. */
async function lineText(page, fragment) {
  return page.evaluate((text) => {
    const line = [...document.querySelectorAll('.mine-note-editor .cm-content > .cm-line, .mine-note-editor .cm-content .cm-line')]
      .find((candidate) => candidate.textContent.includes(text));
    return line?.textContent ?? null;
  }, fragment);
}

/** Press a drawn block's widget whose text holds `text` (the first one when
 *  `text` is empty). */
async function pressWidget(page, selector, text) {
  const point = await page.evaluate(async ([css, words]) => {
    const scroller = document.querySelector('[data-detail-scroll]');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    // The editor draws only what is near the view: walk the note to it.
    for (let top = 0; top <= scroller.scrollHeight; top += scroller.clientHeight / 2) {
      const widget = [...document.querySelectorAll(`.mine-note-editor ${css}`)].find((candidate) => !words || candidate.textContent.includes(words));
      if (widget) {
        widget.scrollIntoView({ block: 'center' });
        await frame();
        await frame();
        const target = widget.querySelector('pre, [data-callout-body], .katex-display, p') ?? widget;
        const rect = target.getBoundingClientRect();
        return { x: rect.left + Math.min(40, rect.width / 3), y: rect.top + Math.min(12, rect.height / 2) };
      }
      scroller.scrollTop = top;
      await frame();
      await frame();
    }
    return null;
  }, [selector, text]);
  if (!point) throw new Error(`no widget ${selector} with “${text}”`);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(150);
}

/** Where `after` and `before` differ: the common start and end left out. */
function changed(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { start, removed: before.slice(start, before.length - end), inserted: after.slice(start, after.length - end) };
}

// ─── The checks ─────────────────────────────────────────────────────────────

/** Л16: the field, Escape and Tab, the task boxes. */
async function accessibility(label, page) {
  const field = await page.evaluate(() => {
    const content = document.querySelector('.mine-note-editor .cm-content');
    return { role: content.getAttribute('role'), multiline: content.getAttribute('aria-multiline'), label: content.getAttribute('aria-label') };
  });
  check(label, 'the editor is a multiline text box named by its file (Л16)', field.role === 'textbox' && field.multiline === 'true' && field.label === `Text of ${FILE_NAME}`, JSON.stringify(field));
  const aria = await page.locator('.mine-note-editor .cm-content').ariaSnapshot();
  check(label, 'the accessibility tree names the text box', aria.includes(`textbox "Text of ${FILE_NAME}"`), aria.slice(0, 120));

  // Escape with nothing to close, then Tab: the focus leaves the text
  // forward; Escape and ⇧Tab: backward (CodeMirror's rule).
  for (const [keys, forward] of [[['Escape', 'Tab'], true], [['Escape', 'Shift+Tab'], false]]) {
    await caretAfter(page, 'Короткий абзац');
    for (const key of keys) await page.keyboard.press(key);
    const where = await page.evaluate(() => {
      const content = document.querySelector('.mine-note-editor .cm-content');
      const active = document.activeElement;
      if (!active || active === content) return 'text';
      const position = content.compareDocumentPosition(active);
      // A control inside a widget of the note follows the text box in the
      // order of the page.
      if (position & Node.DOCUMENT_POSITION_CONTAINED_BY || position & Node.DOCUMENT_POSITION_FOLLOWING) return 'after';
      return 'before';
    });
    const text = await docText(page);
    check(label, `Escape then ${forward ? 'Tab' : '⇧Tab'} moves the focus ${forward ? 'on' : 'back'} and types nothing (Л16)`, where === (forward ? 'after' : 'before') && !text.includes('\t'), where);
  }
  // Tab without Escape belongs to the text (Л12); the two seconds after an
  // Escape in which Tab moves the focus are over first.
  await page.waitForTimeout(2100);
  await caretAfter(page, 'Короткий абзац');
  const before = await body(page);
  await page.keyboard.press('Tab');
  const tabbed = changed(before, await (async () => { await page.waitForTimeout(200); return body(page); })());
  check(label, 'Tab in the text types a tab (Л12)', tabbed.inserted === '\t' && tabbed.removed === '', JSON.stringify(tabbed));
  await page.evaluate(() => window.__editing.editor.undo());
  await bodyBecomes(page, before);

  // A task's box is named by its text (Ч12.7).
  const box = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.mine-note-editor .cm-md-inline-task [role="checkbox"]')];
    const named = boxes.map((element) => document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() ?? null);
    return { count: boxes.length, named };
  });
  check(label, 'every task box in view is named by its task\'s text (Л16, Ч12.7)', box.count > 0 && box.named.includes('Невыполненная задача') && box.named.every((name) => name && name.length > 0), JSON.stringify(box));
}

/** Л3.4, Л17: nothing written on opening; an edit in every kind of block
 *  writes its own bytes and its undo gives the file back. */
async function byteExact(label, theme, variant) {
  const { page, errors } = await open(theme, WIDE, variant === 'lf' ? '' : `&body=${variant}`);
  const original = VARIANTS[variant];
  await page.waitForTimeout(400);
  check(label, `${variant}: the note is the file, nothing written on opening`, (await writes(page)) === 0 && (await body(page)) === original && (await docText(page)) === original.replace(/^﻿/, ''));
  for (const edit of EDITS) {
    if (edit.widget) await pressWidget(page, edit.widget, edit.widgetText);
    await caretAfter(page, edit.after);
    await page.keyboard.type(MARK);
    const index = original.indexOf(edit.after);
    const expected = `${original.slice(0, index + edit.after.length)}${MARK}${original.slice(index + edit.after.length)}`;
    const wrote = await bodyBecomes(page, expected);
    const diff = changed(original, await body(page));
    check(label, `${variant}: an edit in a ${edit.kind} writes its own bytes only`, wrote, JSON.stringify(diff).slice(0, 160));
    await page.evaluate(() => window.__editing.editor.undo());
    check(label, `${variant}: its undo gives the file back byte for byte`, await bodyBecomes(page, original), JSON.stringify(changed(original, await body(page))).slice(0, 160));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  check(label, `${variant}: every write went over its base, no page errors`, (await allAccepted(page)) && errors.length === 0, errors.join(' | '));
  await page.close();
}

/** ⌘Z of the page itself reaches the editor's history in Chromium; the
 *  menu's Undo of the app waits for row 50.24. */
async function keyboardUndo(label, page) {
  const before = await body(page);
  await caretAfter(page, 'Короткий абзац с ');
  await page.keyboard.type(MARK);
  await page.waitForTimeout(200);
  await page.keyboard.press(`${MOD}+z`);
  check(label, '⌘Z in the page undoes the edit through the editor\'s history', await bodyBecomes(page, before));
}

/** Л5: one element under the caret shows its marks; a block by a click and by
 *  the arrows. */
async function livePreview(label, page) {
  const rest = await lineText(page, 'Короткий абзац с');
  check(label, 'at rest the marks of a line are hidden (Л5.1)', rest && !rest.includes('**') && !rest.includes('](https://') && !rest.includes('`'), rest?.slice(0, 80));
  const bold = await pointOf(page, 'жирным', 2);
  await page.mouse.click(bold.x, bold.y);
  await page.waitForTimeout(150);
  const onBold = await lineText(page, 'Короткий абзац с');
  check(label, 'a click in a bold word shows its marks and only its (Л5.2)', onBold.includes('**жирным**') && !onBold.includes('](https://example.com)') && !onBold.includes('`встроенным'), onBold.slice(0, 100));
  // A press on a drawn link opens it (Л10.1): the caret goes into it as
  // the arrows take it.
  await caretAfter(page, 'внешней');
  await page.waitForTimeout(150);
  const onLink = await lineText(page, 'Короткий абзац с');
  check(label, 'the caret moved into a link shows the link\'s source and hides the bold\'s marks again', onLink.includes('[внешней ссылкой](https://example.com)') && !onLink.includes('**жирным**'), onLink.slice(0, 120));
  // A heading's `#` shows with the caret in its line.
  await caretAfter(page, '## Заголовок второго');
  check(label, 'a heading shows its `##` with the caret in its line', (await lineText(page, 'Заголовок второго уровня'))?.startsWith('## '));

  // A code block: a press shows its source, Escape chooses it, Escape again
  // puts the caret after it and draws it again (Л5.3).
  await pressWidget(page, "[data-editor-block='code']", 'interface Card');
  const source = await page.evaluate(() => document.querySelectorAll('.mine-note-editor .cm-line.cm-md-source').length);
  check(label, 'a press on a code block shows its source lines (Л5.3)', source > 3, `${source}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const chosen = await page.evaluate(() => document.querySelector("[data-editor-block='code'][data-block-selected]") !== null);
  check(label, 'Escape from its source chooses the block, drawn again', chosen);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const left = await page.evaluate(() => document.querySelector('[data-block-selected]') === null && document.querySelectorAll('.mine-note-editor .cm-line.cm-md-source').length === 0);
  check(label, 'Escape again leaves the block drawn', left);
  // ↓ from the line above a callout chooses it, Enter shows its source.
  await caretAfter(page, '> Второй абзац цитаты.');
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const arrowed = await page.evaluate(() => document.querySelector("[data-editor-block='callout'][data-block-selected]")?.textContent?.slice(0, 40) ?? null);
  check(label, '↓ from the text above chooses the callout as a block (Л5.3)', arrowed !== null && arrowed.includes('Заметка'), arrowed ?? 'nothing chosen');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check(label, 'Enter on the chosen callout shows its source', (await lineText(page, '> [!note] Заметка')) !== null);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

/** Л7: Enter goes on and leaves a list, Tab nests an item, a box changes one
 *  sign. */
async function listsAndTasks(label, page) {
  const original = await body(page);
  await caretAfter(page, '- Пункт маркированного списка');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Новый');
  let expected = original.replace('- Пункт маркированного списка\n', '- Пункт маркированного списка\n- Новый\n');
  check(label, 'Enter in a list item starts the next item with its marker (Л7.1)', await bodyBecomes(page, expected), JSON.stringify(changed(original, await body(page))));
  await page.keyboard.press('Tab');
  expected = original.replace('- Пункт маркированного списка\n', '- Пункт маркированного списка\n\t- Новый\n');
  const indented = await bodyBecomes(page, expected);
  const unit = changed(original, await body(page));
  check(label, 'Tab nests the item by the note\'s unit of indent (Л7.2)', indented || /^ +- Новый\n$/.test(unit.inserted), JSON.stringify(unit));
  for (let index = 0; index < 3; index += 1) await page.evaluate(() => window.__editing.editor.undo());
  check(label, 'undo gives the list back', await bodyBecomes(page, original));

  await caretAfter(page, '- [x] Выполненная задача');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expected = original.replace('- [x] Выполненная задача\n', '- [x] Выполненная задача\n\n');
  check(label, 'Enter in an empty new task leaves the list', await bodyBecomes(page, expected), JSON.stringify(changed(original, await body(page))));
  await page.evaluate(() => window.__editing.editor.undo());
  await page.evaluate(() => window.__editing.editor.undo());
  await bodyBecomes(page, original);

  const box = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.mine-note-editor .cm-md-inline-task [role="checkbox"]')]
      .find((element) => document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() === 'Невыполненная задача');
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  const toggled = original.replace('- [ ] Невыполненная задача', '- [x] Невыполненная задача');
  check(label, 'a press on a task\'s box changes its one sign (Л7.4)', await bodyBecomes(page, toggled), JSON.stringify(changed(original, await body(page))));
  await page.evaluate(() => window.__editing.editor.undo());
  check(label, 'and the change is undone in the editor\'s history', await bodyBecomes(page, original));
}

/** Л8: at rest the widgets are the reading mode's elements, as tall and as
 *  wide within a pixel. */
async function widgetsAsReading(label, page) {
  const measure = (editing) => page.evaluate(async (inEditor) => {
    const scroller = document.querySelector('[data-detail-scroll]');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const root = inEditor ? '.mine-note-editor .cm-content' : '[data-article-body]';
    const found = new Map();
    const take = () => {
      const host = document.querySelector(root);
      if (!host) return;
      const add = (kind, element, key) => {
        const rect = element.getBoundingClientRect();
        if (rect.height <= 0) return;
        const name = `${kind}|${key}`;
        if (!found.has(name)) found.set(name, { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 });
      };
      for (const table of host.querySelectorAll('[data-article-table-scroll] > table')) add('table', table, table.querySelector('tr')?.textContent.trim().slice(0, 40));
      for (const block of host.querySelectorAll('[data-code-block]:not([data-mermaid] [data-code-block])')) add('code', block, block.textContent.trim().slice(0, 40));
      for (const callout of host.querySelectorAll('[data-callout]')) add('callout', callout, callout.textContent.trim().slice(0, 40));
      for (const math of host.querySelectorAll('.katex-display')) add('formula', math, math.textContent.trim().slice(0, 30));
      for (const embed of host.querySelectorAll('[data-note-embed="found"] [data-note-embed-open]')) add('embed', embed, embed.closest('[data-note-embed]').getAttribute('data-note-embed-slug') + embed.textContent.trim().slice(0, 30));
    };
    scroller.scrollTop = 0;
    for (let top = 0; top <= scroller.scrollHeight + scroller.clientHeight; top += scroller.clientHeight / 2) {
      scroller.scrollTop = top;
      await frame();
      await frame();
      await new Promise((resolve) => setTimeout(resolve, 60));
      take();
    }
    scroller.scrollTop = 0;
    return Object.fromEntries(found);
  }, editing);
  const inEditor = await measure(true);
  await page.evaluate(() => window.__editing.setEditing(false));
  await page.waitForSelector('[data-article-body]');
  await page.waitForFunction(() => document.querySelectorAll('[data-article-body] .katex-display').length > 0 && document.querySelectorAll('[data-article-body] [data-code-highlighted]').length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(300);
  const reading = await measure(false);
  await page.evaluate(() => window.__editing.setEditing(true));
  await page.waitForSelector('.mine-note-editor .cm-content');
  await page.waitForTimeout(300);
  for (const kind of ['table', 'code', 'callout', 'formula', 'embed']) {
    const keys = Object.keys(reading).filter((key) => key.startsWith(`${kind}|`));
    const differing = keys.filter((key) => {
      const a = reading[key];
      const b = inEditor[key];
      return !b || Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1;
    });
    check(label, `at rest every ${kind} of the note is the reading mode's, its size within a pixel (Л8), ${keys.length} of them`, keys.length > 0 && differing.length === 0,
      differing.slice(0, 3).map((key) => `${key}: reading ${JSON.stringify(reading[key])} editor ${JSON.stringify(inEditor[key] ?? null)}`).join('; '));
  }
}

/** Л9 on the table cases: a press opens the cell under it, Tab, a range and
 *  its copy, the `Table` menu by its keys, the active cell's name. */
async function tables(label, theme) {
  const { page, errors } = await open(theme, WIDE, '&body=tables');
  const original = await body(page);
  const active = () => page.evaluate(() => window.__editing.table.active());
  const tableShape = await page.evaluate(() => {
    const table = document.querySelector("[data-editor-block='table'] table");
    return { headers: table?.querySelectorAll('thead th').length ?? 0, rows: table?.querySelectorAll('tbody tr').length ?? 0 };
  });
  check(label, 'a table at rest is a real table with its header row (Л16)', tableShape.headers === 2 && tableShape.rows === 2, JSON.stringify(tableShape));
  const cell = async (tableIndex, row, col, before) => {
    const point = await page.evaluate(([t, r, c, b]) => {
      const table = document.querySelectorAll("[data-editor-block='table']")[t];
      const element = table?.querySelector(`[data-table-row='${r}'][data-table-col='${c}']`);
      if (!element) return null;
      element.scrollIntoView({ block: 'center' });
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let left = b;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (left <= node.textContent.length) {
          const range = document.createRange();
          range.setStart(node, left);
          range.setEnd(node, Math.min(node.textContent.length, left + 1));
          const rect = range.getBoundingClientRect();
          return { x: rect.left + 1, y: rect.top + rect.height / 2 };
        }
        left -= node.textContent.length;
      }
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 4, y: rect.top + rect.height / 2 };
    }, [tableIndex, row, col, before]);
    await page.mouse.click(point.x, point.y);
    await page.waitForSelector('[data-table-cell-editor] .cm-content');
  };
  await cell(1, 2, 0, 4);
  const name = await page.evaluate(() => document.querySelector('[data-table-cell-editor] .cm-content')?.getAttribute('aria-label'));
  check(label, 'the active cell is named by its row and column (Л16)', name === 'Row 3, column 1', name);
  await page.keyboard.type('X');
  const typed = original.replace('| длинный текст в ячейке |', '| длинXный текст в ячейке |');
  check(label, 'a press puts the caret at the sign under it, typing writes that cell only (Л9.4, Л9.5)', await bodyBecomes(page, typed), JSON.stringify(changed(original, await body(page))));
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  check(label, 'Tab goes to the next cell (Л9.6)', JSON.stringify((await active())?.owner) === JSON.stringify({ kind: 'cell', cell: { row: 2, col: 1 } }), JSON.stringify((await active())?.owner));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check(label, 'Escape leaves the table (Л9.6)', (await active()) === null);
  await page.evaluate(() => window.__editing.editor.undo());
  await bodyBecomes(page, original);

  // A range by ⇧-press, copied as text and as a table of HTML (Л9.7).
  await cell(0, 1, 0, 0);
  const second = await page.evaluate(() => {
    const element = document.querySelectorAll("[data-editor-block='table']")[0].querySelector("[data-table-row='2'][data-table-col='1']");
    const rect = element.getBoundingClientRect();
    return { x: rect.left + 5, y: rect.top + rect.height / 2 };
  });
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  await page.keyboard.press(`${MOD}+c`);
  await page.waitForTimeout(150);
  const copied = await page.evaluate(() => window.__editing.record.clipboard.at(-1));
  check(label, 'a range copies as text and as a table of HTML (Л9.7)', (await page.locator('[data-table-range]').count()) === 4 && copied?.text === 'a\t1\nb\t2' && copied?.html.includes('<td>b</td>'), JSON.stringify(copied));
  await page.keyboard.press('Escape');

  // The `Table` menu by its keys (Л9.8, Л16). The way from a cell to the
  // open card's menu is ⌘K, which waits for ЛВ5: the check gives the focus
  // to the menu's button as that key will.
  await cell(0, 1, 0, 0);
  const rowsBefore = original.split('\n').length;
  await page.evaluate(() => document.querySelector('button[aria-label="Card actions"]').focus());
  await page.keyboard.press('Enter');
  // The menu moves its focus a frame after a key: each step waits for it.
  const focused = async () => {
    await page.waitForTimeout(80);
    return page.evaluate(() => (document.activeElement?.getAttribute('role')?.startsWith('menuitem') ? document.activeElement.textContent.trim() : null));
  };
  await page.waitForFunction(() => document.activeElement?.getAttribute('role')?.startsWith('menuitem') === true, null, { timeout: 5000 });
  const path = [await focused()];
  let reached = path[0] === 'Table';
  for (let step = 0; step < 12 && !reached; step += 1) {
    await page.keyboard.press('ArrowDown');
    path.push(await focused());
    reached = path.at(-1) === 'Table';
  }
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]') !== null && document.activeElement.textContent.trim() !== 'Table', null, { timeout: 5000 }).catch(() => undefined);
  let insert = false;
  for (let step = 0; step < 12 && !insert; step += 1) {
    path.push(await focused());
    insert = path.at(-1) === 'Insert Row Below';
    if (!insert) await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const inserted = (await body(page)).split('\n').length === rowsBefore + 1;
  const backInCell = await page.evaluate(() => document.activeElement?.closest('[data-table-cell-editor]') !== null);
  check(label, 'the `Table` submenu runs Insert Row Below by its keys, and the cell takes the focus back (Л9.8, Л16)', reached && insert && inserted && backInCell, JSON.stringify({ path, inserted, backInCell }));
  await page.keyboard.press('Escape');
  check(label, 'tables: every write went over its base, no page errors', (await allAccepted(page)) && errors.length === 0, errors.join(' | '));
  await page.close();
}

/** Л4: the file's change comes in by itself while nothing is unsaved, and
 *  stays apart from unsaved edits. */
async function externalChanges(label, theme) {
  const { page, errors } = await open(theme, WIDE);
  const original = await body(page);
  const outside = original.replace('Короткий абзац с', 'Короткий абзац из Obsidian с');
  const writesBefore = await writes(page);
  await page.evaluate((text) => window.__editing.writeFromOutside(text), outside);
  await page.waitForFunction((text) => window.__editing.editor.text().then((doc) => doc === text), outside, { timeout: 5000, polling: 50 }).catch(() => undefined);
  check(label, 'a change of the file is applied by itself while nothing is unsaved, nothing written (Л4.2)', (await docText(page)) === outside && (await writes(page)) === writesBefore);
  // An edit whose write is under way when the file changes: the text stays,
  // the file stays, nothing is written over it (Л4.3).
  await page.evaluate(() => window.__editing.setSaveDelay(800));
  await caretAfter(page, 'Очень длинный абзац');
  await page.keyboard.type(MARK);
  const third = outside.replace('Ссылка на заметку', 'Другая ссылка на заметку');
  await page.evaluate((text) => window.__editing.writeFromOutside(text), third);
  await page.waitForTimeout(1500);
  const kept = (await docText(page)).includes(`Очень длинный абзац${MARK}`);
  const fileKept = (await body(page)) === third;
  const overwritten = await page.evaluate(() => window.__editing.record.writes.some((write, index, all) => write.accepted && index === all.length - 1 && write.body.includes('✎')));
  check(label, 'with an unsaved edit the text and the changed file both stay, nothing written over the file (Л4.3)', kept && fileKept && !overwritten, JSON.stringify({ kept, fileKept, overwritten }));
  check(label, 'external changes: no page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/** Л10.2: `[[` opens the menu of notes, Enter inserts the link once. */
async function linkMenu(label, page) {
  const original = await body(page);
  await caretAfter(page, 'Матрица в формуле');
  await page.keyboard.type(' [[Пример');
  await page.waitForSelector('.cm-tooltip-autocomplete [role="option"]', { timeout: 5000 });
  const option = await page.locator('.cm-tooltip-autocomplete [role="option"]').first().textContent();
  await page.keyboard.press('Enter');
  const expected = original.replace('Матрица в формуле', 'Матрица в формуле [[Пример заметки]]');
  check(label, '`[[` offers the note and Enter inserts `[[Пример заметки]]`, `]]` not doubled (Л10.2)', option?.includes('Пример заметки') && await bodyBecomes(page, expected), JSON.stringify(changed(original, await body(page))));
  await page.evaluate(() => window.__editing.editor.undo());
  await page.evaluate(() => window.__editing.editor.undo());
  await bodyBecomes(page, original, 2000);
}

/** Л11: the selection bar without `Delete Text`, the jumps to a heading and a
 *  block. */
async function openCard(label, page) {
  const from = await caretAfter(page, 'Очень длинный абзац для проверки');
  await page.evaluate((anchor) => window.__editing.editor.select(anchor - 'Очень длинный абзац для проверки'.length, anchor), from);
  await page.waitForTimeout(250);
  const bar = await page.evaluate(() => {
    const element = document.querySelector('[data-text-selection-action-bar]');
    return element ? { create: element.textContent.includes('Create Element'), remove: element.textContent.includes('Delete Text') } : null;
  });
  check(label, 'a selection in the editor shows the action bar without Delete Text (Л11.2)', bar?.create && !bar.remove, JSON.stringify(bar));
  await page.evaluate(() => window.__editing.editor.select(0));
  for (const [anchor, text] of [['Таблицы', 'Таблицы'], ['^reading-check', 'Абзац с меткой блока']]) {
    await page.evaluate((value) => window.__editing.jump(value), anchor);
    const inView = await page.waitForFunction((words) => {
      const line = [...document.querySelectorAll('.mine-note-editor .cm-line')].find((candidate) => candidate.textContent.includes(words) && candidate.textContent.length < 80);
      const box = line?.getBoundingClientRect();
      return box && box.top >= 0 && box.bottom <= window.innerHeight;
    }, text, { timeout: 5000 }).then(() => true, () => false);
    check(label, `a card opened at ${anchor} scrolls the editor there (Л11.8)`, inView);
    await page.evaluate(() => window.__editing.jump(null));
  }
}

/** Л13.1: a composition writes nothing until it ends and keeps the text
 *  around it. */
async function composition(label, page) {
  const original = await body(page);
  await caretAfter(page, 'Ссылка на заметку ');
  const cdp = await page.context().newCDPSession(page);
  const before = await writes(page);
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(150);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(400);
  const during = await writes(page);
  await cdp.send('Input.insertText', { text: '日本' });
  const expected = original.replace('Ссылка на заметку [[Пример заметки]]', 'Ссылка на заметку 日本[[Пример заметки]]');
  check(label, 'a composition writes nothing until it ends, then its text, the wikilink beside it whole (Л13.1)', during === before && await bodyBecomes(page, expected), JSON.stringify({ before, during, diff: changed(original, await body(page)) }));
  await page.evaluate(() => window.__editing.editor.undo());
  await bodyBecomes(page, original, 2000);
  await cdp.detach();
}

async function layoutChecks(label, page, requests) {
  const sideways = await page.evaluate(() => {
    const scroller = document.querySelector('[data-detail-scroll]');
    return { scroll: scroller.scrollWidth - scroller.clientWidth, page: document.scrollingElement.scrollWidth - window.innerWidth };
  });
  check(label, 'nothing pushes the open card or the page sideways', sideways.scroll <= 0 && sideways.page <= 0, JSON.stringify(sideways));
  const foreign = requests.filter((url) => !url.startsWith(vite.origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
  check(label, 'nothing is asked of the network outside the page', foreign.length === 0, foreign.slice(0, 3).join(', '));
}

try {
  browser = await chromium.launch({ headless: true });
  for (const theme of THEMES) {
    const label = `${theme} ${WIDE.width} × ${WIDE.height}`;
    {
      const { page, errors, requests } = await open(theme, WIDE);
      await accessibility(label, page);
      await livePreview(label, page);
      await listsAndTasks(label, page);
      await linkMenu(label, page);
      await openCard(label, page);
      await composition(label, page);
      await keyboardUndo(label, page);
      await layoutChecks(label, page, requests);
      check(label, 'every write went over its base, no page errors', (await allAccepted(page)) && errors.length === 0, errors.join(' | '));
      await page.close();
    }
    {
      const { page, errors } = await open(theme, WIDE);
      await widgetsAsReading(label, page);
      check(label, 'widgets: no page errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }
    for (const variant of Object.keys(VARIANTS)) await byteExact(label, theme, variant);
    await tables(label, theme);
    await externalChanges(label, theme);

    const narrow = `${theme} ${NARROW.width} × ${NARROW.height}`;
    const { page, errors, requests } = await open(theme, NARROW);
    const field = await page.evaluate(() => document.querySelector('.mine-note-editor .cm-content')?.getAttribute('aria-label'));
    check(narrow, 'the editor stands in the stacked open card, its field named', field === `Text of ${FILE_NAME}`, field);
    await widgetsAsReading(narrow, page);
    await layoutChecks(narrow, page, requests);
    check(narrow, 'no page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}

for (const [what, decision] of PENDING) console.log(`PENDING ${what}: waits for ${decision}`);
const failed = results.filter((result) => !result.ok);
console.log(`editing-audit: ${results.length - failed.length} passed, ${failed.length} failed, ${PENDING.length} pending the user's decisions`);
if (failed.length > 0) process.exitCode = 1;
