import { EDIT_SAVE_RETRY_MS, SaveQueue, type SaveAnswer, type SaveDisposition, type SaveRequest } from "./saveQueue";

interface Pending {
  request: SaveRequest;
  resolve(answer: SaveAnswer): void;
  reject(error: unknown): void;
}

/** A queue over a made-up document and a made-up backend whose writes
 *  answer when the test says. */
function setup(initial = "base body") {
  let body = initial;
  const writes: Pending[] = [];
  const events: string[] = [];
  const dispositions = new Map<unknown, SaveDisposition>();
  const queue = new SaveQueue<SaveAnswer>("hash-0", initial, {
    save: (request) => new Promise<SaveAnswer>((resolve, reject) => writes.push({ request, resolve, reject })),
    classify: (error) => dispositions.get(error) ?? "retry",
    readBody: () => body,
    onSaved: (answer) => events.push(`saved ${answer.bodyHash}`),
    onFailed: (_error, disposition) => events.push(`failed ${disposition}`),
    onConflict: () => events.push("conflict"),
    onRecovered: () => events.push("recovered"),
  });
  let hashes = 0;
  return {
    queue,
    writes,
    events,
    dispositions,
    type(text: string) {
      body = text;
      queue.edited();
    },
    /** The backend writes the oldest pending request. */
    async answer(overrides: Partial<SaveAnswer> = {}) {
      const write = writes.shift();
      if (!write) throw new Error("no write under way");
      hashes += 1;
      write.resolve({ bodyHash: `hash-${hashes}`, body: write.request.body, splitChanged: false, unchanged: false, ...overrides });
      await Promise.resolve();
      await Promise.resolve();
    },
    async refuse(error: unknown) {
      const write = writes.shift();
      if (!write) throw new Error("no write under way");
      write.reject(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("SaveQueue (SPEC_EDITING.md, Л3.1, Л3.2, Л3.8)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a write at once and sends the body with its base", () => {
    const session = setup();
    session.type("one");
    expect(session.writes.map((write) => write.request)).toEqual([{ baseBodyHash: "hash-0", body: "one" }]);
    expect(session.queue.state).toBe("saving");
  });

  it("keeps one write under way and sends what gathered as one next write with the new base", async () => {
    const session = setup();
    session.type("o");
    session.type("on");
    session.type("one");
    expect(session.writes).toHaveLength(1);
    await session.answer();
    expect(session.writes.map((write) => write.request)).toEqual([{ baseBodyHash: "hash-1", body: "one" }]);
    await session.answer();
    expect(session.writes).toHaveLength(0);
    expect(session.queue.state).toBe("idle");
    expect(session.queue.base).toBe("hash-2");
    expect(session.events).toEqual(["saved hash-1", "saved hash-2"]);
  });

  it("writes nothing when the document is the saved body again", () => {
    const session = setup("same");
    session.type("same");
    expect(session.writes).toHaveLength(0);
    expect(session.queue.dirty).toBe(false);
  });

  it("starts no write during a composition and starts it at the end (Л13.1)", () => {
    const session = setup();
    session.queue.setComposing(true);
    session.type("か");
    session.type("かな");
    expect(session.writes).toHaveLength(0);
    session.queue.setComposing(false);
    expect(session.writes.map((write) => write.request.body)).toEqual(["かな"]);
  });

  it("flushes and waits for the write under way and the one after it", async () => {
    const session = setup();
    session.type("one");
    session.type("one two");
    let flushed: unknown = null;
    void session.queue.flush().then((outcome) => { flushed = outcome; });
    await session.answer();
    expect(flushed).toBeNull();
    expect(session.writes.map((write) => write.request.body)).toEqual(["one two"]);
    await session.answer();
    expect(flushed).toEqual({ saved: true });
  });

  it("flushes during a composition: the session is ending", async () => {
    const session = setup();
    session.queue.setComposing(true);
    session.type("か");
    const flush = session.queue.flush();
    expect(session.writes).toHaveLength(1);
    await session.answer();
    await expect(flush).resolves.toEqual({ saved: true });
  });

  it("a flush without edits writes nothing", async () => {
    const session = setup();
    await expect(session.queue.flush()).resolves.toEqual({ saved: true });
    expect(session.writes).toHaveLength(0);
  });

  it("says a passing failure and tries again on a timer, then takes the notice away", async () => {
    vi.useFakeTimers();
    const session = setup();
    session.type("one");
    await session.refuse(new Error("read-only"));
    expect(session.queue.state).toBe("failed");
    expect(session.events).toEqual(["failed retry"]);
    expect(session.writes).toHaveLength(0);
    vi.advanceTimersByTime(EDIT_SAVE_RETRY_MS - 1);
    expect(session.writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(session.writes.map((write) => write.request.body)).toEqual(["one"]);
    await session.answer();
    expect(session.events).toEqual(["failed retry", "recovered", "saved hash-1"]);
  });

  it("tries a failed write again on the next edit and when the window comes back", async () => {
    vi.useFakeTimers();
    const session = setup();
    session.type("one");
    await session.refuse(new Error("in iCloud"));
    session.type("one two");
    expect(session.writes.map((write) => write.request.body)).toEqual(["one two"]);
    await session.refuse(new Error("in iCloud"));
    session.queue.retry();
    expect(session.writes.map((write) => write.request.body)).toEqual(["one two"]);
  });

  it("stops at a conflict and writes nothing over the file (Л4.3)", async () => {
    const session = setup();
    const stale = new Error("stale body");
    session.dispositions.set(stale, "conflict");
    session.type("one");
    await session.refuse(stale);
    expect(session.queue.state).toBe("conflict");
    session.type("one two");
    expect(session.writes).toHaveLength(0);
    await expect(session.queue.flush()).resolves.toEqual({ saved: false, status: "conflict", error: stale });
    expect(session.events).toEqual(["conflict"]);
  });

  it("stops when the note is gone and says so once (Л4.9)", async () => {
    vi.useFakeTimers();
    const session = setup();
    const gone = new Error("source not found");
    session.dispositions.set(gone, "stop");
    session.type("one");
    await session.refuse(gone);
    vi.advanceTimersByTime(EDIT_SAVE_RETRY_MS * 3);
    session.type("one two");
    expect(session.writes).toHaveLength(0);
    expect(session.events).toEqual(["failed stop"]);
  });

  it("resolves a flush with the failure that ended it", async () => {
    const session = setup();
    const error = new Error("read-only");
    session.type("one");
    const flush = session.queue.flush();
    await session.refuse(error);
    await expect(flush).resolves.toEqual({ saved: false, status: "failed", error });
  });

  it("takes the body of an answer whose split changed as the saved one (Л2.4)", async () => {
    const session = setup("---\nbroken");
    session.type("---\nfixed: yes\n---\nbody");
    await session.answer({ body: "body", splitChanged: true });
    expect(session.queue.base).toBe("hash-1");
    // The document still holds the whole text until the editor applies the
    // answer's body: that is an edit the queue writes again.
    expect(session.writes).toHaveLength(1);
  });

  it("goes on from a base the session took from the file (Л4.2)", () => {
    const session = setup();
    session.queue.rebase("hash-disk", "disk body");
    session.type("disk body!");
    expect(session.writes.map((write) => write.request)).toEqual([{ baseBodyHash: "hash-disk", body: "disk body!" }]);
  });
});

describe("SaveQueue when the note is gone and back, and after a conflict (SPEC_EDITING.md, Л4.3, Л4.9)", () => {
  it("stops when the note is learned gone, writes nothing, and goes on with its edits when the note is back", async () => {
    const session = setup();
    session.type("one");
    await session.answer();
    session.queue.stop({ kind: "source_not_found" });
    expect(session.queue.state).toBe("stopped");
    expect(session.events).toContain("failed stop");
    session.type("one two");
    expect(session.writes).toHaveLength(0);
    session.queue.resume();
    expect(session.events).toContain("recovered");
    expect(session.writes.map((write) => write.request)).toEqual([{ baseBodyHash: "hash-1", body: "one two" }]);
  });

  it("does not stop a write under way: the write finds the note gone itself", () => {
    const session = setup();
    session.type("one");
    session.queue.stop({ kind: "source_not_found" });
    expect(session.queue.state).toBe("saving");
  });

  it("leaves a conflict when the file comes to hold the document's text", async () => {
    const session = setup();
    session.type("mine");
    session.dispositions.set("stale", "conflict");
    await session.refuse("stale");
    expect(session.queue.state).toBe("conflict");
    session.queue.rebase("hash-disk", "mine");
    expect(session.queue.state).toBe("idle");
    expect(session.queue.dirty).toBe(false);
    session.type("mine!");
    expect(session.writes.map((write) => write.request)).toEqual([{ baseBodyHash: "hash-disk", body: "mine!" }]);
  });

  it("enters a conflict from a stop: the note came back other than the session knew it", () => {
    const session = setup();
    session.queue.stop({ kind: "source_not_found" });
    session.queue.enterConflict({ kind: "changed" });
    expect(session.queue.state).toBe("conflict");
    expect(session.events).toContain("conflict");
  });

  it("counts the writes it starts, so an older answer about the file is known to be older", async () => {
    const session = setup();
    expect(session.queue.writes).toBe(0);
    session.type("a");
    expect(session.queue.writes).toBe(1);
    session.type("ab");
    await session.answer();
    expect(session.queue.writes).toBe(2);
  });
});
