// The switches of the Mine buttons in the extension's storage, as pages see
// them (SPEC_CLIPPER.md, «Доработки после живого просмотра», Р11).

/// The extension's storage as a page sees it: the switches of the Mine buttons
/// and the listeners every tab has on them (SPEC_CLIPPER.md, Р11).
export function switchStorage(stored: Record<string, unknown> = {}) {
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];
  return {
    local: { get: async (key: string) => ({ [key]: stored[key] }) },
    onChanged: {
      addListener: (listener: (typeof listeners)[number]) => { listeners.push(listener); },
      removeListener: (listener: (typeof listeners)[number]) => { listeners.splice(listeners.indexOf(listener), 1); },
    },
    /// What another tab's switch does: the value changes and every page hears it.
    set(value: unknown) {
      stored.mineFeedButtons = value;
      for (const listener of [...listeners]) listener({ mineFeedButtons: { newValue: value } }, "local");
    },
  };
}
