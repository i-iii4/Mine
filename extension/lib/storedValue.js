// Storage preserves JSON values, not object insertion order. Arrays retain order.
(function (root) {
  "use strict";
  function canonical(value) {
    return JSON.stringify(value, (_key, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
    });
  }
  /** Compare complete JSON storage values independently of object key order. */
  function same(left, right) { return canonical(left) === canonical(right); }
  root.MineStoredValue = Object.freeze({ same });
})(globalThis);
