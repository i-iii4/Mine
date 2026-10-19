// Pictures on rows of their own, as the browser checks of the reading mode
// and of the editor measure them (SPEC_READING_MODE.md, Ч15; SPEC_EDITING.md,
// Л8.6): placeholder files for the embeds of the picture notes
// (`fixtures/list-of-images.md`, `fixtures/media-shapes.md`), the box of
// every picture in the open card's scroll, the gaps the rule gives between
// pictures that stand next to each other, and the rows a list item's marker
// is drawn in, read from the screen (a marker has no box to ask).
import { PNG } from 'pngjs';

/** The space between two pictures of separate paragraphs or list items:
 *  the paragraph of media's `my-5`. */
export const PARAGRAPH_GAP = 20;
/** The space between two pictures of one paragraph: the stack's gap. */
export const STACK_GAP = 16;
/** A line of the article, `leading-5`: a marker stands in the first. */
export const LINE_HEIGHT = 20;

/** Pictures that stand next to each other in `media-shapes.md`, and the
 *  space between them. */
export const SHAPE_PAIRS = [
  ['shape 1', 'shape 2', PARAGRAPH_GAP],
  ['shape 3', 'shape 4', PARAGRAPH_GAP],
  ['shape 4', 'shape 5', PARAGRAPH_GAP],
  ['shape 6', 'shape 7', PARAGRAPH_GAP],
  ['shape 8', 'shape 9', PARAGRAPH_GAP],
  ['shape 12', 'shape 13', STACK_GAP],
  ['shape 14', 'shape 15', STACK_GAP],
  ['shape 15', 'shape 16', STACK_GAP],
  ['shape 17', 'shape 18', STACK_GAP],
  ['shape 19', 'shape 20', PARAGRAPH_GAP],
];

/** The pictures of `media-shapes.md` that are a list item's whole content:
 *  each shows its item's marker. */
export const SHAPE_ITEMS = ['shape 3', 'shape 4', 'shape 5', 'shape 6', 'shape 7', 'shape 8', 'shape 9', 'shape 10', 'shape 11', 'shape 21', 'shape 23'];

/** The pictures of the clipper's list, `list-of-images.md`, in order:
 *  `image 1` and `image 2` come twice. */
export const CLIPPER_LIST = [...Array.from({ length: 18 }, (_, index) => `image ${index + 1}`), 'image 1#2', 'image 2#2'];

/** A placeholder picture for an embed's file: its size follows its name, so
 *  pictures next to each other differ, a colour that is no background. */
export function placeholderPicture(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 997;
  const width = 360 + (hash % 5) * 40;
  const height = 160 + (hash % 7) * 20;
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    image.data[index * 4] = 40 + (hash % 120);
    image.data[index * 4 + 1] = 90;
    image.data[index * 4 + 2] = 200 - (hash % 100);
    image.data[index * 4 + 3] = 255;
  }
  return PNG.sync.write(image);
}

/** Serve a placeholder for every embed of the picture notes on `page`; any
 *  other file of the vault is not there, as before. */
export async function routePictures(page) {
  await page.route((url) => url.pathname.startsWith('/media/'), (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    if (!/\((image \d+)\)|^shape \d+\./.test(name)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: placeholderPicture(name) });
  });
}

/**
 * The box of every picture under `root` (`[data-article-body]` or the
 * editor's `.cm-content`) in the open card's scroll, by its name (`shape 3`,
 * `image 7`; a name met again gets `#2`), walking the note so the editor
 * draws every part of it and each picture loads. A list item's picture
 * carries its item's box (`item`), where the marker is drawn.
 */
export async function pictureBoxes(page, root) {
  return page.evaluate(async (css) => {
    const scroller = document.querySelector('[data-detail-scroll]');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const found = new Map();
    const seen = new Map();
    scroller.scrollTop = 0;
    for (let top = 0; top <= scroller.scrollHeight + scroller.clientHeight; top += scroller.clientHeight / 2) {
      scroller.scrollTop = top;
      await frame();
      await frame();
      const pictures = [...document.querySelectorAll(`${css} [data-detail-media-action-frame] img`)];
      await Promise.all(pictures.map((image) => (image.complete ? null : new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 2000);
      }))));
      await frame();
      for (const image of pictures) {
        const raw = decodeURIComponent((image.getAttribute('src') ?? '').split('/').pop() ?? '');
        const name = /\((image \d+)\)/.exec(raw)?.[1] ?? /^(shape \d+)\./.exec(raw)?.[1];
        const box = image.closest('[data-detail-media-action-frame]').getBoundingClientRect();
        if (!name || box.height <= 0) continue;
        const at = Math.round(box.top + scroller.scrollTop);
        const key = `${name}@${at}`;
        if (seen.has(key)) continue;
        const count = [...found.keys()].filter((existing) => existing === name || existing.startsWith(`${name}#`)).length;
        const label = count === 0 ? name : `${name}#${count + 1}`;
        seen.set(key, label);
        const item = image.closest('li, .cm-md-block[data-list-item]');
        const itemBox = item?.getBoundingClientRect();
        found.set(label, {
          top: at,
          bottom: Math.round(box.bottom + scroller.scrollTop),
          left: Math.round(box.left),
          right: Math.round(box.right),
          // Its item shows a marker: a list item whose style draws one.
          item: itemBox ? { left: Math.round(itemBox.left), marker: getComputedStyle(item).display === 'list-item' && getComputedStyle(item).listStyleType !== 'none' } : null,
        });
      }
    }
    scroller.scrollTop = 0;
    return Object.fromEntries([...found.entries()].sort((a, b) => a[1].top - b[1].top));
  }, root);
}

/** The rows, from the picture's top, in which something is drawn in the 24
 *  pixels left of its list item: where its marker stands. */
export async function markerRows(page, root, name) {
  const clip = await page.evaluate(async ([css, wanted]) => {
    const scroller = document.querySelector('[data-detail-scroll]');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const locate = () => {
      const image = [...document.querySelectorAll(`${css} [data-detail-media-action-frame] img`)].find((candidate) => {
        const src = decodeURIComponent(candidate.getAttribute('src') ?? '');
        return src.includes(`(${wanted})`) || src.includes(`/${wanted}.`);
      });
      const item = image?.closest('li, .cm-md-block[data-list-item]');
      return image && item ? { frame: image.closest('[data-detail-media-action-frame]'), item } : null;
    };
    // The editor draws only what is near the view: walk the note to it.
    let found = locate();
    for (let top = 0; !found && top <= scroller.scrollHeight + scroller.clientHeight; top += scroller.clientHeight / 2) {
      scroller.scrollTop = top;
      await frame();
      await frame();
      found = locate();
    }
    if (!found) return null;
    // At once, never by the page's smooth scroll; the box is read once the
    // view has settled.
    found.frame.scrollIntoView({ block: 'center', behavior: 'instant' });
    await frame();
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = locate() ?? found;
    const picture = settled.frame.getBoundingClientRect();
    const itemBox = settled.item.getBoundingClientRect();
    return { x: Math.max(0, itemBox.left - 24), y: picture.top, width: 22, height: Math.min(picture.height, window.innerHeight - picture.top) };
  }, [root, name]);
  if (!clip) return null;
  const png = PNG.sync.read(await page.screenshot({ clip }));
  const ground = [png.data[0], png.data[1], png.data[2]];
  const rows = [];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (y * png.width + x) * 4;
      if (Math.abs(png.data[index] - ground[0]) + Math.abs(png.data[index + 1] - ground[1]) + Math.abs(png.data[index + 2] - ground[2]) > 60) {
        rows.push(y);
        break;
      }
    }
  }
  return rows.length === 0 ? [] : [rows[0], rows[rows.length - 1]];
}

/** The space between the bottom of `upper` and the top of `lower`. */
export function gapBetween(boxes, upper, lower) {
  const a = boxes[upper];
  const b = boxes[lower];
  return a && b ? b.top - a.bottom : null;
}
