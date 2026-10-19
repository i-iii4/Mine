// The reading mode of an open card in headless Chromium (SPEC_READING_MODE.md,
// Ч14): the fixture note `scripts/fixtures/reading-mode.md` drawn by `Detail`
// with a made-up card and a made-up `invoke`, in the light and the dark
// theme, at 1600 × 800 (beside the panel) and 900 × 800 (stacked). Real
// layout, fonts and lazy chunks, which the jsdom tests cannot see: nothing
// pushes the page sideways, code in a line, the marker, HTML, tables, code
// blocks, Mermaid, callouts, KaTeX, footnotes, note embeds and task boxes
// look and act as the rules say, in the colours the user chose on 18.10.2026
// (callout types, highlighted code, diagram series), an embed opens its note
// and a card opened at a heading or a block scrolls to it, and nothing is
// asked of the network. A card whose body can be edited opens in the editor
// (SPEC_EDITING.md, Л1); the reading surface is what a body that cannot be
// edited shows, and the check turns the editor off to look at it.
// Starts and stops its own Vite.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { COLD_START_MS, startAuditVite } from './audit-vite.mjs';
import { CLIPPER_LIST, gapBetween, LINE_HEIGHT, markerRows, PARAGRAPH_GAP, pictureBoxes, routePictures, SHAPE_ITEMS, SHAPE_PAIRS } from './picture-rows.mjs';

const ENTRY = '/reading-mode-entry.js';
const PAGE = '/__reading-mode-audit';
const SOURCE_SLUG = 'Cards/Проверка просмотрщика';
const EMBED_SLUG = 'Cards/Пример заметки';
const SIZES = [[1600, 800], [900, 800]];
const THEMES = ['light', 'dark'];
/** The card of a note embed, as wide as the previews of related notes. */
const EMBED_WIDTH = 240;

const fixture = readFileSync(new URL('./fixtures/reading-mode.md', import.meta.url), 'utf8');
/** The body: the file after its front matter, as the core splits it. */
const body = fixture.replace(/^---\n[\s\S]*?\n---\n/, '');
/** The notes of pictures (Ч15), `?body=<name>`. */
const PICTURE_NOTES = {
  'list-of-images': readFileSync(new URL('./fixtures/list-of-images.md', import.meta.url), 'utf8'),
  'media-shapes': readFileSync(new URL('./fixtures/media-shapes.md', import.meta.url), 'utf8'),
};

/** The byte offset in the body where the task item `text` starts (its list
 *  marker), the one `toggle_task_item` must be given. */
function itemStartOf(text) {
  const line = body.split('\n').find((candidate) => candidate.includes(text));
  assert(line, `the fixture has the task “${text}”`);
  const lineStart = body.indexOf(`${line}\n`);
  const marker = line.search(/[-*+]|\d/);
  return Buffer.byteLength(body.slice(0, lineStart + marker), 'utf8');
}

const vite = await startAuditVite([{
  name: 'reading-mode-audit',
  // KaTeX's fonts are files of its package, which a worktree may reach
  // through a linked `node_modules` outside its root.
  config() {
    const root = fileURLToPath(new URL('..', import.meta.url));
    return { server: { fs: { allow: [root, realpathSync(new URL('../node_modules', import.meta.url))] } } };
  },
  resolveId(id) { if (id === ENTRY) return `\0${ENTRY}`; },
  load(id) {
    if (id !== `\0${ENTRY}`) return;
    return `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { DndContext } from '@dnd-kit/core';
      import { Detail } from '/src/components/Detail.tsx';
      import { NoteEditingSwitch } from '/src/components/editing/noteEditingSwitch.ts';
      import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
      import { stripFadeMaskStyle } from '/src/lib/edgeFade.ts';
      import '/src/styles/global.css';
      const params = new URLSearchParams(location.search);
      if (params.get('theme')) document.documentElement.setAttribute('data-theme', params.get('theme'));
      const body = ${JSON.stringify(PICTURE_NOTES)}[params.get('body')] ?? ${JSON.stringify(body)};
      const base = { id: 1, block_type: 'article', card_kind: 'article', title: null, content_heading: null, description: null, url: null, media_file: null, thumbnail: null, saved_at: '2026-10-18T14:23:24Z', source: null, width: null, height: null, author: null, preview_text: null, first_image: null, media_urls: null, media_dimensions: null, preview_manifest: null, feed_playback: null, thumb_format: null, thumb_mtime: 0, related_notes: [], origin: null, index_warning: null, tags: [] };
      const card = { ...base, slug: ${JSON.stringify(SOURCE_SLUG)}, display_title: 'Проверка просмотрщика', fallback_label: 'Проверка просмотрщика', body, body_hash: 'hash-0' };
      const embedded = { ...base, id: 2, slug: ${JSON.stringify(EMBED_SLUG)}, display_title: 'Пример заметки', fallback_label: 'Пример заметки', body: 'Текст примера заметки.', preview_text: 'Текст примера заметки.', body_hash: 'hash-embed' };
      const blocks = { [card.slug]: card, [embedded.slug]: embedded };
      const notes = { 'Пример заметки': embedded.slug, 'Проверка просмотрщика': card.slug };
      // The block of the wide table, the one whose header starts with "№".
      const wideTableBlock = () => [...document.querySelectorAll('[data-article-table-scroll]')]
        .find((wrapper) => wrapper.querySelector('tr')?.textContent.trim().startsWith('№'));
      window.__audit = { toggles: [], clipboard: [], logs: [], opened: [], stripFadeMaskStyle, wideTableBlock };
      let writes = 0;
      window.__TAURI_INTERNALS__ = {
        convertFileSrc: (path) => location.origin + '/media/' + encodeURIComponent(path.split('/').pop()),
        invoke: async (command, args) => {
          if (command === 'get_block') return blocks[args.slug] ?? null;
          if (command === 'resolve_note_link') return notes[args.rawTarget.split('#')[0]] ?? null;
          if (command === 'plugin:clipboard-manager|write_text') { window.__audit.clipboard.push(args.text); return null; }
          if (command === 'plugin:log|log') { window.__audit.logs.push(args.message); return null; }
          if (command === 'toggle_task_item') {
            const { params } = args;
            window.__audit.toggles.push(params);
            const bytes = new TextEncoder().encode(blocks[params.source_slug].body);
            const open = bytes.indexOf(91, params.item_start);
            bytes[open + 1] = params.checked ? 32 : 120;
            writes += 1;
            const next = { ...blocks[params.source_slug], body: new TextDecoder().decode(bytes), body_hash: 'hash-' + writes };
            blocks[next.slug] = next;
            return next;
          }
          throw new Error(command);
        },
      };
      const noop = () => {};
      // An embed's click asks the host to open a note: the page notes what.
      // \`jump\` opens the card again at a place, as a link with \`#…\` does.
      const openRelatedNote = (slug) => window.__audit.opened.push(slug);
      function Shell() {
        const [anchor, setAnchor] = React.useState(null);
        window.__audit.jump = setAnchor;
        const detail = React.createElement(Detail, { block: card, scrollAnchor: anchor, vaultPath: '/vault', thumbsRootPath: '/thumbs', tags: [], onClose: noop, onToggleTag: noop, onCreateAndAssign: noop, onRequestRename: noop, onRequestDelete: noop, onOpenRelatedNote: openRelatedNote });
        return React.createElement(NoteEditingSwitch.Provider, { value: false },
          React.createElement('div', { style: { display: 'flex', height: '100vh' } },
            React.createElement('main', { style: { position: 'relative', flex: '1', minWidth: 0 } }, detail)));
      }
      createRoot(document.getElementById('root')).render(React.createElement(TooltipProvider, null, React.createElement(DndContext, null, React.createElement(Shell))));`;
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/media/')) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      if (!req.url.startsWith(PAGE)) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root" style="height:100vh"></div><script type="module" src="${ENTRY}"></script></body></html>`));
    });
  },
}]);

/** Within a pixel: Chromium lays out in fractions of one. */
function near(actual, expected, message) {
  assert(Math.abs(actual - expected) <= 1, `${message}: ${actual} against ${expected}`);
}

/** The edges the wide table's block dissolves, its mask as Chromium
 *  computes it, and the shared strip mask for its right and its left edge
 *  alone (SPEC_SCROLL_EDGE_FADE.md, «Полоса вкладок»). */
async function readWideTableFade(page) {
  return page.evaluate(() => {
    const block = window.__audit.wideTableBlock();
    const maskOf = (element) => {
      const style = getComputedStyle(element);
      return style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage;
    };
    const shared = (edges) => {
      const probe = document.createElement('div');
      Object.assign(probe.style, window.__audit.stripFadeMaskStyle(edges));
      document.body.appendChild(probe);
      const mask = maskOf(probe);
      probe.remove();
      return mask;
    };
    return {
      left: block.dataset.fadeLeft ?? null,
      right: block.dataset.fadeRight ?? null,
      mask: maskOf(block),
      rightMask: shared({ left: false, right: true }),
      leftMask: shared({ left: true, right: false }),
    };
  });
}

/** Everything the rules say of the drawn article, read in the page. */
async function inspect(page) {
  return page.evaluate(() => {
    const article = document.querySelector('[data-article-body]');
    const scroll = document.querySelector('[data-detail-scroll]');
    const column = article.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    /** A colour as `#rrggbb` over the page, as Mermaid is given it. */
    const hex = (color) => {
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--background');
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
    };
    /** `token` as the element `host` would paint it as a background. */
    const tokenIn = (host, token) => {
      const probe = document.createElement('span');
      probe.style.background = `var(${token})`;
      host.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    /** `token` as the element `host` would paint it as text. */
    const inkIn = (host, token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      host.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const textOf = (element) => element?.textContent?.trim() ?? '';
    const paragraphWith = (text) => [...article.querySelectorAll('p')].find((p) => p.textContent.includes(text));
    const inlineCode = article.querySelector('p > code');
    const calloutCode = article.querySelector('[data-callout] p code, [data-callout] [data-callout-body] code');
    const mark = article.querySelector('mark');
    const tables = [...article.querySelectorAll('[data-article-table-scroll]')].map((wrapper) => {
      const table = wrapper.querySelector('table');
      return {
        text: textOf(table.querySelector('tr')),
        width: table.getBoundingClientRect().width,
        wrapperWidth: wrapper.clientWidth,
        scrollWidth: wrapper.scrollWidth,
        layout: table.getAttribute('data-article-table'),
        cells: [...table.querySelectorAll('th, td')].map((cell) => ({
          text: textOf(cell),
          align: getComputedStyle(cell).textAlign,
          vertical: getComputedStyle(cell).verticalAlign,
          weight: getComputedStyle(cell).fontWeight,
          top: cell.getBoundingClientRect().top,
          height: cell.getBoundingClientRect().height,
          firstLineTop: (() => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            return range.getClientRects()[0]?.top ?? null;
          })(),
        })),
      };
    });
    const codeBlocks = [...article.querySelectorAll('[data-code-block]')].map((block) => {
      const pre = block.querySelector('pre');
      return {
        language: block.getAttribute('data-code-language'),
        text: pre.textContent,
        highlighted: block.querySelector('[data-code-highlighted]') !== null,
        scrollWidth: pre.scrollWidth,
        clientWidth: pre.clientWidth,
        background: getComputedStyle(pre).backgroundColor,
        muted: tokenIn(block, '--muted'),
        copyOpacity: getComputedStyle(block.querySelector('[data-code-copy]')).opacity,
      };
    });
    const series = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple']
      .map((name) => hex(getComputedStyle(document.documentElement).getPropertyValue(`--series-${name}`)));
    const pie = [...article.querySelectorAll('[data-mermaid-diagram] svg .pieCircle')].map((slice) => hex(getComputedStyle(slice).fill));
    const ganttBars = [...article.querySelectorAll('[data-mermaid-diagram] svg rect.task')].map((bar) => hex(getComputedStyle(bar).fill));
    const keyword = article.querySelector('[data-code-block][data-code-language="typescript"] .hljs-keyword');
    const diagrams = [...article.querySelectorAll('[data-mermaid]')].map((host) => {
      const svg = host.querySelector('[data-mermaid-diagram] svg');
      const shape = svg?.querySelector('.node rect, .node polygon, .node path');
      const label = svg?.querySelector('.nodeLabel, .node text');
      return {
        drawn: Boolean(svg),
        failed: host.querySelector('[data-mermaid-failed]') !== null,
        code: host.querySelector('[data-code-block]') !== null,
        width: svg?.getBoundingClientRect().width ?? 0,
        nodeFill: shape ? hex(getComputedStyle(shape).fill) : null,
        labelColor: label ? hex(label.tagName === 'text' ? getComputedStyle(label).fill : getComputedStyle(label).color) : null,
      };
    });
    const embeds = [...article.querySelectorAll('[data-note-embed]')].map((embed) => {
      const card = embed.firstElementChild;
      const box = (card ?? embed).getBoundingClientRect();
      return { state: embed.getAttribute('data-note-embed'), text: textOf(embed), width: box.width, left: box.left - column.left, right: column.right - box.right };
    });
    const longWord = paragraphWith('Donaudampfschifffahrts');
    const longAddress = paragraphWith('Адрес в 200 знаков');
    return {
      columnWidth: column.width,
      scrollWidth: scroll.scrollWidth,
      scrollClientWidth: scroll.clientWidth,
      longWordRight: longWord.getBoundingClientRect().right - column.right,
      longAddressRight: longAddress.getBoundingClientRect().right - column.right,
      inlineCode: {
        before: getComputedStyle(inlineCode, '::before').content,
        after: getComputedStyle(inlineCode, '::after').content,
        weight: getComputedStyle(inlineCode).fontWeight,
        background: getComputedStyle(inlineCode).backgroundColor,
        fill: tokenIn(inlineCode.parentElement, '--component-fill'),
      },
      calloutCode: calloutCode && {
        background: getComputedStyle(calloutCode).backgroundColor,
        fill: tokenIn(calloutCode.parentElement, '--component-fill'),
      },
      mark: { background: getComputedStyle(mark).backgroundColor, token: tokenIn(article, '--search-mark') },
      html: {
        kbd: article.querySelectorAll('kbd').length,
        sub: article.querySelectorAll('sub').length,
        details: article.querySelectorAll('details[data-html-details]').length,
        script: article.querySelectorAll('script').length,
        onerror: article.querySelectorAll('[onerror]').length,
        scriptRan: Boolean(window.__readingModeScriptRan),
        onerrorRan: Boolean(window.__readingModeOnerrorRan),
        htmlCheckbox: article.querySelectorAll('[data-html-checkbox]').length,
      },
      tables,
      codeBlocks,
      diagrams,
      callouts: [...article.querySelectorAll('[data-callout]')].map((callout) => {
        const title = callout.querySelector('[data-callout-title]');
        return {
          type: callout.getAttribute('data-callout'),
          title: textOf(title),
          fold: callout.getAttribute('data-callout-fold'),
          open: callout.tagName === 'DETAILS' ? callout.open : null,
          color: getComputedStyle(title).color,
          iconColor: getComputedStyle(title.querySelector('[data-callout-icon]')).color,
          tokens: Object.fromEntries(['--destructive', '--detach', '--callout-blue', '--callout-cyan', '--callout-green', '--callout-purple', '--muted-foreground']
            .map((token) => [token, inkIn(title, token)])),
        };
      }),
      series,
      pie,
      ganttBars,
      keyword: keyword && { color: getComputedStyle(keyword).color, token: inkIn(keyword.parentElement, '--code-keyword'), text: inkIn(keyword.parentElement, '--foreground') },
      katex: article.querySelectorAll('.katex').length,
      katexFont: document.fonts.check('16px KaTeX_Main'),
      embeds,
      tasks: article.querySelectorAll('[data-task-checkbox]').length,
      cardText: { foreground: hex(getComputedStyle(document.documentElement).getPropertyValue('--foreground')), card: hex(getComputedStyle(document.documentElement).getPropertyValue('--card')) },
    };
  });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const theme of THEMES) {
    for (const [width, height] of SIZES) {
      const label = `${theme} ${width} × ${height}`;
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      const requests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(new URL(`${PAGE}?theme=${theme}`, vite.origin).href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-article-body]', { timeout: COLD_START_MS });
      // The lazy parts: highlighting, KaTeX, Mermaid, the embeds' lookups.
      await page.waitForFunction(() => {
        const article = document.querySelector('[data-article-body]');
        return article.querySelectorAll('[data-code-highlighted]').length >= 5
          && article.querySelectorAll('.katex').length >= 3
          && article.querySelectorAll('[data-mermaid-diagram] svg').length >= 5
          && article.querySelector('[data-mermaid-failed]') !== null
          && article.querySelectorAll('[data-note-embed="found"]').length >= 3
          && article.querySelector('[data-note-embed="missing"]') !== null
          && article.querySelectorAll('[data-article-table="columns"]').length >= 6;
      }, null, { timeout: COLD_START_MS });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const report = await inspect(page);

      // Ч1. Nothing pushes the page sideways; a long word and a 200
      // character address stay in the column.
      assert.equal(report.scrollWidth, report.scrollClientWidth, `${label}: the open card does not scroll sideways`);
      assert(report.longWordRight <= 0.5, `${label}: the long word stays in the column (${report.longWordRight})`);
      assert(report.longAddressRight <= 0.5, `${label}: the 200 character address stays in the column (${report.longAddressRight})`);

      // Ч2. Code in a line: no backticks, regular weight, the quiet fill, on
      // the page and in a callout.
      assert.equal(report.inlineCode.before, 'none', `${label}: no backtick before code in a line`);
      assert.equal(report.inlineCode.after, 'none', `${label}: no backtick after code in a line`);
      assert.equal(report.inlineCode.weight, '400', `${label}: code in a line at weight 400`);
      assert.equal(report.inlineCode.background, report.inlineCode.fill, `${label}: code in a line on --component-fill`);
      assert(report.calloutCode, `${label}: code in a callout`);
      assert.equal(report.calloutCode.background, report.calloutCode.fill, `${label}: code in a callout on the callout's --component-fill`);

      // Ч3. The marker is the search's yellow.
      assert.equal(report.mark.background, report.mark.token, `${label}: <mark> on --search-mark`);

      // Ч4. HTML drawn after sanitizing.
      assert(report.html.kbd >= 2 && report.html.sub >= 1 && report.html.details >= 1, `${label}: kbd, sub and details drawn`);
      assert.equal(report.html.script, 0, `${label}: no <script>`);
      assert.equal(report.html.onerror, 0, `${label}: no onerror`);
      assert(!report.html.scriptRan && !report.html.onerrorRan, `${label}: no script of the note ran`);
      assert.equal(report.html.htmlCheckbox, 1, `${label}: the HTML checkbox is an inert box`);

      // Ч5. Tables: a narrow one keeps its width, alignment from the
      // delimiter row, cells from the top line, the header row not bold, a
      // wide one scrolls in its own block.
      const narrow = report.tables.find((table) => table.text.startsWith('Ключ'));
      assert(narrow.width < report.columnWidth - 100, `${label}: the narrow table is not stretched (${narrow.width} of ${report.columnWidth})`);
      const aligned = report.tables.find((table) => table.text.startsWith('Слева'));
      assert.deepEqual(aligned.cells.slice(0, 3).map((cell) => cell.align), ['left', 'center', 'right'], `${label}: alignment from the delimiter row`);
      assert(aligned.cells.every((cell) => cell.vertical === 'top'), `${label}: cells from the top of their row`);
      assert(aligned.cells.slice(0, 3).every((cell) => cell.weight === '400'), `${label}: the header row is not bold`);
      const wide = report.tables.find((table) => table.text.startsWith('№'));
      assert(wide.scrollWidth > wide.wrapperWidth + 1, `${label}: the wide table scrolls in its block (${wide.scrollWidth} in ${wide.wrapperWidth})`);
      const long = report.tables.find((table) => table.text.startsWith('Колонка'));
      const row = long.cells.slice(2, 4);
      assert(row[1].height > row[0].height || Math.abs(row[0].height - row[1].height) < 1, `${label}: a row of the long table`);
      near(row[0].firstLineTop, row[1].firstLineTop, `${label}: a one-line cell stands on the first line of a taller one`);
      // The wide table's block dissolves the edge that hides columns, with
      // the strip's own mask: the right one at rest, the left one scrolled
      // to the end.
      const rest = await readWideTableFade(page);
      assert.match(rest.rightMask, /linear-gradient/, `${label}: the shared right-edge mask`);
      assert.deepEqual([rest.left, rest.right], [null, 'true'], `${label}: at rest the wide table dissolves its right edge only`);
      assert.equal(rest.mask, rest.rightMask, `${label}: the wide table's block wears the shared right-edge mask`);
      await page.evaluate(() => {
        const block = window.__audit.wideTableBlock();
        block.scrollLeft = block.scrollWidth;
      });
      await page.waitForFunction(() => {
        const block = window.__audit.wideTableBlock();
        return block.dataset.fadeLeft === 'true' && block.dataset.fadeRight === undefined;
      }, null, { timeout: 5000 });
      const scrolled = await readWideTableFade(page);
      assert.equal(scrolled.mask, scrolled.leftMask, `${label}: scrolled to the end the block wears the shared left-edge mask`);

      // Ч6. Code blocks on --muted, highlighted, a long line scrolls inside
      // its block, the copy button hidden until the pointer comes.
      const blocks = report.codeBlocks.filter((block) => block.language && block.language !== 'mermaid');
      assert(blocks.every((block) => block.highlighted), `${label}: known languages highlighted`);
      assert(report.codeBlocks.every((block) => block.background === block.muted), `${label}: code blocks on --muted`);
      const longLine = report.codeBlocks.find((block) => block.text.includes('veryLongLine'));
      assert(longLine.scrollWidth > longLine.clientWidth, `${label}: the long line scrolls inside its block`);
      assert(report.codeBlocks.every((block) => block.copyOpacity === '0'), `${label}: copy buttons hidden at rest`);
      const tsBlock = page.locator('[data-code-block][data-code-language="typescript"]').first();
      await tsBlock.hover();
      await page.waitForTimeout(250);
      assert.equal(await tsBlock.locator('[data-code-copy]').evaluate((node) => getComputedStyle(node).opacity), '1', `${label}: the copy button shows under the pointer`);
      await tsBlock.locator('[data-code-copy-button]').click();
      const expectedCode = /```typescript\n([\s\S]*?)\n```/.exec(body)[1];
      await page.waitForFunction((code) => window.__audit.clipboard.includes(code), expectedCode, { timeout: 5000 });

      // Ч6.4. A highlighted keyword in GitHub's colour of the theme.
      assert(report.keyword, `${label}: a highlighted keyword`);
      assert.equal(report.keyword.color, report.keyword.token, `${label}: a keyword in --code-keyword`);
      assert.notEqual(report.keyword.color, report.keyword.text, `${label}: a keyword not in the text's colour`);

      // Ч7. Diagrams in the tokens' colours; a broken one stays code.
      const drawn = report.diagrams.filter((diagram) => diagram.drawn);
      assert(drawn.length >= 5, `${label}: the diagrams drawn (${drawn.length})`);
      assert(drawn.every((diagram) => diagram.width <= report.columnWidth + 0.5), `${label}: no diagram wider than the column`);
      const flow = drawn[0];
      assert.equal(flow.nodeFill, report.cardText.card, `${label}: a node's fill is --card`);
      assert.equal(flow.labelColor, report.cardText.foreground, `${label}: a node's text is --foreground`);
      // The series (В3 (в)): the pie's slices take the first colours of the
      // series, a Gantt task bar the blue one.
      assert.deepEqual([...report.pie].sort(), report.series.slice(0, report.pie.length).sort(), `${label}: the pie's slices in the series colours`);
      assert(report.pie.length >= 4, `${label}: the pie's slices (${report.pie.length})`);
      assert(report.ganttBars.length >= 3 && report.ganttBars.every((fill) => fill === report.series[5]), `${label}: Gantt's task bars in the series blue (${report.ganttBars})`);
      const broken = report.diagrams.find((diagram) => diagram.failed);
      assert(broken && broken.code && !broken.drawn, `${label}: the broken diagram stands as a code block under the quiet line`);

      // Ч8. Callouts by type; a folded one opens by a click.
      const types = report.callouts.map((callout) => callout.type);
      for (const type of ['note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote']) {
        assert(types.includes(type), `${label}: a ${type} callout`);
      }
      assert(report.callouts.some((callout) => callout.title === 'Faq'), `${label}: the default title of an alias`);
      assert(report.callouts.some((callout) => callout.title === 'Неизвестный тип' && callout.type === 'note'), `${label}: an unknown type drawn as note`);
      // The type's colour on its icon and title (В3 (а)), a token of the theme.
      const CALLOUT_TOKENS = { note: '--callout-blue', info: '--callout-blue', todo: '--callout-blue', abstract: '--callout-cyan', tip: '--callout-cyan', success: '--callout-green', example: '--callout-purple', question: '--detach', warning: '--detach', failure: '--destructive', danger: '--destructive', bug: '--destructive', quote: '--muted-foreground' };
      for (const callout of report.callouts) {
        const token = CALLOUT_TOKENS[callout.type];
        assert.equal(callout.color, callout.tokens[token], `${label}: a ${callout.type} callout's title in ${token}`);
        assert.equal(callout.iconColor, callout.color, `${label}: a ${callout.type} callout's icon in its title's colour`);
      }
      const folded = report.callouts.find((callout) => callout.fold === 'folded');
      assert(folded && folded.open === false, `${label}: the folded callout starts folded`);
      const summary = page.locator('[data-callout][data-callout-fold="folded"] [data-callout-title]');
      await summary.click();
      assert.equal(await page.locator('[data-callout][data-callout-fold="folded"]').evaluate((node) => node.open), true, `${label}: the folded callout opens by a click`);

      // Ч9. KaTeX draws, its font loaded.
      assert(report.katex >= 3, `${label}: formulas drawn (${report.katex})`);
      assert(report.katexFont, `${label}: KaTeX_Main loaded`);

      // Ч10. A footnote's link jumps to it and back, the address kept.
      const address = page.url();
      await page.locator('[data-footnote-ref]').first().click();
      await page.waitForFunction(() => {
        const note = document.getElementById('user-content-fn-1');
        const box = note?.getBoundingClientRect();
        return box && box.top >= 0 && box.bottom <= window.innerHeight;
      }, null, { timeout: 5000 });
      await page.locator('#user-content-fn-1 [data-footnote-backref]').click();
      await page.waitForFunction(() => {
        const box = document.getElementById('user-content-fnref-1')?.getBoundingClientRect();
        return box && box.top >= 0 && box.bottom <= window.innerHeight;
      }, null, { timeout: 5000 });
      assert.equal(page.url(), address, `${label}: the footnote jumps keep the address`);

      // Ч11. Embeds: 240 wide, centred on a line of their own; the missing
      // one a line with its name.
      const found = report.embeds.filter((embed) => embed.state === 'found');
      assert(found.length >= 3, `${label}: the embeds found`);
      for (const embed of found) {
        near(embed.width, Math.min(EMBED_WIDTH, report.columnWidth), `${label}: an embed's card width`);
        near(embed.left, embed.right, `${label}: an embed centred in the column`);
      }
      const missing = report.embeds.find((embed) => embed.state === 'missing');
      assert.equal(missing.text, 'Нет такой заметки', `${label}: the missing note's line`);
      // Ч11.7, Ч11.8. An embed is a button that opens its note, at the place
      // after its `#`; under the pointer its frame takes the focus frame. A
      // note embedding itself is not pressable.
      assert.equal(await page.locator(`[data-note-embed-slug="${SOURCE_SLUG}"] [data-note-embed-open]`).count(), 0, `${label}: the note embedding itself is not pressable`);
      const plain = page.locator(`[data-note-embed-slug="${EMBED_SLUG}"] [data-note-embed-open]`).first();
      await plain.hover();
      await page.waitForTimeout(250);
      const frame = await plain.evaluate((button) => {
        const card = button.querySelector('[data-feed-card-frame]');
        const probe = document.createElement('span');
        probe.style.color = 'var(--border-accent)';
        button.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return { line: getComputedStyle(card, '::after').borderTopColor, accent };
      });
      assert.equal(frame.line, frame.accent, `${label}: an embed under the pointer takes the focus frame`);
      await plain.click();
      const section = page.locator(`[data-note-embed-slug="${EMBED_SLUG}"] [data-note-embed-open]`).last();
      await section.click();
      assert.deepEqual(await page.evaluate(() => window.__audit.opened), [EMBED_SLUG, `${EMBED_SLUG}#Раздел`], `${label}: the embeds open their note, at the heading after #`);
      await page.mouse.move(0, 0);

      // Ч12. A task box sends the item's byte offset and the state seen.
      assert(report.tasks >= 9, `${label}: task boxes (${report.tasks})`);
      const task = page.locator('li[data-task-item]', { hasText: /^\s*Невыполненная задача\s*$/ }).locator('[data-task-checkbox]');
      await task.click();
      await page.waitForFunction(() => window.__audit.toggles.length === 1, null, { timeout: 5000 });
      const [toggle] = await page.evaluate(() => window.__audit.toggles);
      assert.deepEqual(toggle, { source_slug: SOURCE_SLUG, source_body_hash: 'hash-0', item_start: itemStartOf('Невыполненная задача'), checked: false }, `${label}: the toggle's parameters`);
      const quoted = page.locator('li[data-task-item]', { hasText: /^\s*Задача в цитате\s*$/ }).locator('[data-task-checkbox]');
      await quoted.click();
      await page.waitForFunction(() => window.__audit.toggles.length === 2, null, { timeout: 5000 });
      const second = (await page.evaluate(() => window.__audit.toggles))[1];
      assert.equal(second.item_start, itemStartOf('Задача в цитате'), `${label}: a task in a quote names its marker after "> "`);
      assert.equal(second.source_body_hash, 'hash-1', `${label}: the next write takes the new hash`);

      // Ч11.8. A card opened at a heading or a block scrolls its article
      // there.
      for (const [anchor, selector, text] of [['Таблицы', 'h2', 'Таблицы'], ['^READING-CHECK', 'p', 'Абзац с меткой блока']]) {
        await page.evaluate((value) => window.__audit.jump(value), anchor);
        await page.waitForFunction(([tag, words]) => {
          const target = [...document.querySelectorAll(`[data-article-body] ${tag}`)].find((element) => element.textContent.includes(words));
          const box = target?.getBoundingClientRect();
          return box && box.top >= 0 && box.bottom <= window.innerHeight;
        }, [selector, text], { timeout: 5000 });
      }

      // Nothing from the network: every request is the audit page's own.
      const foreign = requests.filter((url) => !url.startsWith(vite.origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
      assert.deepEqual(foreign, [], `${label}: no request outside the page's origin`);
      assert.deepEqual(errors, [], `${label}: no page errors`);
      console.log(`PASS ${label}: no sideways scroll, code in a line, marker, HTML, tables and their dissolving edges, code blocks and their colours, Mermaid and its series, callouts and their colours, KaTeX, footnotes, embeds that open their note, the jump to a heading and a block, and task boxes as the rules say; ${requests.length} requests, all local`);
      await page.close();
    }
  }

  // Ч15. The notes of pictures: 20 between items and paragraphs, 16 in one
  // paragraph, each list item's marker beside its first row.
  const [width, height] = SIZES[0];
  for (const theme of THEMES) {
    for (const note of Object.keys(PICTURE_NOTES)) {
      const label = `${theme} ${width} × ${height} ${note}`;
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await routePictures(page);
      await page.goto(new URL(`${PAGE}?theme=${theme}&body=${note}`, vite.origin).href, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-article-body]', { timeout: COLD_START_MS });
      await page.evaluate(() => document.fonts.ready);
      const boxes = await pictureBoxes(page, '[data-article-body]');
      const pairs = note === 'list-of-images'
        ? CLIPPER_LIST.slice(1).map((name, index) => [CLIPPER_LIST[index], name, PARAGRAPH_GAP])
        : SHAPE_PAIRS;
      for (const [upper, lower, gap] of pairs) near(gapBetween(boxes, upper, lower), gap, `${label}: the space between ${upper} and ${lower}`);
      for (const name of note === 'list-of-images' ? CLIPPER_LIST : SHAPE_ITEMS) {
        assert(boxes[name]?.item?.marker, `${label}: ${name} shows its list item's marker`);
      }
      for (const name of note === 'list-of-images' ? ['image 1', 'image 2', 'image 3'] : SHAPE_ITEMS) {
        const rows = await markerRows(page, '[data-article-body]', name);
        assert(rows && rows.length === 2 && rows[0] >= 0 && rows[1] < LINE_HEIGHT, `${label}: ${name}'s marker beside its first row, rows ${JSON.stringify(rows)}`);
      }
      const sideways = await page.evaluate(() => {
        const scroller = document.querySelector('[data-detail-scroll]');
        return scroller.scrollWidth - scroller.clientWidth;
      });
      assert(sideways <= 0, `${label}: nothing pushes the open card sideways (${sideways})`);
      assert.deepEqual(errors, [], `${label}: no page errors`);
      console.log(`PASS ${label}: ${pairs.length} pairs of pictures ${PARAGRAPH_GAP} apart between items and paragraphs and 16 in one paragraph, every list item's marker beside its first row`);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await vite.close();
}
