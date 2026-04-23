// Pre-process Obsidian wikilink syntax into standard markdown before
// handing a body to `react-markdown`. Mine writes inline article media
// as `![[name]]` / `![[name|alt]]` (Phase 18.H.1) because wikilinks
// preserve the filename ↔ URL identity that the percent-encoded
// `![alt](url)` form breaks.
//
// react-markdown + remark-gfm do not understand wikilinks on their own.
// This helper rewrites wikilinks into `![alt](encoded-url)` form just
// before rendering, so the already-installed markdown pipeline does the
// rest. Encoding is isolated to the render boundary; the `.md` file on
// disk stays human-readable in Obsidian and Finder.

const WIKILINK_EMBED = /!\[\[([^\]]*)\]\]/g;
const WIKILINK_LINK = /(?<!!)\[\[([^\]]*)\]\]/g;

function isRemoteMarkdownUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://");
}

function encodeMarkdownUrl(name: string): string {
  // Mirror the backend encoder (Phase 18.F.1): space, parens, percent.
  // encodeURI would also percent-encode Cyrillic, which we avoid to
  // keep the rendered URL human-readable for debug/dev-tools.
  return name
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/**
 * Rewrite Obsidian wikilinks in a markdown body into standard
 * `![alt](url)` / `[alt](url)` form so `react-markdown` can parse them.
 *
 * Wikilink embed:
 *   `![[name]]`        -> `![](name)` (alt empty)
 *   `![[name|alt]]`    -> `![alt](name)`
 *
 * Wikilink link (no leading !):
 *   `[[name]]`         -> `[name](name)`
 *   `[[name|alt]]`     -> `[alt](name)`
 *
 * URLs are percent-encoded (space, parens, %) so the downstream
 * markdown parser does not truncate on filenames containing those
 * characters.
 */
export function preprocessWikilinks(body: string): string {
  return body
    .replace(WIKILINK_EMBED, (_match, inner) => {
      const [rawName, altPart] = String(inner).split("|", 2);
      const name = (rawName ?? "").trim();
      const alt = (altPart ?? "").trim();
      if (!name) return "";
      return `![${alt}](${encodeMarkdownUrl(name)})`;
    })
    .replace(WIKILINK_LINK, (_match, inner) => {
      const [rawName, altPart] = String(inner).split("|", 2);
      const name = (rawName ?? "").trim();
      const alt = (altPart ?? "").trim();
      if (!name) return "";
      const display = alt || name;
      return `[${display}](${encodeMarkdownUrl(name)})`;
    });
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
