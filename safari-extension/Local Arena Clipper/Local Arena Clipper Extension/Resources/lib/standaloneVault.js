// Browser platform adapter: all document/naming/layout/recovery rules run in
// Rust/WASM. IndexedDB stores identity, prepared payloads and durable receipts.
(function (root) {
  "use strict";
  /** @typedef {import("./standaloneVault.types").StandaloneOptions} StandaloneOptions */
  /** @typedef {import("./standaloneVault.types").StandaloneStore} StandaloneStore */
  /** @typedef {import("./standaloneVault.types").StandaloneSaveRequest} StandaloneSaveRequest */
  /** @typedef {import("./standaloneVault.types").StandaloneSaveReply} StandaloneSaveReply */
  /** @typedef {import("./standaloneVault.types").StandaloneCommitted} StandaloneCommitted */
  /** @typedef {import("./standaloneVault.types").StandaloneFailure} StandaloneFailure */
  /** @typedef {import("./standaloneVault.types").StandaloneStatusReply} StandaloneStatusReply */
  /** @typedef {import("./standaloneVault.types").StandaloneChannelsReply} StandaloneChannelsReply */
  /** @typedef {import("./standaloneVault.types").StandaloneMediaRecord} StandaloneMediaRecord */
  /** @typedef {import("./standaloneVault.types").StandaloneOperationRecord} StandaloneOperationRecord */
  /** @typedef {import("./standaloneVault.types").StandaloneReceipt} StandaloneReceipt */
  /** @typedef {import("./standaloneVault.types").StandaloneJournalEntry} StandaloneJournalEntry */
  /** @typedef {import("../../src/types/generated").CoreCommand} CoreCommand */
  /** @typedef {import("../../src/types/generated").CollectionPage} CollectionPage */
  /** @typedef {import("../../src/types/generated").PublicationEvidence} PublicationEvidence */
  /** @typedef {import("../../src/types/generated").SaveOutcome} SaveOutcome */
  /** @typedef {import("../../src/types/generated").VaultWriteLayout} VaultWriteLayout */
  /** @typedef {import("../../src/types/generated").VaultWriteLayoutDto} VaultWriteLayoutDto */
  /** A chosen folder and the id its journal entries name it by. @typedef {{ id: string, handle: FileSystemDirectoryHandle }} Binding */
  /** What the collection list learned of one note. @typedef {{ collection: boolean, position: number | null, collections: string[] }} NoteFacts */
  /** A note's facts with the modification time and size it had. @typedef {{ lastModified: number, size: number, note: NoteFacts | null }} NoteStamp */

  const capabilities = Object.freeze({ save_operation_v1: true, operation_lookup_v1: true,
    atomic_no_clobber: false, durable_flush: false, serialized_extension_writes: true });
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serialized(task) {
    // A lock request resolves with what the task's promise resolves to: the
    // lock is held until it settles. lib.dom types it as the promise itself.
    const result = queue.then(() => root.navigator?.locks
      ? /** @type {Promise<T>} */ (root.navigator.locks.request("mine-vault-writer", task)) : task());
    queue = result.catch(() => undefined);
    return result;
  }
  /**
   * @template {CoreCommand} C
   * @param {C} command
   */
  const core = (command) => root.MineCore.call(command);
  /**
   * @param {string} dir
   * @param {string} name
   */
  const join = (dir, name) => dir ? `${dir}/${name}` : name;
  /**
   * The field `key` of a thrown value, when it is an object that has one.
   * @param {unknown} value
   * @param {string} key
   * @returns {unknown}
   */
  const fieldOf = (value, key) => typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
  /** @param {unknown} error */
  const missing = (error) => fieldOf(error, "name") === "NotFoundError";
  /**
   * @param {string} code
   * @param {string} message
   */
  function error(code, message) { return Object.assign(new Error(message), { code }); }
  // saved_at fallback: the local wall clock without a zone, the same form as
  // popup/lib/savedAt.ts (Obsidian reads it as a date; a `Z` makes it text).
  /** @param {number} value */
  const pad = (value) => String(value).padStart(2, "0");
  const now = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const newId = () => root.crypto.randomUUID();

  /** @returns {Promise<IDBDatabase>} */
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open("mine-standalone", 2);
      request.onupgradeneeded = () => {
        for (const name of ["vault", "bindings", "operations"]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(error("storage_blocked", "Close other Mine setup windows and retry"));
    });
  }
  /**
   * The result of the request `run` makes, once the transaction commits;
   * `undefined` when `run` makes none to answer.
   * @template T
   * @param {string[]} stores
   * @param {IDBTransactionMode} mode
   * @param {(tx: IDBTransaction) => IDBRequest<T> | void} run
   * @returns {Promise<T | undefined>}
   */
  async function transaction(stores, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      /** @type {IDBRequest<T> | void} */
      let result;
      try { result = run(tx); } catch (failure) { db.close(); reject(failure); return; }
      tx.oncomplete = () => { const value = result?.result; db.close(); resolve(value); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? error("storage_error", "Operation journal could not be committed")); };
    });
  }
  const persisted = {
    /** @type {StandaloneStore["get"]} */
    get: (store, key) => transaction([store], "readonly", tx => tx.objectStore(store).get(key)),
    /** @type {StandaloneStore["put"]} */
    put: (store, key, value) => transaction([store], "readwrite", tx => tx.objectStore(store).put(value, key)),
    /** @type {(store: string) => Promise<unknown>} */
    all: (store) => transaction([store], "readonly", tx => tx.objectStore(store).getAll()),
  };
  /** @param {StandaloneOptions | undefined} options @returns {StandaloneStore} */
  const storage = options => options?.store ?? persisted;
  // Each store holds only what this file puts there: `vault` the chosen
  // binding's id under "binding" and its folder under "directory", `bindings`
  // each binding by id, `operations` each journal entry by id. A read is
  // therefore typed by what was put.
  /** @param {StandaloneStore} store @param {string} id */
  const readBinding = (store, id) => /** @type {Promise<Binding | undefined>} */ (store.get("bindings", id));
  /** @param {StandaloneStore} store @param {string} id */
  const readOperation = (store, id) => /** @type {Promise<StandaloneJournalEntry | undefined>} */ (store.get("operations", id));

  /** @param {FileSystemDirectoryHandle} handle */
  async function storeDirectoryHandle(handle) {
    // Same display name is NOT the same folder. Preserve binding on regrant.
    const known = /** @type {Binding[]} */ (await persisted.all("bindings"));
    /** @type {Binding | undefined} */
    let binding;
    for (const item of known) {
      if (await handle.isSameEntry(item.handle)) { binding = item; break; }
    }
    binding ??= { id: newId(), handle };
    await transaction(["vault", "bindings"], "readwrite", tx => {
      tx.objectStore("bindings").put(binding, binding.id);
      tx.objectStore("vault").put(binding.id, "binding");
      tx.objectStore("vault").put(handle, "directory");
    });
  }
  /**
   * @param {string} [bindingId]
   * @returns {Promise<FileSystemDirectoryHandle | null>}
   */
  const loadDirectoryHandle = async (bindingId) => bindingId
    ? (await readBinding(persisted, bindingId))?.handle ?? null
    : /** @type {FileSystemDirectoryHandle | undefined} */ (await persisted.get("vault", "directory")) ?? null;
  async function clearDirectoryHandle() {
    await transaction(["vault"], "readwrite", tx => {
      tx.objectStore("vault").delete("binding");
      tx.objectStore("vault").delete("directory");
    });
    // Pending operations and their original handles survive a folder switch.
  }
  /**
   * @param {StandaloneOptions} [options]
   * @returns {Promise<Binding | null | undefined>}
   */
  async function selectedBinding(options) {
    if (options?.directory) return { id: options.binding_id ?? "test-vault", handle: options.directory };
    const id = /** @type {string | undefined} */ (await persisted.get("vault", "binding"));
    if (id) return readBinding(persisted, id);
    const legacy = await loadDirectoryHandle();
    if (!legacy) return null;
    await storeDirectoryHandle(legacy);
    return selectedBinding();
  }
  /** @param {FileSystemDirectoryHandle} handle */
  async function requirePermission(handle) {
    if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw error("permission_required", "Restore access to the saved folder in the Mine extension window");
    }
  }
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} path
   * @param {boolean} [create]
   */
  async function directory(handle, path, create = false) {
    let current = handle;
    for (const segment of path.split("/").filter(Boolean)) current = await current.getDirectoryHandle(segment, { create });
    return current;
  }
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} path
   * @param {boolean} [create]
   */
  async function fileAt(handle, path, create = false) {
    const split = path.lastIndexOf("/");
    const parent = await directory(handle, split < 0 ? "" : path.slice(0, split), create);
    return parent.getFileHandle(path.slice(split + 1), { create });
  }
  /** @param {FileSystemDirectoryHandle} handle */
  async function resolveLayout(handle) {
    // The folder's own marker, as written; the core validates it.
    /** @type {VaultWriteLayout | null} */
    let stored = null;
    try { stored = JSON.parse(await (await (await fileAt(handle, ".mine/layout.json")).getFile()).text()); }
    catch (failure) { if (!missing(failure)) throw failure; }
    let initialized = false;
    try { await fileAt(handle, ".mine/vault-id"); initialized = true; }
    catch (failure) { if (!missing(failure)) throw failure; }
    if (!initialized) {
      try { await fileAt(handle, ".arena/vault-id"); initialized = true; }
      catch (failure) { if (!missing(failure)) throw failure; }
    }
    let empty = true;
    for await (const [name] of handle.entries()) if (!name.startsWith(".")) { empty = false; break; }
    const newSpace = stored === null && !initialized && empty;
    const layout = await core({ op: "detect_layout", stored, empty: newSpace, cards: false, media: false, collections: false });
    return { layout, newSpace };
  }
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} [prefix]
   * @param {string[]} [result]
   * @returns {Promise<string[]>}
   */
  async function existingPaths(handle, prefix = "", result = []) {
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith(".")) continue;
      if (entry.kind === "directory") await existingPaths(await handle.getDirectoryHandle(name), join(prefix, name), result);
      else result.push(join(prefix, name));
    }
    return result;
  }
  /** @param {FileSystemDirectoryHandle} handle */
  async function existingStems(handle) { return (await existingPaths(handle)).map(path => path.replace(/\.[^.]+$/, "")); }
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {VaultWriteLayoutDto} layout
   * @param {boolean} newSpace
   */
  async function ensureLayout(handle, layout, newSpace) {
    // The folder's own marker, as written; the core validates it.
    /** @type {VaultWriteLayout} */
    let recorded;
    try { recorded = JSON.parse(await (await (await fileAt(handle, ".mine/layout.json")).getFile()).text()); }
    catch (failure) {
      if (!missing(failure)) throw failure;
      // Record the decision before partial directory creation can change the
      // next detection from standard to flat. Existing markers are never replaced.
      await publish(handle, ".mine/layout.json", JSON.stringify(layout, null, 2) + "\n");
      recorded = layout;
    }
    const normalized = await core({ op: "layout", layout: recorded });
    if (/** @type {const} */ (["cards", "media", "collections"]).some(key => normalized[key] !== layout[key])) {
      throw error("layout_changed", "Folder layout changed since this operation was prepared");
    }
    if (newSpace) for (const path of [layout.cards, layout.media, layout.collections]) await directory(handle, path, true);
  }
  /** @param {string | Blob} data */
  async function hash(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : await data.arrayBuffer();
    return Array.from(new Uint8Array(await root.crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  }
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} path
   * @param {string} expectedHash
   * @returns {Promise<PublicationEvidence>}
   */
  async function evidence(handle, path, expectedHash) {
    try { return await hash(await (await fileAt(handle, path)).getFile()) === expectedHash ? "matches" : "conflict"; }
    catch (failure) { return missing(failure) ? "missing" : "unreadable"; }
  }
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {string} path
   * @param {string | Blob} data
   */
  async function publish(handle, path, data) {
    // FSA has no O_EXCL: this prevents known conflicts, not external races.
    try { await fileAt(handle, path); throw error("name_conflict", `File already exists: ${path}`); }
    catch (failure) { if (!missing(failure)) throw failure; }
    const file = await fileAt(handle, path, true);
    const writer = await file.createWritable();
    try { await writer.write(data); await writer.close(); }
    catch (failure) { try { await writer.abort(); } catch { /* already closed/disconnected */ } throw failure; }
  }
  // The save core names the file by its bytes, and by the type the server
  // declared only when the bytes are not a picture it recognises: a server
  // that negotiates formats answers a `.png` URL with AVIF (SPEC_SAVE_CORE.md,
  // «Имя медиафайла по содержимому»). 64 bytes is the core's IMAGE_HEAD_LEN.
  /** @param {Blob} blob */
  async function mediaExtension(blob) {
    const head = Array.from(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    const { extension } = await core({ op: "media_extension", head, content_type: blob.type || null });
    if (!extension) throw error("unsupported_media", "Unsupported downloaded media type");
    return extension;
  }
  /**
   * @param {StandaloneSaveRequest} request
   * @param {StandaloneOptions} [options]
   */
  async function preparedMedia(request, options) {
    const url = request.screenshot_data_url || request.image_url;
    if (!url) return null;
    const response = await (options?.fetch ?? root.fetch)(url);
    if (!response.ok) throw error("download_failed", `Image download failed: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw error("missing_media", "Downloaded media is empty");
    return { blob, extension: await mediaExtension(blob), hash: await hash(blob) };
  }
  // A collection answers with the reference cards name it by, not with the
  // path of its page: `Collections/Reference` tagged on a card splits one
  // collection into two rows (SPEC_AUDIT_FIXES.md, Б4.2).
  /**
   * @param {StandaloneOperationRecord | StandaloneReceipt} record
   * @returns {StandaloneCommitted}
   */
  function result(record) {
    return { ok: true, outcome: "committed", operation_id: record.id, binding_id: record.binding,
      executor_id: "browser", standalone: true, slug: record.slug, block_type: record.block_type,
      ...(record.kind === "collection" && typeof record.tag === "string" ? { tag: record.tag } : {}) };
  }
  // The reference of a new collection page, by the rule the collection list
  // follows (collection_ref_for_slug): the shortest Obsidian link that
  // resolves to the page. Its name is free among every note of the folder, so
  // the link is the bare name, whatever folder the layout puts it in.
  /**
   * @param {string} slug
   * @param {string[]} paths
   */
  async function collectionTag(slug, paths) {
    const page = `${slug}.md`;
    const notes = [...paths.filter(path => path.endsWith(".md")), page];
    return (await core({ op: "shortest_link", target: page, paths: notes, omit_md_ext: true })).target;
  }
  /**
   * A reply for `failure`. Its code is the executor's or the core's own; any
   * other thrown value (a DOMException's numeric `code` among them) is a
   * `storage_error`.
   * @param {string | undefined} id
   * @param {unknown} failure
   * @param {SaveOutcome} [outcome]
   * @returns {StandaloneFailure}
   */
  function failed(id, failure, outcome = "not_committed") {
    const code = fieldOf(failure, "code");
    const collection = fieldOf(failure, "collection");
    return { ok: false, outcome, operation_id: id, executor_id: "browser", standalone: true,
      code: typeof code === "string" ? code : "storage_error", error: String(fieldOf(failure, "message") ?? failure),
      ...(typeof collection === "string" ? { collection } : {}) };
  }
  // The collections among `tags` whose page is in the folder: a note
  // `<collections folder>/<name>.md` (also the name's own path for a
  // path-qualified one) with `type: channel`. These are the facts; the rule
  // over them is the core's, the same the helper applies
  // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К7).
  /**
   * @param {FileSystemDirectoryHandle} handle
   * @param {VaultWriteLayoutDto} layout
   * @param {string[]} tags
   */
  async function collectionsWithPages(handle, layout, tags) {
    /** @type {string[]} */
    const found = [];
    for (const tag of tags) {
      const slugs = [join(layout.collections, tag), ...(tag.includes("/") ? [tag] : [])];
      for (const slug of slugs) {
        let markdown;
        try { markdown = await (await (await fileAt(handle, `${slug}.md`)).getFile()).text(); }
        catch (failure) {
          // No such note, or a name the folder cannot hold: no page there.
          if (missing(failure) || fieldOf(failure, "name") === "TypeError") continue;
          throw failure;
        }
        try {
          if ((await core({ op: "inspect", slug, markdown })).collection) { found.push(tag); break; }
        } catch (failure) { if (fieldOf(failure, "code") !== "invalid_request") throw failure; }
      }
    }
    return found;
  }
  /** @param {string} id */
  const unknown = id => failed(id, error("operation_unknown", "Save outcome is unknown. Check the original folder; Mine will not create another copy."), "unknown");
  // `paths` is the folder's listing this save already read: one walk of the
  // tree serves naming and every check of the same run, the files the run
  // publishes being its own (SPEC_DEEP_AUDIT.md, Е3.10). A resume walks once.
  /**
   * @param {StandaloneJournalEntry} record
   * @param {Binding} binding
   * @param {StandaloneStore} store
   * @param {StandaloneOptions | undefined} options
   * @param {boolean} execute
   * @param {string[] | null} [paths]
   * @returns {Promise<StandaloneSaveReply>}
   */
  async function advance(record, binding, store, options, execute, paths = null) {
    if (record.phase === "committed") return result(record);
    if (record.phase === "rejected") return record.response;
    await requirePermission(binding.handle);
    if (execute && record.phase === "prepared") await ensureLayout(binding.handle, record.layout, record.newSpace);
    const md = await evidence(binding.handle, `${record.slug}.md`, record.hash);
    const media = record.media ? await evidence(binding.handle, record.media.path, record.media.hash) : "not_required";
    if (["prepared", "media_publishing", "media_published"].includes(record.phase)) {
      const targets = [`${record.slug}.md`, ...(record.media ? [record.media.path] : [])];
      const owned = new Set(targets);
      const names = new Set(targets.map(path => path.split("/").pop()));
      paths ??= await existingPaths(binding.handle);
      if (paths.some(path => !owned.has(path) && names.has(path.split("/").pop()))) {
        if (record.phase !== "prepared") return unknown(record.id);
        const response = { ...failed(record.id, error("name_conflict", "The planned filename became occupied elsewhere in the folder. Save again to choose a free name.")),
          binding_id: record.binding, terminal_rejected: true };
        await store.put("operations", record.id, { ...record, phase: "rejected", response });
        return response;
      }
    }
    const action = await core({ op: "advance", phase: record.phase, evidence: { markdown: md, media } });
    if (action === "unknown_outcome") return unknown(record.id);
    if (action === "name_conflict") {
      // The core can prove no card/media effect began only in Prepared.
      // Persist that terminal result before allowing an explicit new save to
      // collect fresh names. Retain the prepared material, including media.
      if (record.phase !== "prepared") return unknown(record.id);
      const response = { ...failed(record.id, error("name_conflict", "The selected filename is now occupied. No clip files were written; save again to choose a free name.")),
        binding_id: record.binding, terminal_rejected: true };
      await store.put("operations", record.id, { ...record, phase: "rejected", response });
      return response;
    }
    if (!execute && ["publish_media", "publish_markdown"].includes(action)) {
      return { ...failed(record.id, error("operation_prepared", "Prepared save can be resumed")), resumable: true, binding_id: record.binding };
    }
    if (action === "publish_media") {
      // The core asks to publish media only for a save that has a medium:
      // without one its evidence is `not_required`.
      const media = /** @type {StandaloneMediaRecord} */ (record.media);
      record.phase = "media_publishing";
      await store.put("operations", record.id, record);
      await publish(binding.handle, media.path, media.blob);
      await options?.afterEffect?.("media", record);
      record.phase = "media_published";
      await store.put("operations", record.id, record);
      return advance(record, binding, store, options, true, paths);
    }
    if (action === "publish_markdown") {
      record.phase = "markdown_publishing";
      await store.put("operations", record.id, record);
      await publish(binding.handle, `${record.slug}.md`, record.markdown);
      await options?.afterEffect?.("markdown", record);
      record.phase = "source_committed";
      await store.put("operations", record.id, record);
      return advance(record, binding, store, options, true, paths);
    }
    // Only these two steps record the save as committed. A step this adapter
    // does not know, from a core of another build, writes nothing and is
    // refused: it never passes for a save whose files were written
    // (SPEC_CLIPPER.md, К4).
    if (action !== "persist_receipt" && action !== "return_committed") {
      throw error("core_step_unknown", "This version of the Mine extension cannot finish the save. Reload the extension, then save again.");
    }
    /** @type {StandaloneReceipt} */
    const receipt = { id: record.id, binding: record.binding, fingerprint: record.fingerprint,
      phase: "committed", slug: record.slug, block_type: record.block_type, kind: record.kind,
      ...(typeof record.tag === "string" ? { tag: record.tag } : {}) };
    await store.put("operations", record.id, receipt);
    return result(receipt);
  }
  /**
   * @param {StandaloneJournalEntry} record
   * @param {StandaloneOptions} [options]
   */
  async function bindingFor(record, options) {
    if (options?.directory) {
      // A given folder always makes a binding.
      const binding = await selectedBinding(options);
      return binding?.id === record.binding ? binding : null;
    }
    return readBinding(storage(options), record.binding);
  }
  /** @param {StandaloneSaveRequest} request */
  function semanticRequest(request) {
    const value = { ...request };
    for (const key of ["operation_id", "operation_mode", "mode", "binding_id", "executor_id", "vault_path"]) delete value[key];
    return value;
  }
  /**
   * @param {StandaloneSaveRequest} request
   * @param {StandaloneOptions | undefined} options
   * @param {"capture" | "collection"} [kind]
   * @returns {Promise<StandaloneSaveReply>}
   */
  async function save(request, options, kind = "capture") {
    const id = request.operation_id || newId();
    const store = storage(options);
    /** @type {StandaloneJournalEntry | undefined} */
    let record;
    let fresh = false;
    /** @type {string | undefined} */
    let fingerprint;
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw error("invalid_request", "Invalid operation identity");
      if (request.executor_id && request.executor_id !== "browser") throw error("binding_mismatch", "Save belongs to another executor");
      fingerprint = await core({ op: "fingerprint", value: JSON.stringify({ kind, request: semanticRequest(request) }) });
      record = await readOperation(store, id);
      if (record) {
        if (record.fingerprint !== fingerprint) throw error("operation_conflict", "Operation identity belongs to another payload");
        if (request.binding_id && record.binding !== request.binding_id) throw error("binding_mismatch", "Operation belongs to another folder");
        if (record.phase === "committed") return result(record);
        if (record.phase === "rejected") return record.response;
        const binding = await bindingFor(record, options);
        if (!binding) return unknown(id);
        return await advance(record, binding, store, options, true);
      }
      if ((request.operation_mode ?? request.mode) === "resume") return unknown(id);
      if (request.operation_mode && request.operation_mode !== "start") throw error("invalid_request", "Invalid operation mode");
      fresh = true;
      const binding = await selectedBinding(options);
      if (!binding) throw error("folder_required", "Choose a folder in the Mine extension window");
      if (request.binding_id && request.binding_id !== binding.id) throw error("binding_mismatch", "The selected folder changed before this save began");
      await requirePermission(binding.handle);
      const { layout, newSpace } = await resolveLayout(binding.handle);
      if (kind === "capture") {
        // A clip joins only collections that have a page: one without
        // refuses the save before any effect (К7).
        const tags = request.tags ?? [];
        await core({ op: "collection_pages", selected: tags,
          with_pages: await collectionsWithPages(binding.handle, layout, tags) });
      }
      const prepared = kind === "capture" ? await preparedMedia(request, options) : null;
      const namingLayout = kind === "collection" ? { ...layout, cards: layout.collections } : layout;
      const paths = await existingPaths(binding.handle);
      const named = await core({ op: "name", title: request.title ?? null, url: request.url ?? null,
        layout: namingLayout, existing: paths });
      /** @type {StandaloneMediaRecord | null} */
      let media = null;
      if (prepared) {
        const mediaName = await core({ op: "unique_file_name", name: named.name,
          extension: prepared.extension, existing: paths });
        media = { ...prepared, path: join(layout.media, `${mediaName.name}.${prepared.extension}`) };
      }
      const file = media ? (await core({ op: "shortest_link", target: media.path,
        paths: [...paths, media.path], omit_md_ext: false })).target : null;
      // A new collection stands first, by the core's one rule over the
      // positions of the pages there are (SPEC_DEEP_AUDIT.md, Е6.2).
      const document = kind === "collection"
        ? await core({ op: "collection", slug: named.slug, saved_at: request.saved_at ?? now(),
          positions: (await readNotes(binding, options)).pages.map((page) => page.position ?? 0) })
        // A capture without a block type is refused here by the core, its
        // request lacking a required field, before anything is recorded.
        : await core({ op: "capture", request: { slug: named.slug, block_type: /** @type {string} */ (request.block_type),
          title: request.title ?? null, url: request.url ?? null, body: request.body ?? "", file,
          thumbnail: null, tags: request.tags ?? [], saved_at: request.saved_at ?? now(),
          author: request.author ?? null, description: request.description ?? null,
          width: request.width ?? null, height: request.height ?? null,
          selection: request.selection === true } });
      record = { id, binding: binding.id, fingerprint, kind, phase: "prepared", layout, newSpace,
        // A capture has a block type: the core refused it above otherwise.
        slug: named.slug, block_type: kind === "collection" ? "channel" : /** @type {string} */ (request.block_type),
        ...(kind === "collection" ? { tag: await collectionTag(named.slug, paths) } : {}),
        markdown: document.markdown, hash: await hash(document.markdown), media };
      await store.put("operations", id, record);
      await options?.afterPrepared?.(record);
      return await advance(record, binding, store, options, true, paths);
    } catch (failure) {
      if (fresh && !record) {
        // Acquisition/preflight failure before any source effect is terminal,
        // not unknown. Persist the rejection so a lost response can recover it.
        const response = { ...failed(id, failure), terminal_rejected: true };
        try {
          await store.put("operations", id, { id, binding: request.binding_id ?? "", fingerprint,
            phase: "rejected", response });
        } catch { /* this reply still proves this attempt performed no source effect */ }
        return response;
      }
      const code = fieldOf(failure, "code");
      const mismatch = typeof code === "string" && ["operation_conflict", "binding_mismatch"].includes(code);
      return failed(id, failure, !mismatch && record && record.phase !== "prepared" ? "unknown" : "not_committed");
    }
  }
  /**
   * @param {StandaloneSaveRequest} request
   * @param {StandaloneOptions} [options]
   * @returns {Promise<StandaloneSaveReply>}
   */
  const saveStandaloneBlock = (request, options) => {
    const rejection = root.MineSaveProtocol.validate(request);
    return rejection ? Promise.resolve(rejection) : serialized(() => save(request, options));
  };
  // The folder named at the action receives the collection; a folder chosen
  // since then refuses it (SPEC_AUDIT_FIXES.md, Ф6).
  /**
   * @param {string} tag
   * @param {string | null} bindingId
   * @param {StandaloneOptions} [options]
   */
  const createStandaloneChannel = (tag, bindingId, options) => serialized(() => save(
    { title: tag, operation_id: newId(), ...(bindingId ? { binding_id: bindingId } : {}) }, options, "collection"));
  /**
   * @param {string} id
   * @param {string} bindingId
   * @param {StandaloneOptions} [options]
   * @returns {Promise<StandaloneSaveReply>}
   */
  async function lookupOperation(id, bindingId, options) {
    return serialized(async () => {
      try {
        const store = storage(options);
        const record = await readOperation(store, id);
        if (!record) return unknown(id);
        if (record.binding !== bindingId) return failed(id, error("binding_mismatch", "Operation belongs to another folder"));
        if (record.phase === "committed") return result(record);
        if (record.phase === "rejected") return record.response;
        const binding = await bindingFor(record, options);
        if (!binding) return unknown(id);
        return await advance(record, binding, store, options, false);
      } catch (failure) { return failed(id, failure, "unknown"); }
    });
  }
  /**
   * @param {StandaloneOptions} [options]
   * @returns {Promise<StandaloneStatusReply>}
   */
  async function getStandaloneStatus(options) {
    try {
      const binding = await selectedBinding(options);
      if (!binding) return { configured: false, capabilities };
      return { configured: true, bindingId: binding.id, folderName: binding.handle.name,
        permission: await binding.handle.queryPermission({ mode: "readwrite" }), capabilities };
    } catch (failure) { return { configured: false, capabilities, error: String(fieldOf(failure, "message") ?? failure) }; }
  }
  // What the collection list learned of each note of a folder, by its path,
  // with the modification time and size the note had: the next list reads
  // again only the notes that changed (SPEC_DEEP_AUDIT.md, Е3.10). Derived
  // data in a database of its own, beside the folder handles; losing it
  // costs one full read.
  /** @returns {Promise<IDBDatabase>} */
  function openNotesDb() {
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open("mine-standalone-notes", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("folders")) request.result.createObjectStore("folders");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  /**
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(folders: IDBObjectStore) => IDBRequest<T>} run
   * @returns {Promise<T>}
   */
  async function notesTransaction(mode, run) {
    const db = await openNotesDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["folders"], mode);
      const request = run(tx.objectStore("folders"));
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }
  /** @type {StandaloneStore} */
  const notesPersisted = {
    get: (_store, key) => notesTransaction("readonly", folders => folders.get(key)),
    put: (_store, key, value) => notesTransaction("readwrite", folders => folders.put(value, key)),
  };
  /** @param {StandaloneOptions | undefined} options @returns {StandaloneStore | null} */
  const notesStorage = options => options?.store ?? (root.indexedDB ? notesPersisted : null);
  /**
   * @param {string} bindingId
   * @param {StandaloneOptions | undefined} options
   * @returns {Promise<Record<string, NoteStamp>>}
   */
  async function knownNotes(bindingId, options) {
    try {
      const known = await notesStorage(options)?.get("notes", bindingId);
      // The cache holds only what rememberNotes put there.
      return known && typeof known === "object" ? /** @type {Record<string, NoteStamp>} */ (known) : {};
    } catch (failure) {
      console.warn("[Mine] collection list reads every note:", String(fieldOf(failure, "message") ?? failure));
      return {};
    }
  }
  /**
   * @param {string} bindingId
   * @param {Record<string, NoteStamp>} notes
   * @param {StandaloneOptions | undefined} options
   */
  async function rememberNotes(bindingId, notes, options) {
    try { await notesStorage(options)?.put("notes", bindingId, notes); }
    catch (failure) { console.warn("[Mine] collection list could not keep what it read:", String(fieldOf(failure, "message") ?? failure)); }
  }
  // The collection pages of the folder, with their positions, and each
  // card's `Mine Collections`, read through the notes cache.
  /**
   * @param {Binding} binding
   * @param {StandaloneOptions | undefined} options
   */
  async function readNotes(binding, options) {
    /** @type {CollectionPage[]} */
    const pages = [];
    /** @type {string[][]} */
    const memberships = [];
    const known = await knownNotes(binding.id, options);
    /** @type {Record<string, NoteStamp>} */
    const seen = {};
    /**
     * @param {FileSystemDirectoryHandle} handle
     * @param {string} [prefix]
     */
    async function scan(handle, prefix = "") {
      for await (const [name, entry] of handle.entries()) {
        if (name.startsWith(".")) continue;
        if (entry.kind === "directory") { await scan(await handle.getDirectoryHandle(name), join(prefix, name)); continue; }
        if (!name.endsWith(".md")) continue;
        const slug = join(prefix, name.slice(0, -3));
        const file = await (await handle.getFileHandle(name)).getFile();
        const stamped = typeof file.lastModified === "number";
        const previous = known[slug];
        /** @type {NoteFacts | null} */
        let note;
        if (stamped && previous && previous.lastModified === file.lastModified && previous.size === file.size) {
          note = previous.note;
        } else {
          note = null;
          try {
            const inspected = await core({ op: "inspect", slug, markdown: await file.text() });
            note = { collection: Boolean(inspected.collection), position: inspected.position ?? null,
              collections: Array.isArray(inspected.collections) ? inspected.collections : [] };
          } catch (failure) { if (fieldOf(failure, "code") !== "invalid_request") throw failure; }
        }
        if (stamped) seen[slug] = { lastModified: file.lastModified, size: file.size, note };
        if (note?.collection) pages.push({ slug, position: note.position });
        else if (note?.collections.length) memberships.push(note.collections);
      }
    }
    await scan(binding.handle);
    await rememberNotes(binding.id, seen, options);
    return { pages, memberships };
  }
  /**
   * @param {StandaloneOptions} [options]
   * @returns {Promise<StandaloneChannelsReply>}
   */
  async function listStandaloneChannels(options) {
    try {
      const binding = await selectedBinding(options);
      if (!binding) throw error("folder_required", "Choose a folder first");
      await requirePermission(binding.handle);
      // The same list the app shows: collection pages in their manual order
      // and how many cards each holds. A collection exists only as its page:
      // a name cards link without one is not listed
      // (SPEC_COLLECTIONS_OBSIDIAN_LINKS.md, К1 and К9).
      const { pages, memberships } = await readNotes(binding, options);
      const channels = await core({ op: "collections", pages, memberships });
      return { ok: true, channels };
    } catch (failure) { return failed(undefined, failure); }
  }
  root.MineStandaloneVault = { storeDirectoryHandle, loadDirectoryHandle, clearDirectoryHandle,
    resolveLayout, existingStems, getStandaloneStatus, saveStandaloneBlock, lookupOperation,
    createStandaloneChannel, listStandaloneChannels };
})(globalThis);
