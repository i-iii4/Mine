// Whether the Mine buttons stand on the posts of X and of Instagram: two
// switches of the clipper's "…" menu, kept in the extension's storage and
// followed by every open page at once (SPEC_CLIPPER.md, «Доработки после
// живого просмотра», пункт 5 и Р11). Shared by the content scripts and the
// clipper.
(function (root) {
  "use strict";

  const STORAGE_KEY = "mineFeedButtons";
  const DEFAULTS = Object.freeze({ x: true, instagram: true });

  /// The switches as stored; each one is on until it was turned off.
  function normalize(value) {
    const stored = typeof value === "object" && value !== null ? value : {};
    return { x: stored.x !== false, instagram: stored.instagram !== false };
  }

  /// The switches now, from `chrome.storage.local`. Storage that cannot be
  /// read leaves both on, as they were before the switches existed.
  async function read(local) {
    try {
      return normalize((await local.get(STORAGE_KEY))?.[STORAGE_KEY]);
    } catch {
      return { ...DEFAULTS };
    }
  }

  /// Calls `onChange` with the switches whenever any tab changes them.
  /// Returns the function that stops it.
  function watch(storage, onChange) {
    const listener = (changes, area) => {
      if (area === "local" && changes?.[STORAGE_KEY]) onChange(normalize(changes[STORAGE_KEY].newValue));
    };
    storage.onChanged.addListener(listener);
    return () => storage.onChanged.removeListener(listener);
  }

  root.MineFeedButtonSettings = { STORAGE_KEY, DEFAULTS, normalize, read, watch };
})(globalThis);
