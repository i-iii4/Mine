// WASM transport only. Document/save behavior is implemented in mine-core.
(function (root) {
  'use strict';
  const BINARY = 'generated/save-core/mine_core_bg.wasm';
  // The glue comes with the worker's code, which the browser keeps until the
  // extension reloads; the binary is read from disk, which an update replaces
  // meanwhile. The binary of the running build is kept here when it is first
  // read, so the glue always gets the binary of its own build
  // (SPEC_CLIPPER.md, К4).
  const KEPT_DATABASE = 'mine-save-core';
  const KEPT_STORE = 'binary';
  /** @type {Promise<void> | undefined} */
  let ready;

  function updated() {
    return Object.assign(new Error('Mine was updated. Close the clipper and open it again to save.'),
      { code: 'extension_updated' });
  }

  /**
   * The result of the request `run` makes on the kept store, once its
   * transaction completes.
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest<T>} run
   * @returns {Promise<T>}
   */
  function keptStore(mode, run) {
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open(KEPT_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(KEPT_STORE);
      request.onblocked = () => reject(new Error('The kept save core is in use elsewhere'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        try {
          const transaction = database.transaction(KEPT_STORE, mode);
          const result = run(transaction.objectStore(KEPT_STORE));
          transaction.oncomplete = () => { database.close(); resolve(result?.result); };
          transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error); };
        } catch (error) {
          database.close();
          reject(error);
        }
      };
    });
  }

  /// The binary kept for `buildId`, or `null`.
  /**
   * @param {string} buildId
   * @returns {Promise<ArrayBuffer | null>}
   */
  async function keptBinary(buildId) {
    if (!root.indexedDB) return null;
    try {
      /** @type {unknown} */
      const bytes = await keptStore('readonly', store => store.get(buildId));
      return bytes instanceof ArrayBuffer ? bytes : null;
    } catch {
      return null;
    }
  }

  /// Keep `bytes` as the binary of `buildId`, and only it. A store that
  /// refuses leaves the next start of the worker to read the file again.
  /**
   * @param {string} buildId
   * @param {ArrayBuffer} bytes
   */
  async function keepBinary(buildId, bytes) {
    if (!root.indexedDB) return;
    try {
      await keptStore('readwrite', store => { store.clear(); return store.put(bytes, buildId); });
    } catch (error) {
      const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
      console.warn('[Mine] the save core binary was not kept:', String(message ?? error));
    }
  }

  async function forgetBinaries() {
    if (!root.indexedDB) return;
    try { await keptStore('readwrite', store => store.clear()); } catch { /* the next load reads the file */ }
  }

  /// The binary for the glue: the one kept for the running build, else the
  /// file on disk while the disk holds that build. An update that replaced the
  /// files refuses the load and makes the reload into it pending: nothing of
  /// another build reaches this glue. A worker without a build reads the file.
  /** @returns {Promise<{ source: string | ArrayBuffer, kept: boolean }>} */
  async function binary() {
    const extension = root.MineExtensionBuild;
    const build = extension?.running() ?? null;
    if (build === null) return { source: root.chrome.runtime.getURL(BINARY), kept: false };
    const kept = await keptBinary(build.buildId);
    if (kept) return { source: kept, kept: true };
    if (await extension.filesOfRunningBuild() !== 'same') throw updated();
    const response = await root.fetch(root.chrome.runtime.getURL(BINARY));
    if (!response.ok) throw new Error(`Mine save core is unavailable (${response.status})`);
    const bytes = await response.arrayBuffer();
    // Files replaced while they were read may have given bytes of either build.
    if (await extension.filesOfRunningBuild() !== 'same') throw updated();
    await keepBinary(build.buildId, bytes);
    return { source: bytes, kept: false };
  }

  /** @param {typeof wasm_bindgen} runtime */
  async function load(runtime) {
    const { source, kept } = await binary();
    try {
      await runtime({ module_or_path: source });
    } catch (error) {
      // A kept binary the engine refuses goes: the next load reads the file.
      if (kept) await forgetBinaries();
      throw error;
    }
  }

  async function initialize() {
    // wasm-bindgen's no-modules glue declares a global lexical `let`.
    // Classic worker scripts can resolve that binding, but globalThis does
    // not expose it as a property. `root` only publishes the transport API.
    if (typeof wasm_bindgen !== 'function') throw new Error('Mine save core glue is not loaded');
    const runtime = wasm_bindgen;
    if (!ready) {
      ready = load(runtime).catch(error => { ready = undefined; throw error; });
    }
    await ready;
    return runtime;
  }
  /**
   * The envelope `execute_json` answers (mine-core/src/save.rs).
   * @typedef {{ ok: true, value: unknown }
   *   | { ok: false, error: { code: string, message: string, collection?: unknown } }} CoreEnvelope
   */

  root.MineCore = {
    /**
     * Dispatch the generated Rust command; no JavaScript fallback engine exists.
     * @template {import("../../src/types/generated").CoreCommand} C
     * @param {C} command
     * @returns {Promise<import("./mineCore.types").CoreResults[C["op"]]>}
     */
    async call(command) {
      const runtime = await initialize();
      // The core's own JSON envelope, written by the build of this glue.
      /** @type {CoreEnvelope} */
      const response = JSON.parse(runtime.execute_json(JSON.stringify(command)));
      if (!response.ok) {
        const error = Object.assign(new Error(response.error.message), { code: response.error.code });
        // The collection a `collection_not_found` names; clients never read
        // it out of the message.
        throw typeof response.error.collection === "string"
          ? Object.assign(error, { collection: response.error.collection })
          : error;
      }
      // The core answers the result of the command's own `op`
      // (mine-core/src/save.rs, `execute`; typed in mineCore.types.d.ts).
      return /** @type {import("./mineCore.types").CoreResults[C["op"]]} */ (response.value);
    },
  };
})(globalThis);
