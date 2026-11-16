// The stand of the card opening check (`bun run test:card-open`,
// scripts/card-open-audit.mjs; SPEC_READING_MODE.md, Ч0.5): one card of the
// feed, a light card with the start of an article of 100 KB, and the open
// card as the app draws it, `DetailView` under a Suspense boundary, loaded
// ahead of the first opening the way the app loads it (`useDetailPreload`,
// once the stand's card is painted, as the feed's first cards are).
// A press of the card opens it over a made-up backend that answers with the
// whole note, as a file read from the disk through the IPC does: serialized
// and parsed, in a task of its own after the one that asked. Every frame
// from the press is recorded: when the card showed the whole article, in the
// reading surface or in the editor. The check builds this page for
// production; no dev route leads to it.

import { Suspense, useEffect, useState } from "react";
import { DndContext } from "@dnd-kit/core";
import { DetailView, useDetailPreload, whenDetailPreloaded } from "@/components/DetailView";
import { reportCardsRendered, scheduleAfterNextPaint } from "@/lib/startup";
import type { IndexedBlock, LightBlock } from "@/types";
import { CARD_OPEN_ARTICLE_END, CARD_OPEN_ARTICLE_TITLE, cardOpenArticle } from "./cardOpenArticle";

/** The article's size: the limit of the check is given for an article of
 *  100 KB (AUDIT_PERFORMANCE.md, раздел 3, «Открытие карточки»). */
const ARTICLE_BYTES = 100 * 1024;
/** How much of its text the feed's light card carries: the index cuts it at
 *  `LIGHT_BLOCK_BODY_PREVIEW_CHARS` (storage/index.rs). */
const LIGHT_BODY_CHARS = 220;
const SLUG = "Cards/A long article";
const BODY = cardOpenArticle(ARTICLE_BYTES);

const SHARED = {
  id: 1,
  slug: SLUG,
  block_type: "article",
  card_kind: "article",
  title: null,
  content_heading: null,
  display_title: CARD_OPEN_ARTICLE_TITLE,
  fallback_label: "A long article",
  url: "https://example.test/a-long-article",
  media_file: null,
  thumbnail: null,
  saved_at: "2026-11-15T10:00:00Z",
  width: null,
  height: null,
  author: null,
  preview_text: null,
  first_image: null,
  media_urls: null,
  media_dimensions: null,
  preview_manifest: null,
  feed_playback: null,
} as const;

/** The card as the feed holds it. */
const LIGHT_CARD: LightBlock = {
  ...SHARED,
  body: BODY.slice(0, LIGHT_BODY_CHARS),
  search_match: null,
  collections: [],
};

/** The card as its file gives it. */
const WHOLE_CARD: IndexedBlock = {
  ...SHARED,
  description: null,
  source: null,
  body: BODY,
  body_hash: "hash-1",
  thumb_format: null,
  thumb_mtime: 0,
  related_notes: [],
  origin: null,
  index_warning: null,
  tags: [],
};

/** One frame after the press. */
interface OpenFrame {
  /** When the frame began and when its drawing was done, ms from the press. */
  at: number;
  drawn: number;
  /** The whole article stands in the reading surface. */
  article: boolean;
  /** The editor holds the note. */
  editor: boolean;
}

/** What the check reads from the page. */
interface CardOpenRecord {
  /** The size of the article's body in bytes of UTF-8. */
  bytes: number;
  /** The commands asked of the backend, in order, and those it does not know. */
  calls: string[];
  unknown: string[];
  /** Whether the open card's parts of the build were loaded before the press. */
  loadedBeforePress: boolean | null;
  /** The frames from the press until the editor held the note. */
  frames: OpenFrame[];
  /** Whether the recording is over. */
  done: boolean;
}

interface CardOpenWindow {
  __TAURI_INTERNALS__?: Record<string, unknown>;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
  __cardOpen?: CardOpenRecord;
}

/** What crosses Tauri's IPC is serialized there and parsed on the other
 *  side: the made-up backend does the same work in the page, so the opening
 *  pays for the note what the app pays. */
function throughIpc<T>(value: T): T {
  if (value === undefined) return value;
  // The value is the command's own answer, parsed back into its own shape.
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Resolves in a task of its own, as an answer of the IPC arrives: the page
 *  finishes the task that asked, and draws what it has, before it hears the
 *  answer. A timer would add its own delay of milliseconds. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Install the made-up backend, once, before the stand draws: after the
 *  page's entry has set the address of files up, which it keeps. What it
 *  records. */
function installBackend(): CardOpenRecord {
  // The page's window carries the made-up internals of Tauri and the handle
  // of the browser check; nothing else of the app reads these names.
  const target = window as unknown as CardOpenWindow;
  if (target.__cardOpen) return target.__cardOpen;
  const record: CardOpenRecord = {
    bytes: new TextEncoder().encode(BODY).length,
    calls: [],
    unknown: [],
    loadedBeforePress: null,
    frames: [],
    done: false,
  };
  let nextId = 1;
  const answer = (command: string, args: Record<string, unknown>): unknown => {
    switch (command) {
      case "get_block":
        return args.slug === SLUG ? WHOLE_CARD : null;
      case "begin_note_edit":
        return WHOLE_CARD;
      case "note_body_state":
        return { body_hash: WHOLE_CARD.body_hash, body: WHOLE_CARD.body };
      case "list_card_associations":
        return { generation: 0, slug: String(args.slug), groups: [] };
      case "plugin:event|listen": {
        const id = nextId;
        nextId += 1;
        return id;
      }
      case "resolve_note_link":
      case "report_note_edits":
      case "end_note_edit":
      case "report_edits_flushed":
      case "report_focused_editor":
      case "plugin:event|unlisten":
      case "plugin:log|log":
        return null;
      default:
        record.unknown.push(command);
        throw new Error(`The card opening stand has no ${command}`);
    }
  };
  target.__TAURI_INTERNALS__ = {
    ...target.__TAURI_INTERNALS__,
    invoke: async (command: string, raw: Record<string, unknown> = {}): Promise<unknown> => {
      record.calls.push(command);
      const args = throughIpc(raw);
      await nextTask();
      return throughIpc(answer(command, args));
    },
    transformCallback: () => {
      const id = nextId;
      nextId += 1;
      return id;
    },
    unregisterCallback: () => undefined,
    metadata: { currentWindow: { label: "card-open" }, currentWebview: { label: "card-open" } },
  };
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  target.__cardOpen = record;
  return record;
}

/** Whether the reading surface under `root` shows the article to its end. */
function showsWholeArticle(root: ParentNode): boolean {
  const last = root.querySelector("[data-article-body] > :last-child");
  return last?.textContent?.includes(CARD_OPEN_ARTICLE_END) === true;
}

/** Records every frame from `pressedAt` until the editor holds the note:
 *  what the card shows as the frame begins, and when the frame's drawing was
 *  done, which a task queued from the frame's callback runs right after. */
function recordFrames(record: CardOpenRecord, pressedAt: number) {
  const done = new MessageChannel();
  let frame: OpenFrame | null = null;
  done.port1.onmessage = () => {
    if (!frame) return;
    frame.drawn = performance.now() - pressedAt;
    record.frames.push(frame);
    if (frame.editor) {
      record.done = true;
      done.port1.close();
      return;
    }
    requestAnimationFrame(step);
  };
  const step = () => {
    frame = {
      at: performance.now() - pressedAt,
      drawn: 0,
      article: showsWholeArticle(document),
      editor: document.querySelector(".cm-content") !== null,
    };
    done.port2.postMessage(null);
  };
  requestAnimationFrame(step);
}

const noop = () => undefined;

/** The stand: the feed's card, and the open card over it once pressed. */
export function CardOpenAuditRoute() {
  const [record] = useState(installBackend);
  useDetailPreload();
  // The stand's card is the feed's first cards: painted, it tells the page
  // so, as the feed does (Grid.tsx).
  useEffect(() => scheduleAfterNextPaint(reportCardsRendered), []);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void whenDetailPreloaded().then(() => setLoaded(true));
  }, []);
  const [open, setOpen] = useState(false);
  return (
    <DndContext>
      <div style={{ display: "flex", height: "100vh" }}>
        <main style={{ position: "relative", flex: "1", minWidth: 0 }}>
          <button
            type="button"
            data-card-open-target=""
            data-card-open-loaded={loaded ? "" : undefined}
            style={{ margin: 40, width: 240, height: 160 }}
            onClick={() => {
              // The press as the page hears it: WebKit stamps an event on
              // another clock than the page's.
              record.loadedBeforePress = loaded;
              recordFrames(record, performance.now());
              setOpen(true);
            }}
          >
            {CARD_OPEN_ARTICLE_TITLE}
          </button>
          {open && (
            <Suspense fallback={null}>
              <DetailView
                block={LIGHT_CARD}
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
            </Suspense>
          )}
        </main>
      </div>
    </DndContext>
  );
}
