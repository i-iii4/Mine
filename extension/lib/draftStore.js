// The service worker owns serialized draft writes. Storage acknowledgement and
// readback precede success; unknown formats and revisions are never overwritten.
(function (root) {
  "use strict";
  const FORMAT = 1;
  const PREFIX = "mineDurableDraft:";
  let queue = Promise.resolve();
  function serialized(task) {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }
  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  function key(sourceUrl) {
    if (typeof sourceUrl !== "string" || !sourceUrl) throw failure("invalid_draft", "Draft source is missing");
    return PREFIX + sourceUrl;
  }
  function validate(record) {
    if (!record || record.schemaVersion !== FORMAT || !Number.isSafeInteger(record.revision)
      || record.revision < 1 || typeof record.draftId !== "string" || !record.draftId
      || !record.state || typeof record.state !== "object") {
      throw failure("unknown_draft_format", "The saved draft format is unknown or damaged and has been preserved");
    }
    return record;
  }
  async function read(sourceUrl, storage = root.chrome.storage.local) {
    const name = key(sourceUrl);
    const values = await storage.get(name);
    return values[name] === undefined ? null : validate(values[name]);
  }
  function write(sourceUrl, record, expectedRevision, storage = root.chrome.storage.local) {
    return serialized(async () => {
      validate(record);
      const previous = await read(sourceUrl, storage);
      if ((previous?.revision ?? 0) !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw failure("draft_conflict", "This draft changed in another Mine window. Reopen it before editing");
      }
      const name = key(sourceUrl);
      await storage.set({ [name]: record });
      const confirmed = await read(sourceUrl, storage);
      if (JSON.stringify(confirmed) !== JSON.stringify(record)) {
        throw failure("draft_not_confirmed", "The draft write could not be confirmed");
      }
      return confirmed;
    });
  }
  function clear(sourceUrl, draftId, expectedRevision, storage = root.chrome.storage.local) {
    return serialized(async () => {
      const previous = await read(sourceUrl, storage);
      if (!previous) return;
      if (previous.draftId !== draftId || previous.revision !== expectedRevision) throw failure("draft_conflict", "A different or newer draft now owns this page");
      await storage.remove(key(sourceUrl));
    });
  }
  root.MineDraftStore = Object.freeze({ read, write, clear });
})(globalThis);
