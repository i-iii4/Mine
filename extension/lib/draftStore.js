// The service worker owns serialized draft writes. Storage acknowledgement and
// readback precede success; unknown formats and revisions are never overwritten.
(function (root) {
  "use strict";
  const FORMAT = 1;
  const PREFIX = "mineDurableDraft:";
  const RECORD_PREFIX = "mineDurableDraftRecord:";
  const INDEX_PREFIX = "mineDurableDraftIndex:";
  const LEGACY_PREFIX = "mineDurableDraftMigration:";
  let queue = Promise.resolve();
  function serialized(task) {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }
  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  async function fingerprint(value) {
    const bytes = new root.TextEncoder().encode(JSON.stringify(value));
    const hash = await root.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }
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
  async function readStored(sourceUrl, storage) {
    const name = key(sourceUrl);
    const values = await storage.get(name);
    return values[name] === undefined ? null : validate(values[name]);
  }
  function read(sourceUrl, storage = root.chrome.storage.local) {
    return serialized(() => readStored(sourceUrl, storage));
  }
  async function recordFor(draftId, storage) {
    const name = RECORD_PREFIX + draftId;
    const record = (await storage.get(name))[name];
    if (record === undefined) return null;
    if (record.schemaVersion !== 2 || record.draftId !== draftId || typeof record.ownerId !== "string"
      || !Number.isSafeInteger(record.generation) || record.generation < 1 || typeof record.sourceUrl !== "string") {
      throw failure("unknown_draft_format", "The saved draft format is unknown or damaged and has been preserved");
    }
    if (record.draft !== null) validate(record.draft);
    return record;
  }
  async function confirm(name, value, storage) {
    await storage.set({ [name]: value });
    if (!root.MineStoredValue.same((await storage.get(name))[name], value)) {
      throw failure("draft_not_confirmed", "The draft write could not be confirmed. Retry to check its outcome");
    }
  }
  // Attach is a durable ownership handoff, ordered with every mutation.
  function attach(sourceUrl, options, storage = root.chrome.storage.local) {
    return serialized(async () => {
      key(sourceUrl);
      if (!options || typeof options.ownerId !== "string" || !options.ownerId || typeof options.captureId !== "string" || !options.captureId) {
        throw failure("invalid_draft", "Draft owner or capture is missing");
      }
      const scope = String(options.captureScope ?? "default");
      const session = typeof options.captureSession === "string" ? options.captureSession : undefined;
      const indexName = INDEX_PREFIX + JSON.stringify([sourceUrl, scope]);
      const indexed = (await storage.get(indexName))[indexName];
      if (indexed !== undefined && typeof indexed !== "string") throw failure("unknown_draft_format", "The saved draft index is damaged and has been preserved");
      let draftId = options.newCapture ? options.captureId : typeof indexed === "string" ? indexed : options.captureId;
      let record = await recordFor(draftId, storage);
      // A tab number is a discovery hint, never durable capture identity. A
      // browser restart can reuse it for a different, simultaneously open tab.
      if (!options.newCapture && record && (record.captureScope !== scope
        || (session !== undefined && record.captureSession !== undefined && record.captureSession !== session))) record = null;
      if (!record) draftId = options.captureId;
      if (!record && !options.newCapture && session !== undefined) {
        const active = new Set(options.activeScopes ?? []);
        const candidates = [];
        const values = await storage.get(null);
        for (const [name, value] of Object.entries(values)) {
          if (!name.startsWith(RECORD_PREFIX) || value?.sourceUrl !== sourceUrl || !value.draft) continue;
          const candidate = await recordFor(name.slice(RECORD_PREFIX.length), storage);
          if (!candidate) continue;
          if ((candidate.captureSession !== undefined && candidate.captureSession !== session)
            || !active.has(candidate.captureScope)) candidates.push(candidate);
        }
        if (candidates.length > 1) throw failure("draft_ambiguous", "Several earlier clips from this page are preserved. This editor will save the clip shown here");
        if (candidates.length === 1) { record = candidates[0]; draftId = record.draftId; }
      }
      if (!record && !options.newCapture) {
        const legacy = await readStored(sourceUrl, storage);
        const legacyFingerprint = legacy ? await fingerprint(legacy) : null;
        const migrationName = LEGACY_PREFIX + sourceUrl;
        const migratedFingerprint = (await storage.get(migrationName))[migrationName];
        const migrated = legacy ? await recordFor(legacy.draftId, storage) : null;
        if (legacy && (migrated || legacyFingerprint !== migratedFingerprint) && (!migrated || migrated.captureScope === scope)) {
          draftId = legacy.draftId;
          record = migrated ?? { schemaVersion: 2, sourceUrl, captureScope: scope, draftId,
            draft: legacy, ownerId: options.ownerId, generation: 1, lastMutation: null, legacyFingerprint };
        }
      }
      if (record && record.sourceUrl !== sourceUrl) {
        throw failure("invalid_draft", "This capture belongs to a different source");
      }
      const next = record ? { ...record, captureScope: scope, ...(session === undefined ? {} : { captureSession: session }), ownerId: options.ownerId,
        generation: record.ownerId === options.ownerId ? record.generation : record.generation + 1,
        lastMutation: record.ownerId === options.ownerId ? record.lastMutation : null }
        : { schemaVersion: 2, sourceUrl, captureScope: scope, draftId, draft: null,
          ...(session === undefined ? {} : { captureSession: session }), ownerId: options.ownerId, generation: 1, lastMutation: null };
      await confirm(RECORD_PREFIX + draftId, next, storage);
      if (next.legacyFingerprint) await confirm(LEGACY_PREFIX + sourceUrl, next.legacyFingerprint, storage);
      await confirm(indexName, draftId, storage);
      return { draft: next.draft, draftId, generation: next.generation, sequence: next.lastMutation?.sequence ?? 0 };
    });
  }
  function writeOwned(sourceUrl, draft, expectedRevision, ownership, storage = root.chrome.storage.local) {
    return serialized(async () => {
      validate(draft);
      const record = await recordFor(draft.draftId, storage);
      if (!record || record.sourceUrl !== sourceUrl || record.ownerId !== ownership?.ownerId || record.generation !== ownership.generation) {
        throw failure("draft_owner_replaced", "This editor was reopened. Its confirmed draft is preserved; reopen to continue");
      }
      if (typeof ownership.mutationId !== "string" || !ownership.mutationId) throw failure("invalid_draft", "Draft mutation is missing");
      if (ownership.sequence !== undefined) {
        if (!Number.isSafeInteger(ownership.sequence) || ownership.sequence < 1) throw failure("invalid_draft", "Draft snapshot sequence is invalid");
        const previousSequence = record.lastMutation?.sequence ?? 0;
        if (record.lastMutation?.id === ownership.mutationId && ownership.sequence !== previousSequence) throw failure("invalid_draft", "A draft retry changed its sequence");
        if (ownership.sequence < previousSequence) throw failure("draft_snapshot_superseded", "A newer snapshot from this editor is already stored");
        if (ownership.sequence === previousSequence) {
          if (record.lastMutation.id !== ownership.mutationId || !root.MineStoredValue.same(record.draft.state, draft.state)) {
            throw failure("invalid_draft", "A draft retry changed its content");
          }
          return record.draft;
        }
        const confirmedDraft = { ...draft, revision: (record.draft?.revision ?? 0) + 1 };
        const next = { ...record, draft: confirmedDraft, lastMutation: { id: ownership.mutationId, sequence: ownership.sequence } };
        await confirm(RECORD_PREFIX + draft.draftId, next, storage);
        return next.draft;
      }
      if (record.lastMutation?.id === ownership.mutationId) {
        if (!root.MineStoredValue.same(record.draft, draft)) throw failure("invalid_draft", "A draft retry changed its content");
        return record.draft;
      }
      if ((record.draft?.revision ?? 0) !== expectedRevision || draft.revision !== expectedRevision + 1) {
        throw failure("draft_revision_mismatch", "The confirmed draft revision differs. Restore it before continuing; your edits are retained");
      }
      const next = { ...record, draft, lastMutation: { id: ownership.mutationId } };
      await confirm(RECORD_PREFIX + draft.draftId, next, storage);
      return next.draft;
    });
  }
  function write(sourceUrl, record, expectedRevision, storage = root.chrome.storage.local) {
    return serialized(async () => {
      validate(record);
      const previous = await readStored(sourceUrl, storage);
      if ((previous?.revision ?? 0) !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw failure("draft_conflict", "The confirmed draft revision differs. Reopen to restore it; your edits are retained");
      }
      const name = key(sourceUrl);
      await storage.set({ [name]: record });
      const confirmed = await readStored(sourceUrl, storage);
      if (!root.MineStoredValue.same(confirmed, record)) {
        throw failure("draft_not_confirmed", "The draft write could not be confirmed");
      }
      return confirmed;
    });
  }
  function clearOwned(sourceUrl, draftId, expectedRevision, ownership, storage = root.chrome.storage.local) {
    return serialized(async () => {
      const record = await recordFor(draftId, storage);
      if (!record) return;
      if (record.ownerId !== ownership?.ownerId || record.generation !== ownership.generation) {
        throw failure("draft_owner_replaced", "The reopened editor retains this draft after the earlier save");
      }
      if (record.sourceUrl !== sourceUrl || record.draft?.revision !== expectedRevision) throw failure("draft_conflict", "A newer draft is retained after this save");
      // Keep a migrated legacy copy until its original edition is confirmed.
      const legacy = await readStored(sourceUrl, storage);
      await storage.remove(RECORD_PREFIX + draftId);
      if (legacy?.draftId === draftId && record.legacyFingerprint && await fingerprint(legacy) === record.legacyFingerprint) await storage.remove(key(sourceUrl));
    });
  }
  function clear(sourceUrl, draftId, expectedRevision, storage = root.chrome.storage.local) {
    return serialized(async () => {
      const previous = await readStored(sourceUrl, storage);
      if (!previous) return;
      if (previous.draftId !== draftId || previous.revision !== expectedRevision) throw failure("draft_conflict", "A different or newer draft now owns this page");
      await storage.remove(key(sourceUrl));
    });
  }
  root.MineDraftStore = Object.freeze({ read, write, clear, attach, writeOwned, clearOwned });
})(globalThis);
