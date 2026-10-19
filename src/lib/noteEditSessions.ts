// The editor's sessions as the rest of the page sees them (SPEC_EDITING.md,
// Л4.8, Л4.9). The page learns that a card was renamed or is gone from the
// news of the space (`block:renamed`, the renames of `vault-changed`, the
// answer of its own rename) and passes it on here; a session of the editor
// holds its note here and follows it. A card held by a session is not
// closed when its note leaves the index: the text stays in the editor
// (Л4.9).
//
// Kept apart from the editor so that the page reads it without taking
// CodeMirror into its own part of the bundle (Л0.6).

/** What a session hears of its note. */
export interface NoteEditHolder {
  /** The note is now `to`: the session writes and listens under that name. */
  renamed(to: string): void;
  /** The note left the index: the session asks the file what became of it. */
  missing(): void;
}

/** A session's hold of its note. */
export interface NoteEditHold {
  /** The note's slug now, after the renames the session followed. */
  readonly slug: string;
  /** The session ended. */
  release(): void;
}

interface Entry {
  slug: string;
  holder: NoteEditHolder;
}

const holds = new Map<string, Set<Entry>>();

function add(entry: Entry) {
  const set = holds.get(entry.slug) ?? new Set<Entry>();
  set.add(entry);
  holds.set(entry.slug, set);
}

function remove(entry: Entry) {
  const set = holds.get(entry.slug);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) holds.delete(entry.slug);
}

/** A session of the editor holds the note `slug` until it releases it. */
export function holdNoteForEditing(slug: string, holder: NoteEditHolder): NoteEditHold {
  const entry: Entry = { slug, holder };
  add(entry);
  let released = false;
  return {
    get slug() {
      return entry.slug;
    },
    release() {
      if (released) return;
      released = true;
      remove(entry);
    },
  };
}

/** The note `from` is now `to`: its sessions follow it (Л4.8). */
export function followNoteRename(from: string, to: string): void {
  if (from === to) return;
  const set = holds.get(from);
  if (!set) return;
  holds.delete(from);
  for (const entry of set) {
    entry.slug = to;
    add(entry);
  }
  for (const entry of set) entry.holder.renamed(to);
}

/** Whether a session of the editor holds the note `slug`. */
export function isNoteHeldForEditing(slug: string): boolean {
  return holds.has(slug);
}

/** The note `slug` left the index: its sessions ask the file (Л4.9). */
export function noteMissingFromIndex(slug: string): void {
  for (const entry of [...(holds.get(slug) ?? [])]) entry.holder.missing();
}
