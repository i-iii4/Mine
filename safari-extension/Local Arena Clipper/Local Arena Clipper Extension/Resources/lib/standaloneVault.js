// Browser platform adapter: all document/naming/layout/recovery rules run in
// Rust/WASM. IndexedDB stores identity, prepared payloads and durable receipts.
(function (root) {
  "use strict";
  const capabilities = Object.freeze({ save_operation_v1: true, operation_lookup_v1: true,
    atomic_no_clobber: false, durable_flush: false, serialized_extension_writes: true });
  let queue = Promise.resolve();
  function serialized(task) {
    const result = queue.then(() => root.navigator?.locks
      ? root.navigator.locks.request("mine-vault-writer", task) : task());
    queue = result.catch(() => undefined);
    return result;
  }
  const core = (command) => root.MineCore.call(command);
  const join = (dir, name) => dir ? `${dir}/${name}` : name;
  const missing = (error) => error?.name === "NotFoundError";
  function error(code, message) { return Object.assign(new Error(message), { code }); }
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const newId = () => root.crypto.randomUUID();

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
  async function transaction(stores, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try { result = run(tx); } catch (failure) { db.close(); reject(failure); return; }
      tx.oncomplete = () => { const value = result?.result; db.close(); resolve(value); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? error("storage_error", "Operation journal could not be committed")); };
    });
  }
  const persisted = {
    get: (store, key) => transaction([store], "readonly", tx => tx.objectStore(store).get(key)),
    put: (store, key, value) => transaction([store], "readwrite", tx => tx.objectStore(store).put(value, key)),
    all: (store) => transaction([store], "readonly", tx => tx.objectStore(store).getAll()),
  };
  const storage = options => options?.store ?? persisted;

  async function storeDirectoryHandle(handle) {
    // Same display name is NOT the same folder. Preserve binding on regrant.
    const known = await persisted.all("bindings");
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
  const loadDirectoryHandle = async (bindingId) => bindingId
    ? (await persisted.get("bindings", bindingId))?.handle ?? null
    : (await persisted.get("vault", "directory")) ?? null;
  async function clearDirectoryHandle() {
    await transaction(["vault"], "readwrite", tx => {
      tx.objectStore("vault").delete("binding");
      tx.objectStore("vault").delete("directory");
    });
    // Pending operations and their original handles survive a folder switch.
  }
  async function selectedBinding(options) {
    if (options?.directory) return { id: options.binding_id ?? "test-vault", handle: options.directory };
    const id = await persisted.get("vault", "binding");
    if (id) return persisted.get("bindings", id);
    const legacy = await loadDirectoryHandle();
    if (!legacy) return null;
    await storeDirectoryHandle(legacy);
    return selectedBinding();
  }
  async function requirePermission(handle) {
    if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw error("permission_required", "Restore access to the saved folder in the Mine extension window");
    }
  }
  async function directory(handle, path, create = false) {
    let current = handle;
    for (const segment of path.split("/").filter(Boolean)) current = await current.getDirectoryHandle(segment, { create });
    return current;
  }
  async function fileAt(handle, path, create = false) {
    const split = path.lastIndexOf("/");
    const parent = await directory(handle, split < 0 ? "" : path.slice(0, split), create);
    return parent.getFileHandle(path.slice(split + 1), { create });
  }
  async function existsDirectory(handle, path) {
    try { await directory(handle, path); return true; } catch (failure) { if (missing(failure)) return false; throw failure; }
  }
  async function resolveLayout(handle) {
    let stored = null;
    try { stored = JSON.parse(await (await (await fileAt(handle, ".mine/layout.json")).getFile()).text()); }
    catch (failure) { if (!missing(failure)) throw failure; }
    let empty = true;
    for await (const [name] of handle.entries()) if (!name.startsWith(".")) { empty = false; break; }
    const [cards, media, collections] = await Promise.all(["Cards", "Media", "Collections"].map(path => existsDirectory(handle, path)));
    return core({ op: "detect_layout", stored, empty, cards, media, collections });
  }
  async function existingStems(handle, prefix = "", result = []) {
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith(".")) continue;
      if (entry.kind === "directory") await existingStems(await handle.getDirectoryHandle(name), join(prefix, name), result);
      else result.push(join(prefix, name.replace(/\.[^.]+$/, "")));
    }
    return result;
  }
  async function ensureLayout(handle, layout) {
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
    if (["cards", "media", "collections"].some(key => normalized[key] !== layout[key])) {
      throw error("layout_changed", "Folder layout changed since this operation was prepared");
    }
    for (const path of [layout.cards, layout.media, layout.collections]) await directory(handle, path, true);
  }
  async function hash(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : await data.arrayBuffer();
    return Array.from(new Uint8Array(await root.crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  }
  async function evidence(handle, path, expectedHash) {
    try { return await hash(await (await fileAt(handle, path)).getFile()) === expectedHash ? "matches" : "conflict"; }
    catch (failure) { return missing(failure) ? "missing" : "unreadable"; }
  }
  async function publish(handle, path, data) {
    // FSA has no O_EXCL: this prevents known conflicts, not external races.
    try { await fileAt(handle, path); throw error("name_conflict", `File already exists: ${path}`); }
    catch (failure) { if (!missing(failure)) throw failure; }
    const file = await fileAt(handle, path, true);
    const writer = await file.createWritable();
    try { await writer.write(data); await writer.close(); }
    catch (failure) { try { await writer.abort(); } catch { /* already closed/disconnected */ } throw failure; }
  }
  function mediaExtension(type) {
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
      "image/avif": "avif", "image/heic": "heic", "video/mp4": "mp4", "video/webm": "webm",
    }[String(type).split(";")[0].trim().toLowerCase()];
    if (!extension) throw error("unsupported_media", "Unsupported downloaded media type");
    return extension;
  }
  async function preparedMedia(request, options) {
    const url = request.screenshot_data_url || request.image_url;
    if (!url) return null;
    const response = await (options?.fetch ?? root.fetch)(url);
    if (!response.ok) throw error("download_failed", `Image download failed: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw error("missing_media", "Downloaded media is empty");
    return { blob, extension: mediaExtension(blob.type), hash: await hash(blob) };
  }
  function result(record) {
    return { ok: true, outcome: "committed", operation_id: record.id, binding_id: record.binding,
      executor_id: "browser", standalone: true, slug: record.slug, block_type: record.block_type,
      ...(record.kind === "collection" ? { tag: record.slug } : {}) };
  }
  function failed(id, failure, outcome = "not_committed") {
    return { ok: false, outcome, operation_id: id, executor_id: "browser", standalone: true,
      code: failure?.code ?? "storage_error", error: String(failure?.message ?? failure) };
  }
  const unknown = id => failed(id, error("operation_unknown", "Save outcome is unknown. Check the original folder; Mine will not create another copy."), "unknown");
  async function advance(record, binding, store, options, execute) {
    if (record.phase === "committed") return result(record);
    if (record.phase === "rejected") return record.response;
    await requirePermission(binding.handle);
    if (execute && record.phase === "prepared") await ensureLayout(binding.handle, record.layout);
    const md = await evidence(binding.handle, `${record.slug}.md`, record.hash);
    const media = record.media ? await evidence(binding.handle, record.media.path, record.media.hash) : "not_required";
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
      record.phase = "media_publishing";
      await store.put("operations", record.id, record);
      await publish(binding.handle, record.media.path, record.media.blob);
      await options?.afterEffect?.("media", record);
      record.phase = "media_published";
      await store.put("operations", record.id, record);
      return advance(record, binding, store, options, true);
    }
    if (action === "publish_markdown") {
      record.phase = "markdown_publishing";
      await store.put("operations", record.id, record);
      await publish(binding.handle, `${record.slug}.md`, record.markdown);
      await options?.afterEffect?.("markdown", record);
      record.phase = "source_committed";
      await store.put("operations", record.id, record);
      return advance(record, binding, store, options, true);
    }
    const receipt = { id: record.id, binding: record.binding, fingerprint: record.fingerprint,
      phase: "committed", slug: record.slug, block_type: record.block_type, kind: record.kind };
    await store.put("operations", record.id, receipt);
    return result(receipt);
  }
  async function bindingFor(record, options) {
    if (options?.directory) {
      const binding = await selectedBinding(options);
      return binding.id === record.binding ? binding : null;
    }
    return storage(options).get("bindings", record.binding);
  }
  function semanticRequest(request) {
    const value = { ...request };
    for (const key of ["operation_id", "operation_mode", "mode", "binding_id", "executor_id", "vault_path"]) delete value[key];
    return value;
  }
  async function save(request, options, kind = "capture") {
    const id = request.operation_id || newId();
    const store = storage(options);
    let record;
    let fresh = false;
    let fingerprint;
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw error("invalid_request", "Invalid operation identity");
      if (request.executor_id && request.executor_id !== "browser") throw error("binding_mismatch", "Save belongs to another executor");
      fingerprint = await core({ op: "fingerprint", value: JSON.stringify({ kind, request: semanticRequest(request) }) });
      record = await store.get("operations", id);
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
      const layout = await resolveLayout(binding.handle);
      const media = kind === "capture" ? await preparedMedia(request, options) : null;
      const namingLayout = kind === "collection" ? { ...layout, cards: layout.collections } : layout;
      const named = await core({ op: "name", title: request.title ?? null, url: request.url ?? null,
        layout: namingLayout, existing: await existingStems(binding.handle) });
      if (media) media.path = join(layout.media, `${named.name}.${media.extension}`);
      const document = kind === "collection"
        ? await core({ op: "collection", slug: named.slug, saved_at: request.saved_at ?? now() })
        : await core({ op: "capture", request: { slug: named.slug, block_type: request.block_type,
          title: request.title ?? null, url: request.url ?? null, body: request.body ?? "", file: media?.path ?? null,
          thumbnail: null, tags: request.tags ?? [], saved_at: request.saved_at ?? now(),
          source: "web-clipper", author: request.author ?? null, description: request.description ?? null,
          width: request.width ?? null, height: request.height ?? null } });
      record = { id, binding: binding.id, fingerprint, kind, phase: "prepared", layout,
        slug: named.slug, block_type: kind === "collection" ? "channel" : request.block_type,
        markdown: document.markdown, hash: await hash(document.markdown), media };
      await store.put("operations", id, record);
      await options?.afterPrepared?.(record);
      return await advance(record, binding, store, options, true);
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
      const mismatch = ["operation_conflict", "binding_mismatch"].includes(failure?.code);
      return failed(id, failure, !mismatch && record && record.phase !== "prepared" ? "unknown" : "not_committed");
    }
  }
  const saveStandaloneBlock = (request, options) => serialized(() => save(request, options));
  const createStandaloneChannel = (tag, options) => serialized(() => save({ title: tag, operation_id: newId() }, options, "collection"));
  async function lookupOperation(id, bindingId, options) {
    return serialized(async () => {
      try {
        const store = storage(options);
        const record = await store.get("operations", id);
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
  async function getStandaloneStatus(options) {
    try {
      const binding = await selectedBinding(options);
      if (!binding) return { configured: false, capabilities };
      return { configured: true, bindingId: binding.id, folderName: binding.handle.name,
        permission: await binding.handle.queryPermission({ mode: "readwrite" }), capabilities };
    } catch (failure) { return { configured: false, capabilities, error: String(failure?.message ?? failure) }; }
  }
  async function listStandaloneChannels(options) {
    try {
      const binding = await selectedBinding(options);
      if (!binding) throw error("folder_required", "Choose a folder first");
      await requirePermission(binding.handle);
      const channels = [];
      async function scan(handle, prefix = "") {
        for await (const [name, entry] of handle.entries()) {
          if (name.startsWith(".")) continue;
          if (entry.kind === "directory") { await scan(await handle.getDirectoryHandle(name), join(prefix, name)); continue; }
          if (!name.endsWith(".md")) continue;
          const slug = join(prefix, name.slice(0, -3));
          const markdown = await (await (await handle.getFileHandle(name)).getFile()).text();
          try { if ((await core({ op: "inspect", slug, markdown })).collection) channels.push({ tag: slug, block_count: 0 }); }
          catch (failure) { if (failure.code !== "invalid_request") throw failure; }
        }
      }
      await scan(binding.handle);
      channels.sort((a, b) => a.tag.localeCompare(b.tag));
      return { ok: true, channels };
    } catch (failure) { return failed(undefined, failure); }
  }
  root.MineStandaloneVault = { storeDirectoryHandle, loadDirectoryHandle, clearDirectoryHandle,
    resolveLayout, existingStems, getStandaloneStatus, saveStandaloneBlock, lookupOperation,
    createStandaloneChannel, listStandaloneChannels };
})(globalThis);
