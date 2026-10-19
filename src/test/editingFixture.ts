// The note of the reading mode's browser check (`scripts/fixtures/reading-mode.md`,
// SPEC_READING_MODE.md, Ч14) for the editor's tests: the same body both
// surfaces draw (SPEC_EDITING.md, Л11.1, Л17). Beside it the notes of
// pictures (Ч15, Л8.6): the body of a card the clipper saved, byte for byte
// (`list-of-images.md`), and pictures in lists, paragraphs and quotes
// (`media-shapes.md`).

import fixture from "../../scripts/fixtures/reading-mode.md?raw";
import listOfImages from "../../scripts/fixtures/list-of-images.md?raw";
import mediaShapes from "../../scripts/fixtures/media-shapes.md?raw";

/** The fixture's body: the file after its front matter, as the core splits it. */
export const READING_FIXTURE_BODY = fixture.replace(/^---\n[\s\S]*?\n---\n/, "");

/** The body of a card the clipper saved: `# -`, a list of 20 pictures, GFM
 *  tables with empty cells, items with tabbed lines, HTML, links; no line
 *  break at its end. */
export const LIST_OF_IMAGES_BODY = listOfImages;

/** Pictures in lists, numbered lists, paragraphs, quotes. */
export const MEDIA_SHAPES_BODY = mediaShapes;
