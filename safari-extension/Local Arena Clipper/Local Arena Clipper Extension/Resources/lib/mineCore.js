// WASM transport only. Document/save behavior is implemented in mine-core.
(function (root) {
  'use strict';
  let ready;
  async function initialize() {
    // wasm-bindgen's no-modules glue declares a global lexical `let`.
    // Classic worker scripts can resolve that binding, but globalThis does
    // not expose it as a property. `root` only publishes the transport API.
    if (typeof wasm_bindgen !== 'function') throw new Error('Mine save core glue is not loaded');
    const runtime = wasm_bindgen;
    if (!ready) {
      ready = runtime({
        module_or_path: chrome.runtime.getURL('generated/save-core/mine_core_bg.wasm'),
      }).catch(error => { ready = undefined; throw error; });
    }
    await ready;
    return runtime;
  }
  root.MineCore = {
    /** Dispatch the generated Rust command; no JavaScript fallback engine exists. */
    async call(command) {
      const runtime = await initialize();
      const response = JSON.parse(runtime.execute_json(JSON.stringify(command)));
      if (!response.ok) {
        const error = new Error(response.error.message);
        error.code = response.error.code;
        throw error;
      }
      return response.value;
    },
  };
})(globalThis);
