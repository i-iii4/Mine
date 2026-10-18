// The open card in the editor on the dev server, `/__editing` (SPEC_EDITING.md,
// Л17): `Detail` with the reading mode's fixture note behind the editor's
// switch, over a made-up backend that keeps the note's body in memory and
// checks every write against its base. The browser check of row 50.29 drives
// it through `window.__editing`; a person can try the editor in a browser
// without the app. Dev only: `main.tsx` reaches it only under `import.meta.env.DEV`.

import { useMemo } from "react";
import { DndContext } from "@dnd-kit/core";
import { Detail } from "@/components/Detail";
import { NoteEditingSwitch } from "@/components/editing/noteEditingSwitch";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { IndexedBlock, SaveNoteBodyParams } from "@/types";
import fixture from "../../scripts/fixtures/reading-mode.md?raw";

/** The note the page edits, and the note its embeds and links name. */
export const EDITING_PAGE_SLUG = "Cards/Проверка просмотрщика";
const EMBED_SLUG = "Cards/Пример заметки";

/** The fixture's body: the file after its front matter. A variant of it
 *  (line endings, a byte order mark) comes as `?body=<name>`. */
function fixtureBody(): string {
  const body = fixture.replace(/^---\n[\s\S]*?\n---\n/, "");
  const variant = new URLSearchParams(window.location.search).get("body");
  switch (variant) {
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

/** What the page's made-up backend recorded. */
interface EditingRecord {
  writes: Array<{ base: string; body: string; accepted: boolean }>;
  sessions: string[];
  calls: string[];
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
    /** A backend event to this page. */
    emit(event: string, payload: unknown): void;
  };
}

let hashes = 0;
function nextHash(): string {
  hashes += 1;
  return `hash-${hashes}`;
}

/** Install the made-up backend before anything asks it. */
function installBackend(initialBody: string) {
  // The page's window carries the made-up internals of Tauri and the handle
  // of the browser check; nothing else of the app reads these names.
  const target = window as unknown as EditingWindow;
  if (target.__editing) return;
  const record: EditingRecord = { writes: [], sessions: [], calls: [] };
  let card: IndexedBlock = {
    ...NEUTRAL_CARD,
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
  const listeners = new Map<number, { event: string; handler: number }>();
  let nextId = 1;
  const emit = (event: string, payload: unknown) => {
    for (const [id, listener] of listeners) {
      if (listener.event !== event) continue;
      callbacks.get(listener.handler)?.({ event, id, payload });
    }
  };
  const invoke = async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    record.calls.push(command);
    switch (command) {
      case "get_block":
        return args.slug === card.slug ? card : args.slug === EMBED_SLUG ? embedded : null;
      case "begin_note_edit":
        record.sessions.push(`begin ${String(args.slug)}`);
        return card;
      case "note_body_state":
        return { body_hash: card.body_hash, body: card.body };
      case "save_note_body": {
        // The editor sends `{ params }` of this shape (commands.ts).
        const params = args.params as SaveNoteBodyParams;
        const accepted = params.base_body_hash === card.body_hash;
        record.writes.push({ base: params.base_body_hash, body: params.body, accepted });
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
      case "list_card_associations":
        return { generation: 0, slug: String(args.slug), groups: [] };
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
        listeners.delete(Number(args.eventId));
        return null;
      case "plugin:log|log":
      case "plugin:clipboard-manager|write_text":
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
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => listeners.delete(id),
  };
  target.__editing = {
    record,
    body: () => card.body,
    writeFromOutside(body: string) {
      card = { ...card, body, body_hash: nextHash() };
      emit("note-changed", { slug: card.slug, body_hash: card.body_hash });
    },
    emit,
  };
}

const noop = () => undefined;

// The made-up backend stands before the page draws: `Detail` reads the card
// and the editor opens its session at once.
const PAGE_BODY = fixtureBody();
installBackend(PAGE_BODY);

/** `/__editing`: the open card in the editor over the made-up backend. */
export function EditingPage() {
  const body = PAGE_BODY;
  const card = useMemo<IndexedBlock>(() => ({
    ...NEUTRAL_CARD,
    slug: EDITING_PAGE_SLUG,
    display_title: "Проверка просмотрщика",
    fallback_label: "Проверка просмотрщика",
    body,
    body_hash: "hash-1",
  }), [body]);
  return (
    <TooltipProvider>
      <DndContext>
        <NoteEditingSwitch.Provider value>
          <div style={{ display: "flex", height: "100vh" }}>
            <main style={{ position: "relative", flex: "1", minWidth: 0 }}>
              <Detail
                block={card}
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
              />
            </main>
          </div>
        </NoteEditingSwitch.Provider>
      </DndContext>
    </TooltipProvider>
  );
}
