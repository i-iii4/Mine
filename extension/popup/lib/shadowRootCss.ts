// Tailwind v4, shadcn and Mine's own tokens declare their custom properties
// on `:root`. Inside the overlay's Shadow DOM `:root` matches nothing, so a
// bare `:root` that is a whole selector, alone (`:root {`) or one entry of a
// selector list (`:root, [data-theme] {`, `:root,.bg-background{`), also
// selects the shadow host. A `:root` that only qualifies a longer selector
// (`:root[data-theme="dark"]`, `:root:not(...) .x`) stays as it is, and a list
// that already names `:host` (Tailwind's `@theme` output) is left alone.
const BARE_ROOT = /:root(?=\s*[{,])(?!\s*,\s*:host\b)/g;
// The button rules are anchored on the document root as `html:root`
// (src/styles/buttons.css), some qualified by the root's attributes
// (`html:root:not([data-buttons])`, `html:root[data-theme="dark"]`). Inside
// the overlay that anchor is the host, with the same qualifiers.
const HTML_ROOT = /html:root((?:\[[^\]]*\]|:not\((?:[^()]|\([^()]*\))*\))*)/g;

/// `css` with every bare `:root` selector also matching `:host`, and every
/// `html:root` anchor turned into the host.
export function rewriteRootForShadow(css: string): string {
  return css
    .replace(HTML_ROOT, (_anchor: string, qualifiers: string) => (qualifiers ? `:host(${qualifiers})` : ":host"))
    .replace(BARE_ROOT, ":root,:host");
}
