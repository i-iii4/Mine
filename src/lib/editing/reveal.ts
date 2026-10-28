// What the editor shows as source (SPEC_EDITING.md, Л5.2, Л5.3, Л5.5): the
// element under the caret or inside the selection, one element and not its
// whole line, and only after the person acted (the caret the editor opens
// with reveals nothing); a paragraph of pictures while the caret stands on
// its lines or a selection crosses it, its source over the pictures (the
// user's decision of 27.10.2026, as Obsidian's Live Preview); any other block
// drawn as a widget only when it was opened by a click or Enter, until the
// caret leaves it. While a change of what is shown
// must wait (a pressed mouse button over a selection, a composition, an
// external change being applied), the selection reveal follows is carried
// through the changes and not taken anew: what is drawn stays as it was until
// the safe moment.

import { EditorSelection, StateEffect, StateField, type EditorState, type Transaction } from "@codemirror/state";
import { blocksOf, type EditorBlock } from "./blocks";
import { externalChange } from "./reloadDiff";

/** Why a change of what is revealed waits (Л5.5). */
export type RevealWait = "pointer" | "composition" | "external";

/** What the editor shows as source. */
export interface RevealState {
  /** Whether the person has acted in the editor: until then nothing is
   *  revealed (Л5.2). */
  interacted: boolean;
  /** The selection reveal follows: the editor's own, carried through the
   *  changes while a rebuild waits. */
  selection: EditorSelection;
  /** The starts of the blocks opened as source by a click or Enter (Л5.3). */
  blocks: readonly number[];
  /** The starts of the paragraphs of pictures the selection stands on: they
   *  show their source over their pictures (Л5.3). */
  pictures: readonly number[];
  /** Why the shown set waits now. */
  waits: ReadonlySet<RevealWait>;
}

/** Show the block that starts at this position as source. */
export const revealBlockEffect = StateEffect.define<number>({ map: (value, mapping) => mapping.mapPos(value, -1) });
/** Draw the block that starts at this position again. */
export const concealBlockEffect = StateEffect.define<number>({ map: (value, mapping) => mapping.mapPos(value, -1) });
/** A reason to wait started or ended (Л5.5). */
export const revealWaitEffect = StateEffect.define<{ reason: RevealWait; waiting: boolean }>();

const NO_WAITS: ReadonlySet<RevealWait> = new Set();

/** The user events that mean the person acted in the editor. */
const INTERACTIONS = ["select", "input", "delete", "move", "undo", "redo"];

function interacts(tr: Transaction): boolean {
  return INTERACTIONS.some((event) => tr.isUserEvent(event));
}

/** Whether `tr` itself must not change what is shown: a step of a
 *  composition or an external change. */
function transactionWaits(tr: Transaction): boolean {
  return tr.isUserEvent("input.type.compose") || tr.annotation(externalChange) === true;
}

/** The revealed blocks the caret is still in. */
function blocksKeptBy(state: EditorState, starts: readonly number[], selection: EditorSelection): number[] {
  if (starts.length === 0) return [];
  const head = selection.main.head;
  const blocks = blocksOf(state, Math.min(...starts), Math.max(...starts));
  return starts.filter((start) => {
    const block = blocks.find((candidate) => candidate.from === start);
    return block !== undefined && block.from <= head && head <= block.to;
  });
}

/** The paragraphs of pictures `selection` stands on: a caret on one of their
 *  lines, from its start to its end, or a selection over them. Every line of
 *  such a paragraph holds `![`, so a caret on a line without it looks no
 *  further. */
function picturesUnder(state: EditorState, selection: EditorSelection): number[] {
  const starts = new Set<number>();
  for (const range of selection.ranges) {
    if (range.empty && !state.doc.lineAt(range.head).text.includes("![")) continue;
    for (const block of blocksOf(state, range.from, range.to)) {
      if (block.kind !== "media") continue;
      const under = range.empty
        ? block.from <= range.head && range.head <= block.to
        : range.from < block.to && range.to > block.from;
      if (under) starts.add(block.from);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

function sameStarts(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The reveal state of the editor. */
export const revealField = StateField.define<RevealState>({
  create(state) {
    return { interacted: false, selection: state.selection, blocks: [], pictures: [], waits: NO_WAITS };
  },
  update(value, tr) {
    let waits = value.waits;
    let blocks = tr.docChanged
      ? [...new Set(value.blocks.map((start) => tr.changes.mapPos(start, -1)))]
      : value.blocks;
    let pictures = tr.docChanged
      ? [...new Set(value.pictures.map((start) => tr.changes.mapPos(start, -1)))]
      : value.pictures;
    let explicit = false;
    for (const effect of tr.effects) {
      if (effect.is(revealWaitEffect)) {
        const next = new Set(waits);
        if (effect.value.waiting) next.add(effect.value.reason);
        else next.delete(effect.value.reason);
        waits = next;
      } else if (effect.is(revealBlockEffect)) {
        if (!blocks.includes(effect.value)) blocks = [...blocks, effect.value].sort((a, b) => a - b);
        explicit = true;
      } else if (effect.is(concealBlockEffect)) {
        blocks = blocks.filter((start) => start !== effect.value);
        explicit = true;
      }
    }
    const interacted = value.interacted || interacts(tr) || explicit;
    const waiting = waits.size > 0 || transactionWaits(tr);
    const selection = waiting ? value.selection.map(tr.changes) : tr.newSelection;
    if (!waiting && !explicit && blocks.length > 0 && (tr.selection || tr.docChanged)) {
      const kept = blocksKeptBy(tr.state, blocks, selection);
      if (!sameStarts(kept, blocks)) blocks = kept;
    }
    if (!waiting && interacted) {
      const under = picturesUnder(tr.state, selection);
      if (!sameStarts(under, pictures)) pictures = under;
    }
    if (
      interacted === value.interacted
      && selection.eq(value.selection)
      && sameStarts(blocks, value.blocks)
      && sameStarts(pictures, value.pictures)
      && waits === value.waits
    ) {
      return value;
    }
    return { interacted, selection, blocks, pictures, waits };
  },
});

/** How a position or a selection touches an element for reveal. */
export type RevealReach =
  /** The caret anywhere from its start to its end, both ends included. */
  | "touch"
  /** The caret strictly inside it, or a selection over it: a task's `[ ]`,
   *  so the caret at the start of the task's text keeps the box. */
  | "inside";

/** Whether the element from `from` to `to` shows its source (Л5.2). */
export function isRevealed(reveal: RevealState, from: number, to: number, reach: RevealReach = "touch"): boolean {
  if (!reveal.interacted) return false;
  return reveal.selection.ranges.some((range) => {
    if (range.empty) {
      return reach === "touch" ? from <= range.head && range.head <= to : from < range.head && range.head < to;
    }
    return range.from < to && range.to > from;
  });
}

/** Whether `block` is shown as source. */
export function isBlockRevealed(reveal: RevealState, block: EditorBlock): boolean {
  return block.kind === "media" ? reveal.pictures.includes(block.from) : reveal.blocks.includes(block.from);
}

/** Whether the main selection is exactly `block`: the block is chosen
 *  (Л5.3, Л8.4). */
export function isBlockSelected(state: EditorState, block: EditorBlock): boolean {
  const main = state.selection.main;
  return main.from === block.from && main.to === block.to && !main.empty;
}
