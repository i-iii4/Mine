// The open card's note in the editor (SPEC_EDITING.md, Л0.6, Л3, Л5 to Л8):
// one CodeMirror view made once per session, the body as its document, Live
// Preview over it, the reading pipeline's elements in its widgets. Every edit
// starts a write at once; edits during a write go as one next write; the
// session flushes before it ends, when the page hides and when the backend
// asks (Л3.2, Л3.9). Nothing tells that a write is under way (Л3.8); a write
// that fails says so in the tab's notice and is tried again.
//
// This module is its own part of the bundle, loaded when the editor is first
// shown (Л0.6): `Detail` reaches it only through a dynamic import.

import "@/styles/editor.css";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { history, insertNewline, standardKeymap } from "@codemirror/commands";
import { LanguageSupport } from "@codemirror/language";
import { EditorState, Prec, type Text } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import type { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { ARTICLE_ROOT_CLASSES } from "@/components/reading/ArticleMarkdown";
import {
  beginNoteEdit,
  endNoteEdit,
  noteBodyState,
  reportEditsFlushed,
  reportNoteEdits,
  saveNoteBody,
} from "@/lib/commands";
import {
  dismissActionFailure,
  NOTE_EDIT_FAILED_TITLE,
  NOTE_SAVE_FAILED_TITLE,
  reportActionFailure,
} from "@/lib/actionFailures";
import { logFailure } from "@/lib/appLog";
import { BYTE_ORDER_MARK, bodyOfState, editorBody, lineEndingExtensions, type LineEndingMode } from "@/lib/editing/lineEndings";
import { continueListMarkup, deleteListMarkup, indentListItem, outdentListItem } from "@/lib/editing/lists";
import { editorEnvironment, livePreview, omittedEmbedField, type EditorEnvironment, type EditorLinkStatus } from "@/lib/editing/livePreview";
import { externalChange, externalChangeSpec } from "@/lib/editing/reloadDiff";
import { SaveQueue, type SaveAnswer } from "@/lib/editing/saveQueue";
import { mineMarkdownLanguage } from "@/lib/editing/syntax";
import { listenPage } from "@/lib/pageEvents";
import { preprocessWikilinksWithMap, type PreprocessedBody } from "@/lib/markdownWikilinks";
import { cn } from "@/lib/utils";
import type { FlushEditsPayload, IndexedBlock, NoteChangedPayload, NoteEditError } from "@/types";
import { EditorWidgets, WidgetPortals, type EditorArticleHost } from "./EditorWidgets";
import { asNoteSaveError, noteEditErrorLine, noteSaveDisposition, noteSaveErrorLine } from "./noteEditMessages";

/** The log lines of the session's quiet failures. */
export const NOTE_CONFLICT_LOG = "The note changed outside the editor";
export const NOTE_SESSION_LOG = "Could not report the edit session";

/** The class of the editor's root: `editor.css` styles by it. */
const EDITOR_ROOT_CLASS = "mine-note-editor";

/** The special signs CodeMirror shows, without the `\r` that ends a line of
 *  a mixed body: Live Preview hides that one (Л0.3, Л0.4). */
// eslint-disable-next-line no-control-regex -- control signs are what it finds: CodeMirror's own list less one sign.
const SPECIAL_CHARS = /[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]|\r(?!$)/gu;

/** CodeMirror's own look gives way to the article's (Л15): no padding of its
 *  own, the system caret in the text's colour, no outline in focus, special
 *  signs in the secondary step. */
const editorTheme = EditorView.theme({
  "&": { color: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  // The editor grows with its text inside the open card's own scroll; a
  // wide block scrolls inside itself, it never widens the column.
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "currentColor", fontFamily: "inherit", minWidth: "0" },
  ".cm-line": { padding: "0" },
  ".cm-specialChar": { color: "var(--muted-foreground)" },
});

/** The keys of the editor (Л12): lists, then CodeMirror's motions and
 *  deletions; Enter of `standardKeymap` would re-indent, a plain line break
 *  keeps the bytes as typed. */
const editorKeymap = Prec.high(keymap.of([
  { key: "Enter", run: continueListMarkup },
  { key: "Enter", run: insertNewline },
  { key: "Backspace", run: deleteListMarkup },
  { key: "Tab", run: indentListItem },
  { key: "Shift-Tab", run: outdentListItem },
]));

const motionKeymap = keymap.of(standardKeymap.filter((binding) => binding.key !== "Enter"));

/** A card with its whole body read and hashed: what a session edits. */
type EditableCard = IndexedBlock & { body_hash: string };

function isEditable(block: IndexedBlock): block is EditableCard {
  return block.body_hash !== null;
}

/** The line of a card whose body came without its hash. */
const NO_BODY_HASH = "The note came without the hash of its text.";

/** A write's answer as the queue reads it, with the card it carries. */
interface NoteSaveAnswer extends SaveAnswer {
  block: IndexedBlock;
}

export interface NoteEditorProps {
  slug: string;
  /** The card's body and its hash as the open card shows them: a newer one
   *  read from the file is applied while the session has no unsaved edits
   *  (Л4.2). */
  body: string;
  bodyHash: string;
  /** The note's file name, for the field's label (Л16). */
  fileName: string;
  vaultPath: string;
  thumbsRootPath: string;
  noteEmbeds: NoteEmbedLookups;
  /** The host's picture and video of the body (Р5, Р6). */
  image: ComponentType<ComponentProps<"img"> & ExtraProps>;
  onOpenNote: (slug: string) => void;
  /** A write went through: the card read anew, for the panel and the
   *  chrome (Л3.7). */
  onSaved: (block: IndexedBlock) => void;
  /** Where the embed shown above the body starts, as a position of the body
   *  as written (Л2.7). */
  omittedEmbed: number | null;
  /** Shown while the session opens, and when it cannot (Л2.8). */
  fallback: ReactNode;
  className?: string;
}

function asNoteEditError(error: unknown): NoteEditError {
  if (error && typeof error === "object" && "kind" in error && typeof error.kind === "string") {
    // `beginNoteEdit` and `noteBodyState` reject only with a `NoteEditError`.
    return error as NoteEditError;
  }
  return { kind: "internal", message: error instanceof Error ? error.message : String(error) };
}

/** Where position `pos` of a document stands in its body as a string:
 *  a `\r\n` line break counts one position and two signs. */
function bodyStringOffset(doc: Text, pos: number, mode: LineEndingMode, bom: boolean): number {
  const extra = mode === "crlf" ? doc.lineAt(pos).number - 1 : 0;
  return pos + extra + (bom ? 1 : 0);
}

/** Where a position of the body stands after `preprocessWikilinks`, by its
 *  list of rewrites; `null` inside a rewritten wikilink. */
function renderedOffset(processed: PreprocessedBody, source: number): number | null {
  let delta = 0;
  for (const rewrite of processed.rewrites) {
    if (source < rewrite.sourceStart) break;
    if (source === rewrite.sourceStart) return rewrite.renderedStart;
    if (source < rewrite.sourceEnd) return null;
    delta = rewrite.renderedEnd - rewrite.sourceEnd;
  }
  return source + delta;
}

/**
 * The open card's note in the editor. It opens the tab's edit session with
 * `begin_note_edit`, which answers the body from disk; until then, and when
 * the note cannot be edited, it shows `fallback`.
 */
export function NoteEditor(props: NoteEditorProps) {
  const { slug } = props;
  const [opened, setOpened] = useState<{ slug: string; block: EditableCard } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    beginNoteEdit(slug).then(
      (block) => {
        if (!current) {
          // The card went before the session opened: it ends at once.
          void endNoteEdit(slug).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
          return;
        }
        if (!isEditable(block)) {
          void endNoteEdit(slug).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
          reportActionFailure({ kind: "note-edit", title: NOTE_EDIT_FAILED_TITLE, messages: [NO_BODY_HASH] });
          setRefused(slug);
          return;
        }
        dismissActionFailure("note-edit");
        setOpened({ slug, block });
      },
      (error: unknown) => {
        if (!current) return;
        const line = noteEditErrorLine(asNoteEditError(error));
        if (line) reportActionFailure({ kind: "note-edit", title: NOTE_EDIT_FAILED_TITLE, messages: [line] });
        setRefused(slug);
      },
    );
    return () => {
      current = false;
    };
  }, [slug]);

  if (refused === slug || opened?.slug !== slug) return <>{props.fallback}</>;
  return <EditorSession key={slug} {...props} opened={opened.block} />;
}

/** One edit session: the view, its queue and what it hears. */
function EditorSession({ opened, ...props }: NoteEditorProps & { opened: EditableCard }) {
  const { slug } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const portals = useMemo(() => new WidgetPortals(), []);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const sessionRef = useRef<{
    queue: SaveQueue<NoteSaveAnswer>;
    view: EditorView;
    bom: boolean;
    mode: LineEndingMode;
    takeBody(bodyHash: string, body: string): void;
  } | null>(null);

  // The session opened with `opened`; a view made again for it (React's
  // second run of effects in development) opens it again once the first
  // view's end has closed it.
  const madeOnce = useRef(false);
  const lastEnd = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return undefined;
    if (madeOnce.current) {
      void lastEnd.current.then(() => beginNoteEdit(slug)).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
    }
    madeOnce.current = true;
    const loaded = editorBody(opened.body);
    let reportedUnsaved = false;
    let ended = false;
    const report = (unsaved: boolean) => {
      if (unsaved === reportedUnsaved || ended) return;
      reportedUnsaved = unsaved;
      void reportNoteEdits(slug, unsaved).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
    };
    const links: EditorLinkStatus = {
      missing: (note) => latest.current.noteEmbeds.lookup(note).state === "missing",
      request: (note) => latest.current.noteEmbeds.request(note),
      subscribe: (listener) => latest.current.noteEmbeds.subscribe(listener),
    };
    const environment: EditorEnvironment = {
      host: portals,
      links,
      idPrefix: `mine-editor-${Math.random().toString(36).slice(2)}`,
      columnWidth: 0,
    };
    // The view is made below; the queue reads it only after an edit. Once
    // the view is gone the queue reads the body it held last.
    let editor: EditorView | null = null;
    let lastBody = opened.body;
    const readBody = () => (editor ? bodyOfState(editor.state, loaded.bom) : lastBody);
    const queue = new SaveQueue<NoteSaveAnswer>(opened.body_hash, opened.body, {
      save: async (request) => {
        const saved = await saveNoteBody({
          source_slug: slug,
          base_body_hash: request.baseBodyHash,
          body: request.body,
        });
        if (saved.block.body_hash === null) throw new Error(NO_BODY_HASH);
        return {
          bodyHash: saved.block.body_hash,
          body: saved.block.body,
          splitChanged: saved.split_changed,
          unchanged: saved.unchanged,
          block: saved.block,
        };
      },
      classify: (error) => noteSaveDisposition(asNoteSaveError(error)),
      readBody,
      onSaved: (answer) => {
        // The split of the file changed (Л2.4): the document becomes the
        // answer's body; the caret and the history go on through it.
        if (answer.splitChanged && editor && !ended) {
          const text = loaded.bom && answer.body.startsWith(BYTE_ORDER_MARK) ? answer.body.slice(1) : answer.body;
          editor.dispatch(externalChangeSpec(editor.state, text));
        }
        latest.current.onSaved(answer.block);
        if (!queue.dirty) report(false);
      },
      onFailed: (error) => {
        reportActionFailure({
          kind: "note-save",
          title: NOTE_SAVE_FAILED_TITLE,
          messages: [noteSaveErrorLine(asNoteSaveError(error))],
        });
      },
      // How a conflict is shown waits for the user's decision ЛВ2 (а): until
      // then the queue stops, the text and the file stay, the log says why.
      onConflict: (error) => logFailure(NOTE_CONFLICT_LOG, error),
      onRecovered: () => dismissActionFailure("note-save"),
    });

    /** The file's body came from outside (Л4.2, Л4.3): applied without a
     *  question while the session has nothing unsaved, a conflict
     *  otherwise. */
    const takeBody = (bodyHash: string, body: string) => {
      if (!editor || ended || bodyHash === queue.base) return;
      if (queue.state === "saving" || queue.dirty) {
        queue.enterConflict({ kind: "changed", source_slug: slug });
        return;
      }
      const text = loaded.bom && body.startsWith(BYTE_ORDER_MARK) ? body.slice(1) : body;
      editor.dispatch(externalChangeSpec(editor.state, text));
      queue.rebase(bodyHash, body);
    };

    let composing = false;
    editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: loaded.text,
        extensions: [
          editorEnvironment.of(environment),
          lineEndingExtensions(loaded.mode),
          new LanguageSupport(mineMarkdownLanguage),
          history(),
          highlightSpecialChars({ specialChars: SPECIAL_CHARS }),
          EditorView.lineWrapping,
          livePreview(),
          omittedEmbedField.init(() => latest.current.omittedEmbed),
          editorKeymap,
          motionKeymap,
          editorTheme,
          EditorView.editorAttributes.of({ class: EDITOR_ROOT_CLASS }),
          EditorView.contentAttributes.of({
            class: cn(ARTICLE_ROOT_CLASSES, "leading-5"),
            "data-content-font": "",
            "aria-label": `Text of ${latest.current.fileName}`,
          }),
          EditorView.updateListener.of((update) => {
            if (update.view.composing !== composing) {
              composing = update.view.composing;
              queue.setComposing(composing);
            }
            if (!update.docChanged) return;
            const own = update.transactions.some((tr) => tr.docChanged && tr.annotation(externalChange) !== true);
            if (!own) return;
            queue.edited();
            report(true);
          }),
        ],
      }),
    });
    const created = editor;
    sessionRef.current = { queue, view: created, bom: loaded.bom, mode: loaded.mode, takeBody };
    setView(created);

    // The backend's flush (Л3.9): write now, then answer.
    const flushRequests = listenPage<FlushEditsPayload>("flush-edits", (event) => {
      void queue.flush().finally(() => {
        void reportEditsFlushed(event.payload.request_id).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
      });
    });
    // The file changed outside the session (Л4.1).
    const changes = listenPage<NoteChangedPayload>("note-changed", (event) => {
      const { slug: changed, body_hash } = event.payload;
      if (changed !== slug || body_hash === queue.base) return;
      void noteBodyState(slug).then(
        (state) => takeBody(state.body_hash, state.body),
        (error: unknown) => logFailure(NOTE_CONFLICT_LOG, error),
      );
    });
    // The window came back: a failed write is tried again, and the file is
    // asked whether it changed meanwhile (Л3.8, Л4.1).
    const onFocus = () => {
      queue.retry();
      void noteBodyState(slug).then(
        (state) => takeBody(state.body_hash, state.body),
        (error: unknown) => logFailure(NOTE_CONFLICT_LOG, error),
      );
    };
    // The page hides: its edits go to the file now (Л3.2).
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void queue.flush();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      void flushRequests.then((unlisten) => unlisten(), (error: unknown) => logFailure(NOTE_SESSION_LOG, error));
      void changes.then((unlisten) => unlisten(), (error: unknown) => logFailure(NOTE_SESSION_LOG, error));
      // The session ends after its last write (Л3.2): the queue keeps the
      // body the view held, the view can go now.
      lastBody = bodyOfState(created.state, loaded.bom);
      ended = true;
      editor = null;
      sessionRef.current = null;
      lastEnd.current = queue.flush().finally(() => {
        queue.dispose();
        return endNoteEdit(slug).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
      });
      created.destroy();
    };
    // The session is made once per note (the component is keyed by it):
    // later props reach it through `latest`.
  }, [opened, portals, slug]);

  // The card from disk the session opened with goes to the open card: the
  // index caught up with the file (Л2.8).
  useEffect(() => {
    latest.current.onSaved(opened);
  }, [opened]);

  // A newer card from the file (`vault-refreshed`) after the session opened:
  // its body is applied when the session has nothing unsaved (Л4.2).
  const { body, bodyHash } = props;
  const firstCard = useRef<{ body: string; bodyHash: string } | null>({ body, bodyHash });
  useEffect(() => {
    const first = firstCard.current;
    firstCard.current = null;
    if (first && first.body === body && first.bodyHash === bodyHash) return;
    sessionRef.current?.takeBody(bodyHash, body);
  }, [body, bodyHash]);

  const host = useMemo<EditorArticleHost>(() => {
    const cache = new WeakMap<Text, PreprocessedBody>();
    return {
      sourceSlug: slug,
      vaultPath: props.vaultPath,
      thumbsRootPath: props.thumbsRootPath,
      noteEmbeds: props.noteEmbeds,
      image: props.image,
      onOpenNote: props.onOpenNote,
      renderedOffsetOf: (pos) => {
        const session = sessionRef.current;
        if (!session) return null;
        const doc = session.view.state.doc;
        let processed = cache.get(doc);
        if (!processed) {
          processed = preprocessWikilinksWithMap(bodyOfState(session.view.state, session.bom));
          cache.set(doc, processed);
        }
        return renderedOffset(processed, bodyStringOffset(doc, Math.min(pos, doc.length), session.mode, session.bom));
      },
    };
  }, [props.image, props.noteEmbeds, props.onOpenNote, props.thumbsRootPath, props.vaultPath, slug]);

  return (
    <>
      <div ref={parentRef} className={props.className} data-note-editor={slug} />
      <EditorWidgets portals={portals} view={view} host={host} />
    </>
  );
}
