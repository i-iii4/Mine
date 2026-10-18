// The writes of one note's edit session (SPEC_EDITING.md, Л3.1, Л3.2, Л3.5,
// Л3.8): a change of the document starts a write at once when none of this
// note is under way; changes that come during a write gather and go as one
// next write right after its answer, with the base the answer gave. No write
// starts during a composition (Л13.1); it starts at its end. A flush writes
// now and waits. A write the file refuses for a passing reason (in iCloud,
// read-only, an internal error) is said in the tab's notice and tried again
// on the next change, when the window comes back and every
// `EDIT_SAVE_RETRY_MS`; the next success takes the notice away. A conflict
// (the file is not the base) stops the queue: nothing is written over the
// file until the session takes a side (Л4.3). A note that is gone stops it
// too (Л4.9).
//
// The queue knows no command and no error type of the backend: the host
// gives it the write and says what an error means.

/** How long a failed write waits before it is tried again (Л3.8). */
export const EDIT_SAVE_RETRY_MS = 5000;

/** What a write sends: the body of the document and the base it was edited
 *  from (`SaveNoteBodyParams` without the note, Л3.3). */
export interface SaveRequest {
  baseBodyHash: string;
  body: string;
}

/** What the queue reads of a write's answer (`SavedNoteBody`, Л3.3). */
export interface SaveAnswer {
  /** The hash of the body the file holds now: the next base. */
  bodyHash: string;
  /** The body the file holds now; not the request's when the split of the
   *  file changed (Л2.4). */
  body: string;
  splitChanged: boolean;
  unchanged: boolean;
}

/** What a refused write means for the queue. */
export type SaveDisposition =
  /** The file is not the base: stop and let the session take a side (Л4.3). */
  | "conflict"
  /** A passing reason: say it and try again (Л3.8). */
  | "retry"
  /** Nothing to write to any more (the note is gone, it is no card): stop
   *  and say it (Л4.9). */
  | "stop";

/** Where the queue stands. */
export type SaveQueueStatus = "idle" | "saving" | "failed" | "conflict" | "stopped";

/** The answer of a flush: every edit is in the file, or why not. */
export type FlushOutcome =
  | { saved: true }
  | { saved: false; status: Exclude<SaveQueueStatus, "idle" | "saving">; error: unknown };

export interface SaveQueueHost<Answer extends SaveAnswer> {
  /** The write itself (`save_note_body`). */
  save(request: SaveRequest): Promise<Answer>;
  /** What a refused write means. */
  classify(error: unknown): SaveDisposition;
  /** The body of the document now (`bodyOfState`). */
  readBody(): string;
  /** A write went through: the card and the panel take its answer (Л3.7). */
  onSaved(answer: Answer): void;
  /** A write failed for a passing reason or stopped the queue: the notice
   *  (Л3.8, Л4.9). */
  onFailed(error: unknown, disposition: Exclude<SaveDisposition, "conflict">): void;
  /** The file is not the base: the conflict (Л4.3). */
  onConflict(error: unknown): void;
  /** A write went through after failures: the notice goes. */
  onRecovered(): void;
}

interface Waiter {
  resolve(outcome: FlushOutcome): void;
}

/**
 * The write queue of one note in one tab. `edited` after every change of
 * the document, `setComposing` around a composition, `flush` before the
 * session ends or another write of Mine touches the note, `retry` when the
 * window comes back.
 */
export class SaveQueue<Answer extends SaveAnswer> {
  private baseBodyHash: string;
  private savedBody: string;
  private status: SaveQueueStatus = "idle";
  private composing = false;
  private pending = false;
  private lastError: unknown = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Waiter[] = [];
  private disposed = false;

  constructor(
    baseBodyHash: string,
    savedBody: string,
    private readonly host: SaveQueueHost<Answer>,
    private readonly retryMs: number = EDIT_SAVE_RETRY_MS,
  ) {
    this.baseBodyHash = baseBodyHash;
    this.savedBody = savedBody;
  }

  /** The base the next write is edited from. */
  get base(): string {
    return this.baseBodyHash;
  }

  /** Where the queue stands. */
  get state(): SaveQueueStatus {
    return this.status;
  }

  /** Whether the document holds edits the file has not. */
  get dirty(): boolean {
    return this.pending || this.status === "saving" || this.host.readBody() !== this.savedBody;
  }

  /** The document changed. */
  edited(): void {
    this.pending = true;
    this.leaveFailure();
    this.start();
  }

  /** A composition started or ended: no write starts during one (Л13.1). */
  setComposing(composing: boolean): void {
    this.composing = composing;
    if (!composing) this.start();
  }

  /** The window came back: a failed write is tried again (Л3.8). */
  retry(): void {
    if (this.status !== "failed") return;
    this.pending = true;
    this.leaveFailure();
    this.start();
  }

  /** Write now and wait until every edit is in the file, or the queue
   *  failed (Л3.2). A flush without edits writes nothing. */
  flush(): Promise<FlushOutcome> {
    if (this.status === "conflict" || this.status === "stopped") {
      return Promise.resolve({ saved: false, status: this.status, error: this.lastError });
    }
    if (this.status !== "saving" && !this.pending && this.host.readBody() === this.savedBody) {
      return Promise.resolve({ saved: true });
    }
    const promise = new Promise<FlushOutcome>((resolve) => this.waiters.push({ resolve }));
    this.leaveFailure();
    this.pending = true;
    this.start(true);
    return promise;
  }

  /** The session took the file's body without a write of its own (an
   *  external change it applied, Л4.2): it is the new base. */
  rebase(baseBodyHash: string, body: string): void {
    this.baseBodyHash = baseBodyHash;
    this.savedBody = body;
    if (this.status === "conflict") this.status = "idle";
  }

  /** The file changed outside the session while it holds edits the file has
   *  not (Л4.3): nothing more is written until the session takes a side. */
  enterConflict(reason: unknown): void {
    if (this.status === "conflict" || this.status === "stopped") return;
    this.clearRetry();
    this.status = "conflict";
    this.pending = false;
    this.lastError = reason;
    this.host.onConflict(reason);
    this.settle({ saved: false, status: "conflict", error: reason });
  }

  /** The session is over: no timer stays, a write under way still lands. */
  dispose(): void {
    this.disposed = true;
    this.clearRetry();
  }

  /** A failed write is tried again now: its timer goes. */
  private leaveFailure() {
    if (this.status !== "failed") return;
    this.clearRetry();
    this.status = "idle";
  }

  /** Start the next write if one may start; whether one did. */
  private start(forced = false): boolean {
    if (this.status !== "idle") return false;
    if (this.composing && !forced) return false;
    if (!this.pending) return false;
    this.pending = false;
    const body = this.host.readBody();
    if (body === this.savedBody) {
      this.settle({ saved: true });
      return false;
    }
    this.status = "saving";
    const request: SaveRequest = { baseBodyHash: this.baseBodyHash, body };
    this.host.save(request).then(
      (answer) => this.succeeded(answer),
      (error: unknown) => this.failed(error),
    );
    return true;
  }

  private succeeded(answer: Answer) {
    this.baseBodyHash = answer.bodyHash;
    this.savedBody = answer.body;
    // A conflict entered while the write was under way stands: the file
    // changed after it too.
    if (this.status === "conflict") {
      this.host.onSaved(answer);
      return;
    }
    const recovered = this.lastError !== null;
    this.lastError = null;
    this.status = "idle";
    if (recovered) this.host.onRecovered();
    this.host.onSaved(answer);
    if (this.host.readBody() !== this.savedBody) this.pending = true;
    if (this.pending && this.start(this.waiters.length > 0)) return;
    this.settle({ saved: true });
  }

  private failed(error: unknown) {
    if (this.status === "conflict") return;
    this.lastError = error;
    const disposition = this.host.classify(error);
    if (disposition === "conflict") {
      this.status = "conflict";
      this.pending = false;
      this.host.onConflict(error);
      this.settle({ saved: false, status: "conflict", error });
      return;
    }
    if (disposition === "stop") {
      this.status = "stopped";
      this.pending = false;
      this.host.onFailed(error, "stop");
      this.settle({ saved: false, status: "stopped", error });
      return;
    }
    this.status = "failed";
    this.host.onFailed(error, "retry");
    this.settle({ saved: false, status: "failed", error });
    this.scheduleRetry();
  }

  private scheduleRetry() {
    this.clearRetry();
    if (this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retry();
    }, this.retryMs);
  }

  private clearRetry() {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private settle(outcome: FlushOutcome) {
    if (this.waiters.length === 0) return;
    // A flush waits for every edit: one that came during the last write
    // goes out first.
    if (outcome.saved && this.pending) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(outcome);
  }
}
