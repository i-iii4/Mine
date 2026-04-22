// Markdown body transformations — pure functions with no IO.
//
// Phase 18.H.3 migration: convert legacy percent-encoded markdown image
// embeds (`![alt](Title%20%28image%201%29.jpg)`) into Obsidian wikilinks
// (`![[Title (image 1).jpg|alt]]`). Remote URLs (http/https) are left
// untouched — they are genuine URL references, not local filesystem
// lookups.
//
// The transformation is stable: applying it twice yields the same
// result as applying it once. This lets a user re-run the migration
// safely without corrupting already-converted bodies.

/// Rewrite markdown image embeds into Obsidian wikilinks for every
/// locally-addressed URL in `body`. Returns the new body.
///
/// Rules:
/// - `![alt](<local-url>)` -> `![[<decoded-name>|alt]]` (alt preserved)
/// - `![](<local-url>)`    -> `![[<decoded-name>]]`     (no alt)
/// - `![alt](<remote-url>)` kept as-is
/// - `![[...]]` already a wikilink: kept as-is
///
/// Decoding is percent-decode on local URLs only — the filename on
/// disk is the decoded form. A `|` in alt text is escaped to `&#124;`
/// so it does not split the wikilink. A `]]` inside a filename (rare)
/// falls back to keeping the original markdown form.
pub fn convert_markdown_images_to_wikilinks(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut i = 0usize;
    while i < body.len() {
        let Some(rel) = body[i..].find("![") else {
            out.push_str(&body[i..]);
            break;
        };
        let excl = i + rel;
        out.push_str(&body[i..excl]);
        let after_excl = excl + 2;
        if after_excl >= body.len() {
            out.push_str(&body[excl..]);
            break;
        }

        if body[after_excl..].starts_with('[') {
            // Already a wikilink — copy through unchanged.
            let name_start = after_excl + 1;
            let Some(close_offset) = body[name_start..].find("]]") else {
                // Malformed — leave as-is.
                out.push_str(&body[excl..]);
                break;
            };
            let end = name_start + close_offset + 2;
            out.push_str(&body[excl..end]);
            i = end;
            continue;
        }

        // Standard `![alt](url)` — try to rewrite.
        let Some(bracket_offset) = body[after_excl..].find("](") else {
            // Broken inline image start — flush `![` and move on.
            out.push_str(&body[excl..after_excl]);
            i = after_excl;
            continue;
        };
        let alt_start = after_excl;
        let bracket_pos = alt_start + bracket_offset;
        let url_start = bracket_pos + 2;
        let Some(paren_end) = body[url_start..].find(')') else {
            out.push_str(&body[excl..after_excl]);
            i = after_excl;
            continue;
        };
        let alt = &body[alt_start..bracket_pos];
        let url = &body[url_start..url_start + paren_end];
        let end = url_start + paren_end + 1;

        if url.starts_with("http://") || url.starts_with("https://") || url.is_empty() {
            out.push_str(&body[excl..end]);
            i = end;
            continue;
        }

        // Local URL: decode and emit as wikilink.
        let decoded: String = percent_encoding::percent_decode_str(url)
            .decode_utf8_lossy()
            .into_owned();
        if decoded.contains("]]") {
            // Pathological filename — leave the original markdown form.
            out.push_str(&body[excl..end]);
            i = end;
            continue;
        }

        let alt_trimmed = alt.trim();
        if alt_trimmed.is_empty() {
            out.push_str("![[");
            out.push_str(&decoded);
            out.push_str("]]");
        } else {
            let safe_alt = alt_trimmed
                .replace('|', "&#124;")
                .replace('\n', " ");
            out.push_str("![[");
            out.push_str(&decoded);
            out.push('|');
            out.push_str(&safe_alt);
            out.push_str("]]");
        }
        i = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_local_markdown_without_alt() {
        assert_eq!(
            convert_markdown_images_to_wikilinks("![](photo.jpg)"),
            "![[photo.jpg]]"
        );
    }

    #[test]
    fn converts_encoded_local_markdown_decoding_parens() {
        assert_eq!(
            convert_markdown_images_to_wikilinks("![](Title%20%28image%201%29.jpg)"),
            "![[Title (image 1).jpg]]"
        );
    }

    #[test]
    fn converts_with_alt_using_pipe_separator() {
        assert_eq!(
            convert_markdown_images_to_wikilinks("![sunset](photo.jpg)"),
            "![[photo.jpg|sunset]]"
        );
    }

    #[test]
    fn converts_encoded_local_with_alt() {
        assert_eq!(
            convert_markdown_images_to_wikilinks(
                "![view](Title%20%28image%201%29.jpg)"
            ),
            "![[Title (image 1).jpg|view]]"
        );
    }

    #[test]
    fn preserves_remote_http_urls() {
        let input = "![](https://cdn.example.com/path%20with%20space.jpg)";
        assert_eq!(convert_markdown_images_to_wikilinks(input), input);
    }

    #[test]
    fn preserves_existing_wikilinks() {
        let input = "![[already.jpg]]\n\n![[other.png|alt text]]";
        assert_eq!(convert_markdown_images_to_wikilinks(input), input);
    }

    #[test]
    fn handles_mixed_document() {
        // Mix of: percent-encoded legacy markdown (what 18.F.1 writes),
        // remote URL, already-wikilink, and simple ASCII markdown.
        let input = "Intro paragraph.\n\n\
                     ![first](a%20%281%29.jpg)\n\n\
                     ![](https://remote.example/pic.png)\n\n\
                     ![[already.mp4]]\n\n\
                     ![cap](b.png)";
        let expected = "Intro paragraph.\n\n\
                        ![[a (1).jpg|first]]\n\n\
                        ![](https://remote.example/pic.png)\n\n\
                        ![[already.mp4]]\n\n\
                        ![[b.png|cap]]";
        assert_eq!(convert_markdown_images_to_wikilinks(input), expected);
    }

    #[test]
    fn idempotent_second_run_is_noop() {
        let input = "![alt](Title%20%28image%201%29.jpg)\n\n![](plain.png)";
        let once = convert_markdown_images_to_wikilinks(input);
        let twice = convert_markdown_images_to_wikilinks(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn escapes_pipe_in_alt_text() {
        assert_eq!(
            convert_markdown_images_to_wikilinks("![a | b](x.jpg)"),
            "![[x.jpg|a &#124; b]]"
        );
    }

    #[test]
    fn leaves_malformed_markdown_untouched() {
        // Missing closing paren — cannot parse, leave the raw text.
        let input = "![broken](no-close";
        assert_eq!(convert_markdown_images_to_wikilinks(input), input);
    }

    #[test]
    fn preserves_unicode_names() {
        assert_eq!(
            convert_markdown_images_to_wikilinks("![](Закат%20%28image%201%29.jpg)"),
            "![[Закат (image 1).jpg]]"
        );
    }

    #[test]
    fn falls_back_to_markdown_when_decoded_name_contains_close_delim() {
        // Filename literally containing `]]` would corrupt the wikilink;
        // leave the original markdown form.
        let input = "![alt](weird%5D%5Dname.jpg)";
        // percent-decoded → `weird]]name.jpg`
        assert_eq!(convert_markdown_images_to_wikilinks(input), input);
    }

    #[test]
    fn skips_empty_url() {
        let input = "![empty]()";
        assert_eq!(convert_markdown_images_to_wikilinks(input), input);
    }

    #[test]
    fn trims_surrounding_whitespace_in_alt() {
        assert_eq!(
            convert_markdown_images_to_wikilinks("![  padded  ](x.png)"),
            "![[x.png|padded]]"
        );
    }

    #[test]
    fn no_op_on_body_without_images() {
        let input = "Just a paragraph with **bold** and [a link](https://e.com).";
        assert_eq!(convert_markdown_images_to_wikilinks(input), input);
    }
}
