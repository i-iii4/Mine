// The note of the reading mode's browser check (`scripts/fixtures/reading-mode.md`,
// SPEC_READING_MODE.md, Ч14) for the editor's tests: the same body both
// surfaces draw (SPEC_EDITING.md, Л11.1, Л17).

import fixture from "../../scripts/fixtures/reading-mode.md?raw";

/** The fixture's body: the file after its front matter, as the core splits it. */
export const READING_FIXTURE_BODY = fixture.replace(/^---\n[\s\S]*?\n---\n/, "");
