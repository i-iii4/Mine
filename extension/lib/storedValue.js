// Storage preserves JSON values, not object insertion order. Arrays retain order.
(function (root) {
  "use strict";
  /** @param {unknown} value */
  function canonical(value) {
    return JSON.stringify(value, (_key, /** @type {unknown} */ item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      // Code unit order, the order `Array.prototype.sort` gives strings.
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    });
  }
  /**
   * Compare complete JSON storage values independently of object key order.
   * @param {unknown} left
   * @param {unknown} right
   */
  function same(left, right) { return canonical(left) === canonical(right); }
  root.MineStoredValue = Object.freeze({ same });
})(globalThis);
