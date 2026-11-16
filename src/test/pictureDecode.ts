import { vi } from "vitest";

/// jsdom has no `HTMLImageElement.decode()`, and product code asks whether
/// the method is there before it calls it (usePreparedPicture, Detail). A
/// test of picture preparation installs the method for its own run; the
/// engine's answer is covered by `bun run test:feed-images`.
export function installPictureDecode(
  implementation: (this: HTMLImageElement) => Promise<void> = () => Promise.resolve(),
) {
  const decode = vi.fn(implementation);
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    writable: true,
    value: decode,
  });
  return {
    decode,
    restore: () => {
      Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    },
  };
}
