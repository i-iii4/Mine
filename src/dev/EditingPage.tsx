// The open card on the dev server, `/__editing` (SPEC_EDITING.md, Л17):
// `Detail` with the reading mode's fixture note, opened as the app opens it,
// straight in the editor (Л1, the user's decision of 18.10.2026 on ЛВ1), over
// a made-up backend that keeps the note's body in memory and checks every
// write against its base. The browser check of row 50.29 drives it through
// `window.__editing`; a person can try the editor in a browser without the
// app. The performance check of row 50.28 builds this page for production
// and measures the editor on it (Л14). Dev only: `main.tsx` reaches it only
// under `import.meta.env.DEV`.
//
// `?body=` picks the note (a variant of the fixture, a table case, a set of
// the performance check), `?theme=light|dark` the theme, `?editing=off`
// starts with the editor turned off (the reading surface, for comparison),
// `?open=off` with no card open, `?refuse=in_cloud|read_only|source_not_found|not_a_card`
// makes `begin_note_edit` refuse the note (Л2.8), `?card=collection` makes
// the card a collection page (Л2.5).

import { useContext, useSyncExternalStore, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { ActionFailureNoticeStack } from "@/components/ActionFailureNotices";
import { Detail } from "@/components/Detail";
import { NoteEditingSwitch } from "@/components/editing/noteEditingSwitch";
import { NotificationAnchor } from "@/components/NotificationCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MineTextSelectionDragPayload } from "@/lib/textSelectionDrag";
import type { FocusedEditor, IndexedBlock, NoteEditError, NoteLinkQuery, SaveNoteBodyParams } from "@/types";
import fixture from "../../scripts/fixtures/reading-mode.md?raw";
import listOfImages from "../../scripts/fixtures/list-of-images.md?raw";
import mediaShapes from "../../scripts/fixtures/media-shapes.md?raw";
import { editingEditorHandle, type EditingEditorHandle } from "./editingEditorHandle";
import { perfSetBody } from "./editingPerfSets";
import { editingTableHandle, tableCaseBody, type EditingTableHandle } from "./editingTables";

/** The note the page edits, and the note its embeds and links name. */
export const EDITING_PAGE_SLUG = "Cards/Проверка просмотрщика";
const EMBED_SLUG = "Cards/Пример заметки";

/** The fixture's body: the file after its front matter. A variant of it
 *  (line endings, a byte order mark), a table case (`tables`,
 *  `tables-crlf`, `large-table`, `wide-table`, `editingTables.ts`), a set
 *  of the performance check (`editingPerfSets.ts`) or a note of pictures
 *  (`list-of-images`, the body of a card the clipper saved, byte for byte;
 *  `media-shapes`, pictures in lists, paragraphs and quotes) comes as
 *  `?body=<name>`. */
function fixtureBody(): string {
  const body = fixture.replace(/^---\n[\s\S]*?\n---\n/, "");
  const variant = new URLSearchParams(window.location.search).get("body");
  const generated = tableCaseBody(variant) ?? perfSetBody(variant);
  if (generated !== null) return generated;
  switch (variant) {
    case "list-of-images":
      return listOfImages;
    case "media-shapes":
      return mediaShapes;
    case "crlf":
      return body.replace(/\n/g, "\r\n");
    case "mixed":
      return body.split("\n").map((line, index) => (index % 2 === 0 ? `${line}\r` : line)).join("\n");
    case "bom":
      return `\uFEFF${body}`;
    case "no-final-newline":
      return body.replace(/\n+$/, "");
    default:
      return body;
  }
}

const NEUTRAL_CARD: Omit<IndexedBlock, "slug" | "body" | "body_hash" | "display_title" | "fallback_label"> = {
  id: 1,
  block_type: "article",
  card_kind: "article",
  title: null,
  content_heading: null,
  description: null,
  url: null,
  media_file: null,
  thumbnail: null,
  saved_at: "2026-10-18T14:23:24Z",
  source: null,
  width: null,
  height: null,
  author: null,
  preview_text: null,
  first_image: null,
  media_urls: null,
  media_dimensions: null,
  preview_manifest: null,
  feed_playback: null,
  thumb_format: null,
  thumb_mtime: 0,
  related_notes: [],
  origin: null,
  index_warning: null,
  tags: [],
};

/** What a check switches on the page: the editor off for a look at the
 *  reading surface (the app never turns it off), the open card, or none,
 *  and the place it opened at (Л11.8). */
interface PageControls {
  editing: boolean;
  card: IndexedBlock | null;
  anchor: string | null;
}

let controls: PageControls = {
  editing: new URLSearchParams(window.location.search).get("editing") !== "off",
  card: null,
  anchor: null,
};
const controlListeners = new Set<() => void>();

function setControls(next: Partial<PageControls>) {
  controls = { ...controls, ...next };
  for (const listener of controlListeners) listener();
}

function subscribeControls(listener: () => void): () => void {
  controlListeners.add(listener);
  return () => {
    controlListeners.delete(listener);
  };
}

/** What crosses Tauri's IPC is serialized there and parsed on the other
 *  side: the made-up backend does the same work in the page, so a check of
 *  the page pays for a body of megabytes what the app pays (Л14.3), and an
 *  answer is a copy of its own. */
function throughIpc<T>(value: T): T {
  if (value === undefined) return value;
  // The value is the command's own answer, parsed back into its own shape.
  return JSON.parse(JSON.stringify(value)) as T;
}

/** What the page's made-up backend recorded. */
interface EditingRecord {
  /** Every write with its base, whether it went over it and its length;
   *  the body only of the last one: a check of a note of megabytes would
   *  otherwise hold every body it typed (Л14). */
  writes: Array<{ base: string; accepted: boolean; length: number; body?: string }>;
  sessions: string[];
  calls: string[];
  /** What went to the system's clipboard as HTML with its text (Л9.7). */
  clipboard: Array<{ html: string; text: string }>;
  /** Selections dropped to make an element of, with the collection (Л11.2). */
  extractions: Array<{ payload: MineTextSelectionDragPayload; tag: string }>;
  /** What the page told the Edit menu of its editor's focus, in order (Л12). */
  focusReports: Array<FocusedEditor | null>;
}

type EventHandler = (event: { event: string; id: number; payload: unknown }) => void;

interface EditingWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
  __editing?: {
    record: EditingRecord;
    /** The body the made-up file holds now. */
    body(): string;
    /** The file changed outside Mine: `note-changed` follows. */
    writeFromOutside(body: string): void;
    /** The file went (Л4.9): reads and writes find no note; a later
     *  `writeFromOutside` brings it back. */
    removeFile(): void;
    /** A backend event to this page. */
    emit(event: string, payload: unknown): void;
    /** The table editor (Л9). */
    table: EditingTableHandle;
    /** The note's editor: its document, its selection (Л17). */
    editor: EditingEditorHandle;
    /** The editor turned off, the card shows its article, or back on as the
     *  app has it. */
    setEditing(on: boolean): void;
    /** The card open, as the file holds it now, or closed: closed, nothing
     *  of it stays drawn. */
    setOpen(on: boolean): void;
    /** Open the card at the place after `#` of a link (Л11.8). */
    jump(anchor: string | null): void;
    /** How long a write takes to answer, as a disk and the IPC would. */
    setSaveDelay(ms: number): void;
  };
}

let hashes = 0;
function nextHash(): string {
  hashes += 1;
  return `hash-${hashes}`;
}

/** Install the made-up backend before anything asks it; what it records. */
function installBackend(initialBody: string): EditingRecord {
  // The page's window carries the made-up internals of Tauri and the handle
  // of the browser check; nothing else of the app reads these names.
  const target = window as unknown as EditingWindow;
  if (target.__editing) return target.__editing.record;
  const record: EditingRecord = { writes: [], sessions: [], calls: [], clipboard: [], extractions: [], focusReports: [] };
  const query = new URLSearchParams(window.location.search);
  const refusal = refusalOf(query.get("refuse"));
  const collection = query.get("card") === "collection";
  let card: IndexedBlock = {
    ...NEUTRAL_CARD,
    ...(collection ? { block_type: "channel" as const, card_kind: "channel" as const } : {}),
    slug: EDITING_PAGE_SLUG,
    display_title: "Проверка просмотрщика",
    fallback_label: "Проверка просмотрщика",
    body: initialBody,
    body_hash: nextHash(),
  };
  const embedded: IndexedBlock = {
    ...NEUTRAL_CARD,
    id: 2,
    slug: EMBED_SLUG,
    display_title: "Пример заметки",
    fallback_label: "Пример заметки",
    body: "Текст примера заметки.",
    preview_text: "Текст примера заметки.",
    body_hash: "hash-embed",
  };
  const notes: Record<string, string> = { "Пример заметки": EMBED_SLUG, "Проверка просмотрщика": EDITING_PAGE_SLUG };
  const callbacks = new Map<number, EventHandler>();
  let gone = false;
  let saveDelayMs = 0;
  const listeners = new Map<number, { event: string; handler: number }>();
  let nextId = 1;
  // A listener that goes takes its callback with it, as Tauri's own event
  // plugin does: a closed card's session is not kept alive by the page.
  const forget = (id: number) => {
    const listener = listeners.get(id);
    if (listener) callbacks.delete(listener.handler);
    listeners.delete(id);
  };
  const emit = (event: string, payload: unknown) => {
    for (const [id, listener] of listeners) {
      if (listener.event !== event) continue;
      callbacks.get(listener.handler)?.({ event, id, payload });
    }
  };
  const invoke = async (command: string, raw: Record<string, unknown> = {}): Promise<unknown> => {
    record.calls.push(command);
    const args = throughIpc(raw);
    return throughIpc(await answer(command, args));
  };
  const answer = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (command) {
      case "get_block":
        return args.slug === card.slug ? card : args.slug === EMBED_SLUG ? embedded : null;
      case "begin_note_edit":
        record.sessions.push(`begin ${String(args.slug)}`);
        if (refusal) throw refusal;
        return card;
      case "note_body_state":
        if (gone) throw { kind: "source_not_found", source_slug: card.slug };
        return { body_hash: card.body_hash, body: card.body };
      case "save_note_body": {
        // The editor sends `{ params }` of this shape (commands.ts).
        const params = args.params as SaveNoteBodyParams;
        if (gone) throw { kind: "source_not_found", source_slug: card.slug };
        if (saveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
        const accepted = params.base_body_hash === card.body_hash;
        const last = record.writes[record.writes.length - 1];
        if (last) delete last.body;
        record.writes.push({ base: params.base_body_hash, accepted, length: params.body.length, body: params.body });
        if (!accepted) {
          throw { kind: "stale_body", source_slug: card.slug, disk_body: card.body, disk_body_hash: card.body_hash };
        }
        const unchanged = params.body === card.body;
        if (!unchanged) card = { ...card, body: params.body, body_hash: nextHash() };
        return { block: card, split_changed: false, unchanged };
      }
      case "report_note_edits":
        record.sessions.push(`unsaved ${String(args.unsaved)}`);
        return null;
      case "end_note_edit":
        record.sessions.push(`end ${String(args.slug)}`);
        return null;
      case "report_edits_flushed":
        record.sessions.push(`flushed ${String(args.request_id)}`);
        return null;
      case "report_focused_editor":
        // The page sends `{ editor }` of this shape (commands.ts).
        record.focusReports.push((args.editor ?? null) as FocusedEditor | null);
        return null;
      case "list_card_associations":
        return { generation: 0, slug: String(args.slug), groups: [] };
      case "suggest_note_links": {
        // The `[[` menu (Л10.2): the page's two notes by a plain match of
        // their names; headings and blocks are the backend's to find.
        // The editor sends `{ sourceSlug, query }` of this shape (commands.ts).
        const query = args.query as NoteLinkQuery;
        if (query.kind !== "notes") return [];
        const text = query.text.toLocaleLowerCase();
        return Object.entries(notes)
          .filter(([name]) => name.toLocaleLowerCase().includes(text))
          .map(([name, slug]) => {
            const start = text ? name.toLocaleLowerCase().indexOf(text) : 0;
            return { label: name, detail: "Cards", target: name, slug, matches: text ? [{ start, end: start + text.length }] : [] };
          });
      }
      case "resolve_note_link": {
        const raw = String(args.rawTarget ?? "");
        return notes[raw.split("#")[0] ?? raw] ?? null;
      }
      case "plugin:event|listen": {
        const id = nextId;
        nextId += 1;
        listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
        return id;
      }
      case "plugin:event|unlisten":
        forget(Number(args.eventId));
        return null;
      case "plugin:log|log":
      case "plugin:clipboard-manager|write_text":
        return null;
      case "plugin:clipboard-manager|write_html":
        record.clipboard.push({ html: String(args.html ?? ""), text: String(args.altText ?? "") });
        return null;
      default:
        throw new Error(`The editing page has no ${command}`);
    }
  };
  target.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback: EventHandler) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (path: string) => `${location.origin}/media/${encodeURIComponent(path.split("/").pop() ?? path)}`,
    metadata: { currentWindow: { label: "editing" }, currentWebview: { label: "editing" } },
  };
  if (new URLSearchParams(window.location.search).get("open") !== "off") controls = { ...controls, card };
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => forget(id),
  };
  target.__editing = {
    record,
    body: () => card.body,
    writeFromOutside(body: string) {
      gone = false;
      card = { ...card, body, body_hash: nextHash() };
      emit("note-changed", { slug: card.slug, body_hash: card.body_hash });
    },
    removeFile() {
      gone = true;
    },
    emit,
    table: editingTableHandle(),
    editor: editingEditorHandle(),
    setEditing: (on) => setControls({ editing: on }),
    setOpen: (on) => setControls({ card: on ? card : null }),
    jump: (anchor) => setControls({ anchor }),
    setSaveDelay(ms) {
      saveDelayMs = ms;
    },
  };
  return record;
}

/** The refusal of `begin_note_edit` that `?refuse=` names (Л2.8). */
function refusalOf(kind: string | null): NoteEditError | null {
  const fileName = "Проверка просмотрщика.md";
  switch (kind) {
    case "in_cloud":
      return { kind: "in_cloud", file_name: fileName };
    case "read_only":
      return { kind: "read_only", file_name: fileName };
    case "source_not_found":
      return { kind: "source_not_found", source_slug: EDITING_PAGE_SLUG };
    case "not_a_card":
      return { kind: "not_a_card", source_slug: EDITING_PAGE_SLUG };
    default:
      return null;
  }
}

/** The editor as the app has it, or off where a check looks at the reading
 *  surface: the page never turns it on itself, so it opens the way the app
 *  opens a card. */
function EditorSurface({ off, children }: { off: boolean; children: ReactNode }) {
  const inherited = useContext(NoteEditingSwitch);
  return <NoteEditingSwitch.Provider value={off ? false : inherited}>{children}</NoteEditingSwitch.Provider>;
}

/** The page's theme: `?theme=light|dark`, else the system's. */
function applyTheme() {
  const theme = new URLSearchParams(window.location.search).get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
}

const noop = () => undefined;

// The made-up backend stands before the page draws: `Detail` reads the card
// and the editor opens its session at once.
const PAGE_RECORD = installBackend(fixtureBody());
applyTheme();

/** A selection dropped to make an element of (Л11.2): the page notes it. */
function recordExtraction(payload: MineTextSelectionDragPayload, tag: string) {
  PAGE_RECORD.extractions.push({ payload, tag });
}

/** `/__editing`: the open card in the editor over the made-up backend. */
export function EditingPage() {
  const { editing, card, anchor } = useSyncExternalStore(subscribeControls, () => controls, () => controls);
  return (
    <TooltipProvider>
      <DndContext>
        <EditorSurface off={!editing}>
          <div style={{ display: "flex", height: "100vh" }}>
            <main style={{ position: "relative", flex: "1", minWidth: 0 }}>
              {card && <Detail
                block={card}
                scrollAnchor={anchor}
                vaultPath="/vault"
                thumbsRootPath="/thumbs"
                tags={[]}
                onClose={noop}
                onNavigate={noop}
                onToggleTag={noop}
                onCreateAndAssign={noop}
                onTagsChanged={noop}
                onRequestRename={noop}
                onRequestDelete={noop}
                onOpenRelatedNote={noop}
                onTextSelectionDrop={recordExtraction}
              />}
            </main>
          </div>
          {/* The tab's notices, as the app stacks them: refusals, failed
              writes, conflicts (Л2.8, Л3.8, Л4.3). */}
          <NotificationAnchor>
            <div className="grid justify-items-end gap-2">
              <ActionFailureNoticeStack />
            </div>
          </NotificationAnchor>
        </EditorSurface>
      </DndContext>
    </TooltipProvider>
  );
}
