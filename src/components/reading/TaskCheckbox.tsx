import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { toggleTaskItem } from "@/lib/commands";
import {
  dismissActionFailure,
  NOTHING_CHANGED,
  reportActionFailure,
  TASK_TOGGLE_FAILED_TITLE,
} from "@/lib/actionFailures";
import type { IndexedBlock, TaskToggleError } from "@/types";
import { cn } from "@/lib/utils";

/** The lines a failed toggle says (Ч12.3, the table of errors). The words
 *  are a proposal the user approves, like the texts of windows. */
export const TASK_NOTE_CHANGED = "The note changed outside Mine.";
export const TASK_STATE_CHANGED = "The task changed outside Mine.";
export const TASK_NOTE_GONE = "The note is no longer on disk.";
export const NO_SPACE_FOR_TASK = "No space is open.";

export function taskInCloudLine(fileName: string): string {
  return `“${fileName}” is downloading from iCloud. Try again when it has arrived.`;
}

export function taskReadOnlyLine(fileName: string): string {
  return `“${fileName}” is read-only.`;
}

/** What a failed toggle says, line by line. */
export function taskToggleErrorLine(error: TaskToggleError): string {
  switch (error.kind) {
    case "stale_body":
    case "changed":
      return TASK_NOTE_CHANGED;
    case "state_changed":
      return TASK_STATE_CHANGED;
    case "in_cloud":
      return taskInCloudLine(error.file_name);
    case "read_only":
      return taskReadOnlyLine(error.file_name);
    case "source_not_found":
      return TASK_NOTE_GONE;
    case "no_vault":
      return NO_SPACE_FOR_TASK;
    case "internal":
      return error.message;
  }
}

/** Errors after which the open card reads its body again: the file is not
 *  what the reader saw. */
function bodyIsStale(error: TaskToggleError): boolean {
  return error.kind === "stale_body" || error.kind === "changed" || error.kind === "state_changed";
}

interface TaskWrite {
  itemStart: number;
  /** The state the file holds when the write runs, as the reader saw it. */
  checked: boolean;
}

/** What the open card does with the answers of its writes. */
export interface TaskToggleHost {
  /** The card read anew after a write: its body and `body_hash`. */
  onWritten(block: IndexedBlock): void;
  /** The body is not the reader's: read it again. */
  onStale(): void;
}

/**
 * The task writes of one open card (SPEC_READING_MODE.md, Ч12.2, Ч12.4). A
 * click changes the box at once and queues one write; writes of one note go
 * one at a time, each with the `body_hash` the last answer gave, because
 * changing one sign for another moves no other task. A second click on the
 * same box before the answer queues the reverse change. A failed write puts
 * every box back as the file has it, drops the writes still queued, says why
 * in the tab's notice and, when the file is not the reader's, has the card
 * read it again; the next success takes the notice away.
 */
export class TaskToggles {
  private readonly overrides = new Map<number, boolean>();
  private readonly listeners = new Set<() => void>();
  private queue: TaskWrite[] = [];
  private running = false;
  private bodyHash: string | null = null;

  constructor(
    private readonly sourceSlug: string | undefined,
    private readonly host: { current: TaskToggleHost },
  ) {}

  /** Whether a box may be pressed: the card's whole body is shown, with
   *  its hash (Ч12.5). */
  get active(): boolean {
    return Boolean(this.sourceSlug && this.bodyHash);
  }

  /** The body the card shows now. Boxes changed by finished writes follow
   *  the new body; while writes are under way the boxes keep their state. */
  sync(bodyHash: string | null): void {
    if (this.running || this.queue.length > 0) return;
    if (bodyHash === this.bodyHash && this.overrides.size === 0) return;
    this.bodyHash = bodyHash;
    this.overrides.clear();
    this.notify();
  }

  /** The box as the reader sees it. */
  visible(itemStart: number | null, inBody: boolean): boolean {
    return itemStart === null ? inBody : this.overrides.get(itemStart) ?? inBody;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The reader pressed the box at `itemStart`, which showed `seen`. */
  toggle(itemStart: number, seen: boolean): void {
    if (!this.active) return;
    this.overrides.set(itemStart, !seen);
    this.queue.push({ itemStart, checked: seen });
    this.notify();
    this.run();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private run() {
    const write = this.queue[0];
    const sourceSlug = this.sourceSlug;
    const bodyHash = this.bodyHash;
    if (this.running || !write || !sourceSlug || !bodyHash) return;
    this.running = true;
    toggleTaskItem({
      source_slug: sourceSlug,
      source_body_hash: bodyHash,
      item_start: write.itemStart,
      checked: write.checked,
    }).then(
      (block) => {
        this.queue.shift();
        this.bodyHash = block.body_hash;
        this.running = false;
        dismissActionFailure("task-toggle");
        this.host.current.onWritten(block);
        this.run();
      },
      // `toggleTaskItem` turns every rejection into a `TaskToggleError`.
      (error: TaskToggleError) => {
        this.queue = [];
        this.running = false;
        this.overrides.clear();
        this.notify();
        reportActionFailure({
          kind: "task-toggle",
          title: TASK_TOGGLE_FAILED_TITLE,
          summary: NOTHING_CHANGED,
          messages: [taskToggleErrorLine(error)],
        });
        if (bodyIsStale(error)) this.host.current.onStale();
      },
    );
  }
}

/** The task writes of the article of `sourceSlug` shown with `bodyHash`
 *  (`null` while only the feed's start of the body is shown). */
export function useTaskToggles(
  sourceSlug: string | undefined,
  bodyHash: string | null,
  host: TaskToggleHost,
): TaskToggles {
  const hostRef = useRef(host);
  useEffect(() => {
    hostRef.current = host;
  });
  const toggles = useMemo(() => new TaskToggles(sourceSlug, hostRef), [sourceSlug]);
  useEffect(() => {
    toggles.sync(bodyHash);
  }, [bodyHash, toggles]);
  return toggles;
}

/** A task's box as the reader sees it, and whether it may be pressed now:
 *  the card's whole body is shown and the task's place in it is known. */
export function useTaskState(
  toggles: TaskToggles | null,
  itemStart: number | null,
  inBody: boolean,
): { checked: boolean; pressable: boolean } {
  const subscribe = toggles?.subscribe ?? noSubscription;
  const checked = useSyncExternalStore(
    subscribe,
    () => toggles?.visible(itemStart, inBody) ?? inBody,
    () => inBody,
  );
  const active = useSyncExternalStore(subscribe, () => Boolean(toggles?.active), () => false);
  return { checked, pressable: active && itemStart !== null && toggles !== null };
}

/**
 * The box of a task of the article (SPEC_READING_MODE.md, Ч12): the design
 * system's checkbox in the place of the list marker. A click or Space on it
 * in focus changes it at once and writes the one sign in the file; Enter does
 * not, as for any checkbox (WAI-ARIA). Its name for a screen reader is the
 * task's text. Until the card's whole body has come it is inert, with the
 * frame of what cannot be pressed.
 */
export function TaskCheckbox({
  checked,
  pressable,
  itemStart,
  labelledBy,
  onToggle,
}: {
  checked: boolean;
  pressable: boolean;
  /** Where the task's list item starts in the body, in bytes. */
  itemStart: number | null;
  labelledBy: string;
  onToggle: () => void;
}) {
  return (
    <Checkbox
      checked={checked}
      disabled={!pressable}
      aria-labelledby={labelledBy}
      data-task-checkbox=""
      data-task-item-start={itemStart ?? undefined}
      className={cn("border-primary", !pressable && INERT_CHECKBOX_CLASSES)}
      onCheckedChange={onToggle}
    />
  );
}

/** A box no click changes: the frame of what cannot be pressed
 *  (`--inert-frame`), the check in the secondary step. */
const INERT_CHECKBOX_CLASSES =
  "border-inert-frame disabled:cursor-default disabled:opacity-100 data-[state=checked]:border-inert-frame data-[state=checked]:bg-transparent data-[state=checked]:text-muted-foreground";

/** An inert box: `<input type="checkbox">` from a note's HTML, which no click
 *  changes; a task is only ever a GFM list item (Ч4, Ч12.5). */
export function InertCheckbox({ checked }: { checked: boolean }) {
  return (
    <Checkbox
      checked={checked}
      disabled
      data-html-checkbox=""
      className={cn("inline-flex align-[-2px]", INERT_CHECKBOX_CLASSES)}
    />
  );
}

function noSubscription(): () => void {
  return () => undefined;
}
