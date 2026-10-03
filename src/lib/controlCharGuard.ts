// Ignore control characters typed into fields of tab pages and tab bars
// (SPEC_TABS.md, В80). In a child webview on macOS the arrow keys can insert
// U+001C to U+001F into the field they move in (tauri #10194), and those
// would end up in collection names and text. One listener covers the page.

/** U+001C: the first of the characters arrow keys insert by mistake. */
const FIRST_STRAY_CONTROL = 0x1c;
/** U+001F: the last of them. */
const LAST_STRAY_CONTROL = 0x1f;

function hasStrayControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= FIRST_STRAY_CONTROL && code <= LAST_STRAY_CONTROL) return true;
  }
  return false;
}

/** Whether a typed insertion carries a stray control character. */
export function isStrayControlInsertion(inputType: string, data: string | null): boolean {
  return inputType.startsWith("insert") && data !== null && hasStrayControl(data);
}

/** Install the guard on `target` (the page's document); returns its removal. */
export function installControlCharGuard(target: Document = document): () => void {
  const onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    if (isStrayControlInsertion(input.inputType, input.data)) {
      event.preventDefault();
    }
  };
  target.addEventListener("beforeinput", onBeforeInput, true);
  return () => target.removeEventListener("beforeinput", onBeforeInput, true);
}
