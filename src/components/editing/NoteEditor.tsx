// The open card's note in the editor (SPEC_EDITING.md, Л0.6, Л3 to Л8, Л10,
// Л11): one CodeMirror view made once per session, the body as its document,
// Live Preview over it, the reading pipeline's elements in its widgets. Every
// edit starts a write at once; edits during a write go as one next write; the
// session flushes before it ends, when the page hides and when the backend
// asks (Л3.2, Л3.9). Nothing tells that a write is under way (Л3.8); a write
// that fails says so in the tab's notice and is tried again. The file's own
// changes come in by themselves while nothing is unsaved, and never overwrite
// unsaved edits (Л4); the session follows its note through a rename and holds
// its text when the note is gone (Л4.8, Л4.9).
//
// This module is its own part of the bundle, loaded when the editor is first
// shown (Л0.6): `Detail` reaches it only through a dynamic import.

import "@/styles/editor.css";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { history, insertNewline, standardKeymap } from "@codemirror/commands";
import { LanguageSupport, syntaxTree } from "@codemirror/language";
import { EditorState, Prec, type Text } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import type { NoteEmbedLookups } from "@/components/reading/NoteEmbed";
import { ARTICLE_ROOT_CLASSES, NOTE_LINK_LOOKUP_FAILED_TITLE } from "@/components/reading/ArticleMarkdown";
import {
  beginNoteEdit,
  endNoteEdit,
  noteBodyState,
  reportEditsFlushed,
  reportNoteEdits,
  resolveNoteLink,
  saveNoteBody,
  suggestNoteLinks,
} from "@/lib/commands";
import {
  dismissActionFailure,
  NOTE_EDIT_FAILED_TITLE,
  NOTE_SAVE_FAILED_TITLE,
  reportActionFailure,
} from "@/lib/actionFailures";
import { logFailure } from "@/lib/appLog";
import { computeBodyHash } from "@/lib/editing/bodyHash";
import {
  BYTE_ORDER_MARK,
  bodyByteOffset,
  bodyOfState,
  documentLineSeparator,
  editorBody,
  lineEndingExtensions,
  type LineEndingMode,
} from "@/lib/editing/lineEndings";
import { editorLinkHost, linkClicks } from "@/lib/editing/links";
import { linkSuggestHost, linkSuggestions, type LinkQuery, type LinkSuggestion } from "@/lib/editing/linkSuggest";
import { continueListMarkup, deleteListMarkup, indentListItem, outdentListItem } from "@/lib/editing/lists";
import { editorEnvironment, livePreview, omittedEmbedField, type EditorEnvironment, type EditorLinkStatus } from "@/lib/editing/livePreview";
import { externalChange, externalChangeSpec } from "@/lib/editing/reloadDiff";
import { revealField } from "@/lib/editing/reveal";
import { SaveQueue, type SaveAnswer } from "@/lib/editing/saveQueue";
import { mineMarkdownLanguage, NODE } from "@/lib/editing/syntax";
import { safeMarkdownUrl } from "@/lib/markdownUrl";
import { holdNoteForEditing } from "@/lib/noteEditSessions";
import { listenPage } from "@/lib/pageEvents";
import { matchHeading, parseArticleAnchor, sourceHeadings, type ArticleAnchor } from "@/lib/reading/anchors";
import { openLinkInBrowser } from "@/lib/systemActions";
import type { MineTextSelectionDragPayload } from "@/lib/textSelectionDrag";
import { cn } from "@/lib/utils";
import type { FlushEditsPayload, IndexedBlock, NoteChangedPayload, NoteEditError, NoteSaveError } from "@/types";
import { EditorWidgets, WidgetPortals, type EditorArticleHost } from "./EditorWidgets";
import { asNoteSaveError, noteEditErrorLine, noteSaveDisposition, noteSaveErrorLine } from "./noteEditMessages";

/** The log lines of the session's quiet failures. */
export const NOTE_CONFLICT_LOG = "The note changed outside the editor";
export const NOTE_SESSION_LOG = "Could not report the edit session";
export const NOTE_SUGGEST_LOG = "Could not suggest note links";

/** The class of the editor's root: `editor.css` styles by it. */
const EDITOR_ROOT_CLASS = "mine-note-editor";

/** The special signs CodeMirror shows, without the `\r` that ends a line of
 *  a mixed body: Live Preview hides that one (Л0.3, Л0.4). */
// eslint-disable-next-line no-control-regex -- control signs are what it finds: CodeMirror's own list less one sign.
const SPECIAL_CHARS = /[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202d\u202e\u2066\u2067\u2069\ufeff\ufff9-\ufffc]|\r(?!$)/gu;

/** Addresses the browser opens from a link of the note (Л10.1). */
const BROWSER_SCHEMES = /^(?:https?|mailto):/i;

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

/** The selection of the editor as the open card's action bar takes it
 *  (Л11.2): the exact range of the body in bytes, the place of its first
 *  line on screen and the editor's text box. */
export interface EditorTextSelection {
  payload: MineTextSelectionDragPayload;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  root: HTMLElement;
  /** The bar was dismissed: the selection collapses to its head. */
  dismiss(): void;
}

export interface NoteEditorProps {
  slug: string;
  /** The card's body and its hash as the open card shows them: a newer one
   *  sends the session to the file to see what it holds (Л4.1, Л4.2). */
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
  /** The part after `#` of the link the card was opened by: the editor
   *  scrolls to that place (Л11.8). */
  scrollAnchor?: string | null;
  /** The selection for the action bar; `null` when there is none (Л11.2). */
  onTextSelection?: (selection: EditorTextSelection | null) => void;
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

/** The document position of offset `offset` of the body as a string: a
 *  `\r\n` line break is two signs and one position. */
function documentPosition(doc: Text, offset: number, mode: LineEndingMode, bom: boolean): number {
  const inBody = Math.max(0, offset - (bom ? 1 : 0));
  if (mode !== "crlf") return Math.min(inBody, doc.length);
  let consumed = 0;
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const lineEnd = consumed + line.length;
    if (inBody <= lineEnd) return line.from + (inBody - consumed);
    consumed = lineEnd + 2;
  }
  return doc.length;
}

/** The document position of the place an anchor names (Л11.8): a heading
 *  found as the reading mode finds it (`anchors.ts`), a block by the `^id`
 *  that ends it; a lone `^id` names the block before it. */
function anchorPosition(state: EditorState, anchor: ArticleAnchor, mode: LineEndingMode, bom: boolean): number | null {
  if (anchor.kind === "heading") {
    const headings = sourceHeadings(bodyOfState(state, bom));
    const index = matchHeading(headings, anchor.path);
    const heading = index === null ? undefined : headings[index];
    return heading ? documentPosition(state.doc, heading.start, mode, bom) : null;
  }
  const wanted = `^${anchor.id}`.toLowerCase();
  let found: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (found !== null) return false;
      if (node.name !== NODE.BlockId) return undefined;
      if (state.sliceDoc(node.from, node.to).trim().toLowerCase() !== wanted) return false;
      const line = state.doc.lineAt(node.from);
      if (line.text.trim().toLowerCase() !== wanted) {
        found = line.from;
        return false;
      }
      for (let number = line.number - 1; number >= 1; number -= 1) {
        const before = state.doc.line(number);
        if (before.text.trim() !== "") {
          found = before.from;
          return false;
        }
      }
      found = line.from;
      return false;
    },
  });
  return found;
}

let nextSessionKey = 0;

/** The session the editor shows: its key, the note it follows now and, until
 *  the open card catches up with a rename, the name it had (Л4.8). */
interface OpenedSession {
  key: number;
  slug: string;
  previous: string | null;
  block: EditableCard;
}

/**
 * The open card's note in the editor. It opens the tab's edit session with
 * `begin_note_edit`, which answers the body from disk; until then, and when
 * the note cannot be edited, it shows `fallback`. A session goes on under a
 * new name when its note is renamed (Л4.8); another note is another session.
 */
export function NoteEditor(props: NoteEditorProps) {
  const { slug } = props;
  const [opened, setOpened] = useState<OpenedSession | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const follows = opened !== null && (opened.slug === slug || opened.previous === slug);

  useEffect(() => {
    if (follows) return undefined;
    // Another note: the session shown before has ended with its view, and
    // coming back to its note opens a session anew.
    setOpened(null);
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
        nextSessionKey += 1;
        setRefused(null);
        setOpened({ key: nextSessionKey, slug, previous: null, block });
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
  }, [follows, slug]);

  // The open card caught up with the rename: the old name is forgotten.
  useEffect(() => {
    if (opened?.previous != null && opened.slug === slug) {
      setOpened((current) => (current && current.key === opened.key ? { ...current, previous: null } : current));
    }
  }, [opened, slug]);

  if (refused === slug || !opened || !follows) return <>{props.fallback}</>;
  const key = opened.key;
  return (
    <EditorSession
      key={key}
      {...props}
      opened={opened.block}
      sessionSlug={opened.slug}
      onRenamed={(to) => setOpened((current) => (
        current && current.key === key ? { ...current, slug: to, previous: current.slug } : current
      ))}
    />
  );
}

/** What the session keeps for the parts of the component outside its
 *  effect. */
interface SessionHandle {
  queue: SaveQueue<NoteSaveAnswer>;
  view: EditorView;
  bom: boolean;
  mode: LineEndingMode;
  /** The open card shows a body of this hash: the file is asked when it is
   *  not the base (Л4.1). */
  cardBody(bodyHash: string): void;
}

/** One edit session: the view, its queue and what it hears. */
function EditorSession({
  opened,
  sessionSlug,
  onRenamed,
  ...props
}: NoteEditorProps & { opened: EditableCard; sessionSlug: string; onRenamed: (to: string) => void }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const portals = useMemo(() => new WidgetPortals(), []);
  const latest = useRef({ ...props, onRenamed });
  useEffect(() => {
    latest.current = { ...props, onRenamed };
  });
  // The note's name now: a rename the session follows changes it (Л4.8).
  const slugRef = useRef(sessionSlug);
  const sessionRef = useRef<SessionHandle | null>(null);

  // The session opened with `opened`; a view made again for it (React's
  // second run of effects in development) opens it again once the first
  // view's end has closed it.
  const madeOnce = useRef(false);
  const lastEnd = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return undefined;
    if (madeOnce.current) {
      const again = slugRef.current;
      void lastEnd.current.then(() => beginNoteEdit(again)).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
    }
    madeOnce.current = true;
    const loaded = editorBody(opened.body);
    const lineBreak = documentLineSeparator(loaded.mode);
    let reportedUnsaved = false;
    let ended = false;
    const report = (unsaved: boolean) => {
      if (unsaved === reportedUnsaved || ended) return;
      reportedUnsaved = unsaved;
      void reportNoteEdits(slugRef.current, unsaved).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
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

    // What the file holds, asked of it (Л4.1): an answer is weighed only
    // when no write of the session started since the question and none is
    // under way, for such a write may have changed the file after it; the
    // file is then asked again once the write has answered.
    let gone = false;
    let asking = false;
    let askAgain = false;
    let askAfterWrite = false;
    const askAfterWriteIfWaiting = () => {
      if (!askAfterWrite) return;
      askAfterWrite = false;
      checkDisk();
    };

    const queue = new SaveQueue<NoteSaveAnswer>(opened.body_hash, opened.body, {
      save: async (request) => {
        const saved = await saveNoteBody({
          source_slug: slugRef.current,
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
        askAfterWriteIfWaiting();
      },
      onFailed: (error) => {
        const failure: NoteSaveError = asNoteSaveError(error);
        // The note is gone (Л4.9): the text stays in the editor, nothing is
        // written until the note is back.
        if (failure.kind === "source_not_found") gone = true;
        reportActionFailure({
          kind: "note-save",
          title: NOTE_SAVE_FAILED_TITLE,
          messages: [noteSaveErrorLine(failure)],
        });
        askAfterWriteIfWaiting();
      },
      // How a conflict is shown waits for the user's decision ЛВ2 (а): until
      // then the queue stops, the text and the file stay, the log says why.
      onConflict: (error) => {
        logFailure(NOTE_CONFLICT_LOG, error);
        askAfterWriteIfWaiting();
      },
      onRecovered: () => dismissActionFailure("note-save"),
    });

    /** Weigh what the file holds now against the session (Л4.2, Л4.3,
     *  Л4.8, Л4.9). */
    const consider = (disk: { kind: "body"; bodyHash: string; body: string } | { kind: "gone" }) => {
      if (!editor || ended) return;
      if (disk.kind === "gone") {
        gone = true;
        queue.stop({ kind: "source_not_found", source_slug: slugRef.current } satisfies NoteSaveError);
        return;
      }
      const wasGone = gone;
      gone = false;
      const text = loaded.bom && disk.body.startsWith(BYTE_ORDER_MARK) ? disk.body.slice(1) : disk.body;
      // The file holds the document's text: neither side lacks anything.
      if (readBody() === disk.body) {
        queue.rebase(disk.bodyHash, disk.body);
        return;
      }
      if (disk.bodyHash === queue.base) {
        // The note is back as the session knew it: its edits go on.
        if (wasGone) queue.resume();
        return;
      }
      if (queue.dirty) {
        queue.enterConflict({ kind: "changed", source_slug: slugRef.current } satisfies NoteSaveError);
        return;
      }
      editor.dispatch(externalChangeSpec(editor.state, text));
      queue.rebase(disk.bodyHash, disk.body);
    };

    function checkDisk() {
      if (ended) return;
      if (asking) {
        askAgain = true;
        return;
      }
      asking = true;
      const writes = queue.writes;
      const asked = slugRef.current;
      const settle = (disk: Parameters<typeof consider>[0] | null) => {
        asking = false;
        if (ended) return;
        if (asked !== slugRef.current) {
          // Renamed meanwhile: the answer was of the old name.
          checkDisk();
          return;
        }
        if (disk && (queue.state === "saving" || queue.writes !== writes)) {
          askAfterWrite = true;
        } else if (disk) {
          consider(disk);
        }
        if (askAgain) {
          askAgain = false;
          checkDisk();
        }
      };
      noteBodyState(asked).then(
        (state) => settle({ kind: "body", bodyHash: state.body_hash, body: state.body }),
        (error: unknown) => {
          const refusal = asNoteEditError(error);
          if (refusal.kind === "source_not_found") {
            settle({ kind: "gone" });
            return;
          }
          logFailure(NOTE_CONFLICT_LOG, error);
          settle(null);
        },
      );
    }

    /** The open card shows a body of `bodyHash` (`vault-refreshed`, a
     *  write's answer): when it is not the base, the file says what holds. */
    const cardBody = (bodyHash: string) => {
      if (bodyHash !== queue.base || gone) checkDisk();
    };

    // The session holds its note (Л4.8, Л4.9): it follows a rename and is
    // told when the note leaves the index.
    const hold = holdNoteForEditing(slugRef.current, {
      renamed: (to) => {
        slugRef.current = to;
        latest.current.onRenamed(to);
        // The rename may have rewritten the note's own links (Л4.8).
        checkDisk();
      },
      missing: () => checkDisk(),
    });

    // The selection for the action bar (Л11.2): the exact range of the body
    // in bytes and the hash of the body the file holds once the session has
    // written its edits, which the backend makes it do first.
    const bodyHashes = new WeakMap<Text, string>();
    let published: string | null = null;

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
          linkSuggestions(),
          motionKeymap,
          linkClicks,
          editorLinkHost.of({
            openNote: (target) => {
              // The session writes first, then the note opens (Л10.1).
              void queue.flush()
                .then(() => resolveNoteLink(slugRef.current, target))
                .then((found) => {
                  if (found) latest.current.onOpenNote(found);
                })
                .catch((error: unknown) => logFailure(NOTE_LINK_LOOKUP_FAILED_TITLE, error));
            },
            openExternal: (href) => {
              const safe = safeMarkdownUrl(href);
              if (BROWSER_SCHEMES.test(safe)) openLinkInBrowser(safe);
            },
          }),
          linkSuggestHost.of({
            suggest: (query: LinkQuery) => suggestNoteLinks(slugRef.current, query).then(
              (found): readonly LinkSuggestion[] => found,
              (error: unknown) => {
                logFailure(NOTE_SUGGEST_LOG, error);
                return [];
              },
            ),
          }),
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
            if (update.selectionSet || update.docChanged || update.transactions.some((tr) => tr.effects.length > 0)) {
              publishSelection(update.view);
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

    function publishSelection(target: EditorView) {
      const announce = latest.current.onTextSelection;
      if (!announce) return;
      const state = target.state;
      const main = state.selection.main;
      const pressed = state.field(revealField).waits.has("pointer");
      const text = main.empty || pressed ? "" : state.sliceDoc(main.from, main.to);
      if (!text.trim()) {
        if (published !== null) {
          published = null;
          announce(null);
        }
        return;
      }
      const start = bodyByteOffset(state.doc, main.from, lineBreak, loaded.bom);
      const end = bodyByteOffset(state.doc, main.to, lineBreak, loaded.bom);
      let sourceBodyHash = bodyHashes.get(state.doc);
      if (sourceBodyHash === undefined) {
        sourceBodyHash = computeBodyHash(bodyOfState(state, loaded.bom));
        bodyHashes.set(state.doc, sourceBodyHash);
      }
      const key = `${slugRef.current}\u0000${start}\u0000${end}\u0000${sourceBodyHash}`;
      // The first line of the selection on screen; a start outside the part
      // drawn stands at its line's place in the document.
      const lineEnd = Math.min(main.to, state.doc.lineAt(main.from).to);
      const block = target.lineBlockAt(main.from);
      const column = target.contentDOM.getBoundingClientRect();
      const first = target.coordsAtPos(main.from, 1) ?? {
        left: column.left,
        right: column.left,
        top: target.documentTop + block.top,
        bottom: target.documentTop + block.top + block.height,
      };
      const last = target.coordsAtPos(lineEnd, -1) ?? { ...first, right: column.right };
      const left = first.left;
      const right = Math.max(left, last.right);
      published = key;
      announce({
        payload: {
          type: "text_selection",
          sourceSlug: slugRef.current,
          selectedText: text,
          firstBlockStart: start,
          firstBlockEnd: end,
          sourceBodyHash,
          sourceRange: { start, end },
        },
        rect: { left, right, top: first.top, bottom: first.bottom, width: right - left, height: first.bottom - first.top },
        root: target.contentDOM,
        dismiss: () => {
          if (ended) return;
          created.dispatch({ selection: { anchor: created.state.selection.main.head }, userEvent: "select" });
        },
      });
    }

    sessionRef.current = { queue, view: created, bom: loaded.bom, mode: loaded.mode, cardBody };
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
      if (changed !== slugRef.current || (body_hash === queue.base && !gone)) return;
      checkDisk();
    });
    // The window came back: a failed write is tried again, and the file is
    // asked whether it changed meanwhile (Л3.8, Л4.1).
    const onFocus = () => {
      queue.retry();
      checkDisk();
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
      hold.release();
      if (published !== null) latest.current.onTextSelection?.(null);
      // The session ends after its last write (Л3.2): the queue keeps the
      // body the view held, the view can go now.
      lastBody = bodyOfState(created.state, loaded.bom);
      ended = true;
      editor = null;
      sessionRef.current = null;
      lastEnd.current = queue.flush().finally(() => {
        queue.dispose();
        return endNoteEdit(slugRef.current).catch((error: unknown) => logFailure(NOTE_SESSION_LOG, error));
      });
      created.destroy();
    };
    // The session is made once per opened note (the component is keyed by
    // it): later props reach it through `latest`.
  }, [opened, portals]);

  // The card from disk the session opened with goes to the open card: the
  // index caught up with the file (Л2.8).
  useEffect(() => {
    latest.current.onSaved(opened);
  }, [opened]);

  // A newer card from the file (`vault-refreshed`) after the session opened:
  // the file is asked what it holds (Л4.1, Л4.2).
  const { bodyHash } = props;
  const firstCard = useRef<string | null>(bodyHash);
  useEffect(() => {
    const first = firstCard.current;
    firstCard.current = null;
    if (first === bodyHash) return;
    sessionRef.current?.cardBody(bodyHash);
  }, [bodyHash]);

  // The place the card opened at (Л11.8), once per note and place: a body
  // written later keeps the reader where they are.
  const { scrollAnchor } = props;
  const jumpedAnchor = useRef<string | null>(null);
  useEffect(() => {
    const session = sessionRef.current;
    const anchor = scrollAnchor ? parseArticleAnchor(scrollAnchor) : null;
    const jump = `${slugRef.current}\u0000${scrollAnchor ?? ""}`;
    if (!view || !session || !anchor || jumpedAnchor.current === jump) return undefined;
    let current = true;
    let frame: number | null = null;
    // The embeds' first answers move what stands under them (Ч11.4).
    void latest.current.noteEmbeds.settled().then(() => {
      if (!current) return;
      frame = window.requestAnimationFrame(() => {
        const pos = anchorPosition(view.state, anchor, session.mode, session.bom);
        if (pos === null) return;
        jumpedAnchor.current = jump;
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      });
    });
    return () => {
      current = false;
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [scrollAnchor, view]);

  const host = useMemo<EditorArticleHost>(() => ({
    sourceSlug: sessionSlug,
    vaultPath: props.vaultPath,
    thumbsRootPath: props.thumbsRootPath,
    noteEmbeds: props.noteEmbeds,
    image: props.image,
    onOpenNote: props.onOpenNote,
  }), [props.image, props.noteEmbeds, props.onOpenNote, props.thumbsRootPath, props.vaultPath, sessionSlug]);

  return (
    <>
      <div ref={parentRef} className={props.className} data-note-editor={sessionSlug} />
      <EditorWidgets portals={portals} view={view} host={host} />
    </>
  );
}
