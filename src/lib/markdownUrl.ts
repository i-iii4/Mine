// URL sanitizer for rendered markdown. Lives in its own tauri-free module so
// both the desktop app (Detail) and the browser-extension popup can import it;
// `assets.ts` pulls in @tauri-apps/api and cannot be loaded inside the
// extension bundle.

/**
 * Schemes allowed in rendered article markdown. Beyond http/https/mailto this
 * permits the WebView-local schemes that body media legitimately uses
 * (`asset:` from convertFileSrc, `tauri:`). `javascript:`, `data:`, `file:`
 * and any other scheme are rejected.
 */
const SAFE_MARKDOWN_SCHEMES = new Set([
  "http",
  "https",
  "mailto",
  "asset",
  "tauri",
]);

/**
 * Sanitizer for react-markdown's `urlTransform`. Returns the URL unchanged when
 * it is relative/anchor (no scheme) or uses an allowed scheme; otherwise
 * collapses to an empty string so it cannot become an href/src. Making this
 * explicit removes the reliance on react-markdown's default transform, so a
 * future refactor cannot silently open a `javascript:`/`data:` XSS hole.
 */
export function safeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "";
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) return trimmed; // relative path or in-page anchor
  const scheme = schemeMatch[1]?.toLowerCase() ?? "";
  return SAFE_MARKDOWN_SCHEMES.has(scheme) ? trimmed : "";
}

function isRemoteMarkdownUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://");
}

/**
 * Decode a local markdown URL back to the real filename on disk.
 *
 * Render-time markdown uses percent-encoding for a small set of characters
 * (space, parens, bare `%`) so the parser does not truncate. The source
 * vault and preview manifests keep the actual filenames, so any local path
 * crossing the render boundary must be decoded before it is used as a file
 * or preview-manifest lookup key.
 */
export function decodeLocalMarkdownUrl(src: string): string {
  if (!src || isRemoteMarkdownUrl(src)) {
    return src;
  }
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}
