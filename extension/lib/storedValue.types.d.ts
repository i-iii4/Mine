declare global {
  // Written exactly as extension/popup/lib/saveOperation.ts declares it:
  // two declarations of one global must have the identical type.
  var MineStoredValue: Readonly<{ same(left: unknown, right: unknown): boolean }>;
}

export {};
