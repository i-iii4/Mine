//! Source-first, filesystem-independent resolution of Obsidian and Markdown links.

use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

/// Extensions that end a file name inside a link target.
const FILE_EXTENSIONS: &[&str] = &["md", "pdf", "mp3", "m4a", "wav", "ogg"];

/// Split a link target into the file it names and an Obsidian heading or
/// block fragment: `Note#Heading` is `Note` and `Heading`. Files saved before
/// `#` was kept out of names carry it in the name itself
/// (`Graph #touchdesigner (video 1).mp4`); a target that still ends in a file
/// extension after its last `#` is such a name and has no fragment.
pub fn split_link_fragment(target: &str) -> (&str, Option<&str>) {
    let Some((base, fragment)) = target.split_once('#') else {
        return (target, None);
    };
    if names_a_file(target) {
        (target, None)
    } else {
        (base, Some(fragment))
    }
}

/// The file a link target names, without its fragment.
pub fn link_file_part(target: &str) -> &str {
    split_link_fragment(target).0
}

/// Whether a path ends in the note extension, in any letter case.
fn names_a_note(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn names_a_file(target: &str) -> bool {
    let tail = target.rsplit('#').next().unwrap_or(target);
    std::path::Path::new(tail)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| {
            crate::domain::block::IMAGE_MEDIA_EXTS.contains(&ext.as_str())
                || crate::domain::block::VIDEO_MEDIA_EXTS.contains(&ext.as_str())
                || FILE_EXTENSIONS.contains(&ext.as_str())
        })
}

/// How a link target reaches the resolver, and so which rules read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkSyntax {
    /// A wikilink target, `Note#Heading|alias`: resolved by Obsidian's
    /// shortest-path rules.
    Obsidian,
    /// A Markdown destination as written: backslash escapes, percent
    /// encoding and any `#fragment` or `?query` still in it. Resolved from
    /// the note's folder after one reading
    /// (`markdown_link::local_destination_path`).
    Markdown,
    /// A Markdown path already read from its destination: escapes resolved,
    /// decoded once, without a fragment. Resolved from the note's folder as
    /// it is, never decoded or cut again (`SPEC_AUDIT_FIXES.md`, Г1.2):
    /// `a%20b.jpg` here is a file named with `%20`.
    MarkdownPath,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkResolution {
    Resolved(String),
    Missing,
    Ambiguous(Vec<String>),
}

#[derive(Debug, Clone, Default)]
pub struct LinkIndex {
    paths: HashSet<String>,
    actual_paths: HashMap<String, Vec<String>>,
    by_name: HashMap<String, Vec<String>>,
    by_suffix: HashMap<String, Vec<String>>,
}

impl LinkIndex {
    pub fn new<I, S>(paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut index = Self::default();
        let mut seen_actual = HashSet::new();
        for path in paths {
            let actual = path.as_ref().to_string();
            let Some(path) = normalize_path(&actual) else {
                continue;
            };
            if !seen_actual.insert(actual.clone()) {
                continue;
            }
            index.paths.insert(path.clone());
            index
                .actual_paths
                .entry(path.clone())
                .or_default()
                .push(actual.clone());
            let parts: Vec<&str> = path.split('/').collect();
            index
                .by_name
                .entry(parts[parts.len() - 1].to_string())
                .or_default()
                .push(actual.clone());
            for start in 0..parts.len() {
                index
                    .by_suffix
                    .entry(parts[start..].join("/"))
                    .or_default()
                    .push(actual.clone());
            }
        }
        for values in index
            .by_name
            .values_mut()
            .chain(index.by_suffix.values_mut())
        {
            values.sort();
        }
        for values in index.actual_paths.values_mut() {
            values.sort();
        }
        index
    }

    pub fn resolve(
        &self,
        source_path: &str,
        raw_target: &str,
        syntax: LinkSyntax,
    ) -> LinkResolution {
        self.resolve_inner(source_path, raw_target, syntax, true)
    }

    /// Resolve only current exact or uniquely suffixed paths. A stale folder
    /// address must not be treated as current when consulting rename history.
    pub fn resolve_strict(
        &self,
        source_path: &str,
        raw_target: &str,
        syntax: LinkSyntax,
    ) -> LinkResolution {
        self.resolve_inner(source_path, raw_target, syntax, false)
    }

    fn resolve_inner(
        &self,
        source_path: &str,
        raw_target: &str,
        syntax: LinkSyntax,
        allow_stale: bool,
    ) -> LinkResolution {
        let Some(target) = parse_target(raw_target, syntax) else {
            return LinkResolution::Missing;
        };
        match syntax {
            LinkSyntax::Markdown | LinkSyntax::MarkdownPath => {
                let Some(source) = normalize_path(source_path) else {
                    return LinkResolution::Missing;
                };
                let parent = source.rsplit_once('/').map_or("", |(dir, _)| dir);
                let joined = if target.starts_with('/') {
                    target.trim_start_matches('/').to_string()
                } else if parent.is_empty() {
                    target
                } else {
                    format!("{parent}/{target}")
                };
                let Some(path) = normalize_path(&joined) else {
                    return LinkResolution::Missing;
                };
                let literal = self.exact(&path);
                // `[text](Foo)` names the note `Foo.md`, as Obsidian reads it.
                if matches!(literal, LinkResolution::Missing) && !names_a_note(&path) {
                    return self.exact(&format!("{path}.md"));
                }
                literal
            }
            LinkSyntax::Obsidian => {
                let Some(target) = normalize_path(target.strip_prefix('/').unwrap_or(&target))
                else {
                    return LinkResolution::Missing;
                };
                let literal = self.resolve_obsidian_target(&target, allow_stale);
                if !matches!(literal, LinkResolution::Missing) {
                    return literal;
                }
                if target.ends_with(".md") {
                    return LinkResolution::Missing;
                }
                self.resolve_obsidian_target(&format!("{target}.md"), allow_stale)
            }
        }
    }

    /// Resolve a bare file name without Obsidian's root-path precedence.
    /// This is for callers with no source link, such as a legacy asset URL.
    pub fn resolve_basename(&self, name: &str) -> LinkResolution {
        if name.contains('/') || name.contains('\\') || name.is_empty() {
            return LinkResolution::Missing;
        }
        let key: String = name.nfc().collect();
        result_for(self.by_name.get(&key).map(Vec::as_slice).unwrap_or(&[]))
    }

    fn resolve_obsidian_target(&self, target: &str, allow_stale: bool) -> LinkResolution {
        if let Some(actual) = self.actual_paths.get(target) {
            return result_for(actual);
        }
        let suffix = self.by_suffix.get(target).map(Vec::as_slice).unwrap_or(&[]);
        if !suffix.is_empty() {
            return result_for(suffix);
        }
        if !allow_stale || !target.contains('/') {
            return LinkResolution::Missing;
        }
        // A stale folder address may recover only a unique basename.
        let name = target.rsplit('/').next().unwrap_or(target);
        result_for(self.by_name.get(name).map(Vec::as_slice).unwrap_or(&[]))
    }

    pub fn shortest_link(&self, target_path: &str, omit_md_ext: bool) -> Option<String> {
        let path = normalize_path(target_path)?;
        if !self.paths.contains(&path) {
            return None;
        }
        let parts: Vec<&str> = path.split('/').collect();
        for start in (0..parts.len()).rev() {
            let suffix = parts[start..].join("/");
            let link = if omit_md_ext {
                suffix.strip_suffix(".md").unwrap_or(&suffix).to_string()
            } else {
                suffix
            };
            if matches!(self.resolve("source.md", &link, LinkSyntax::Obsidian), LinkResolution::Resolved(ref resolved) if normalize_path(resolved).as_deref() == Some(path.as_str()))
            {
                return Some(link);
            }
        }
        None
    }

    fn exact(&self, path: &str) -> LinkResolution {
        result_for(
            self.actual_paths
                .get(path)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )
    }
}

/// Notes that move to new paths, and how links to them read afterwards
/// (SPEC_AUDIT_FIXES.md, Ф3).
///
/// A link names a note the way Obsidian resolves it: `[[Foo]]` names
/// `Cards/Foo.md` as much as `[[Cards/Foo]]` does. Comparing link text with
/// the old path misses the short form, which is the form Obsidian writes.
#[derive(Debug, Clone)]
pub struct NoteMoves {
    before: LinkIndex,
    after: LinkIndex,
    /// Normalized old path to the new path.
    moved: HashMap<String, String>,
    /// Names of moved notes in both Unicode forms, to skip texts that cannot
    /// link to them without resolving every link.
    names: Vec<String>,
}

impl NoteMoves {
    /// `paths` lists every vault-relative file before the move. `moves` maps
    /// an old note path to its new one; several old notes may map to one new
    /// note (a merge), and the new note need not exist yet.
    pub fn new<I, S>(paths: I, moves: &[(String, String)]) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let before_paths: Vec<String> = paths.into_iter().map(|p| p.as_ref().to_string()).collect();
        let moved: HashMap<String, String> = moves
            .iter()
            .filter_map(|(old, new)| Some((normalize_path(old)?, new.clone())))
            .collect();
        let after_paths = before_paths
            .iter()
            .filter(|path| {
                normalize_path(path).is_none_or(|normalized| !moved.contains_key(&normalized))
            })
            .cloned()
            .chain(moved.values().cloned());
        let after = LinkIndex::new(after_paths);
        let mut names = Vec::new();
        for old in moved.keys() {
            let file = old.rsplit('/').next().unwrap_or(old);
            let stem = file.strip_suffix(".md").unwrap_or(file);
            let composed: String = stem.nfc().collect();
            let decomposed: String = stem.nfd().collect();
            names.push(composed);
            names.push(decomposed);
        }
        names.sort();
        names.dedup();
        Self {
            before: LinkIndex::new(before_paths),
            after,
            moved,
            names,
        }
    }

    /// The new link text for an Obsidian link target (without its fragment
    /// and alias) that names a moved note, or `None` for any other target.
    /// The new text is the shortest unambiguous one; an explicit `.md` stays.
    pub fn retarget(&self, target: &str) -> Option<String> {
        let LinkResolution::Resolved(old) =
            self.before.resolve("source.md", target, LinkSyntax::Obsidian)
        else {
            return None;
        };
        let new = self.moved.get(&normalize_path(&old)?)?;
        let keeps_extension = link_file_part(target)
            .trim()
            .to_ascii_lowercase()
            .ends_with(".md");
        self.after.shortest_link(new, !keeps_extension)
    }

    /// Whether `text` mentions the name of a moved note and so may link to
    /// it: as written, or behind the percent-encoding and backslash escapes
    /// of a Markdown destination (`[f](Foo%20Bar.md)`).
    pub fn may_be_linked_from(&self, text: &str) -> bool {
        let mentions = |text: &str| self.names.iter().any(|name| text.contains(name.as_str()));
        if mentions(text) {
            return true;
        }
        if !text.contains(['%', '\\']) {
            return false;
        }
        let unescaped = text.replace('\\', "");
        mentions(&percent_encoding::percent_decode_str(&unescaped).decode_utf8_lossy())
    }

    /// The new path of a Markdown destination written in the note that was
    /// at `note_before` and is at `note_after` now, or `None` while the
    /// destination still names what it named (`SPEC_AUDIT_FIXES.md`, Ф3,
    /// В1.3).
    ///
    /// A Markdown destination is a path from the note's folder: it changes
    /// when the note moves to another folder or when the file it names moves.
    /// `destination` is as written, percent-encoded, with any `#fragment`;
    /// the answer is the decoded path from the note's new folder to the
    /// file's new place, rooted at the space (`/…`) when the old one was, and
    /// without `.md` when the old one named a note without it.
    #[must_use]
    pub fn retarget_markdown(
        &self,
        note_before: &str,
        note_after: &str,
        destination: &str,
    ) -> Option<String> {
        let LinkResolution::Resolved(target_before) =
            self.before
                .resolve(note_before, destination, LinkSyntax::Markdown)
        else {
            return None;
        };
        let target_key = normalize_path(&target_before)?;
        let target_moved = self.moved.contains_key(&target_key);
        if !target_moved && normalize_path(note_before) == normalize_path(note_after) {
            return None;
        }
        let target_after = self
            .moved
            .get(&target_key)
            .map_or(target_before.as_str(), String::as_str);
        let file_part = destination.split(['#', '?']).next().unwrap_or(destination).trim();
        let mut path = if file_part.starts_with('/') {
            format!("/{}", target_after.trim_start_matches('/'))
        } else {
            relative_markdown_path(note_after, target_after)
        };
        let names_extension = percent_encoding::percent_decode_str(file_part)
            .decode_utf8_lossy()
            .to_ascii_lowercase()
            .ends_with(".md");
        if !names_extension {
            if let Some(stem) = path.strip_suffix(".md") {
                path = stem.to_string();
            }
        }
        Some(path)
    }
}

/// The Markdown path from the note at `note` to the file at `target`, both
/// relative to the space's root: `../Media/a.jpg` from `Cards/Foo.md` to
/// `Media/a.jpg`. Folders are compared in one Unicode normalization; the
/// target's own spelling is written.
#[must_use]
pub fn relative_markdown_path(note: &str, target: &str) -> String {
    let parts: Vec<String> = note
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(|part| part.nfc().collect())
        .collect();
    let folder = &parts[..parts.len().saturating_sub(1)];
    let target_parts: Vec<&str> = target
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    let common = folder
        .iter()
        .zip(&target_parts)
        .take_while(|(own, other)| own.as_str() == other.nfc().collect::<String>())
        .count();
    std::iter::repeat_n("..", folder.len() - common)
        .chain(target_parts[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

fn result_for(paths: &[String]) -> LinkResolution {
    match paths {
        [] => LinkResolution::Missing,
        [only] => LinkResolution::Resolved(only.clone()),
        many => LinkResolution::Ambiguous(many.to_vec()),
    }
}

fn parse_target(raw: &str, syntax: LinkSyntax) -> Option<String> {
    let target = match syntax {
        LinkSyntax::Obsidian => {
            let target = link_file_part(raw.split('|').next()?).trim();
            if target.contains('?') {
                return None;
            }
            target.to_string()
        }
        // A destination is read exactly once; a path read already is taken
        // as it is (Г1.2).
        LinkSyntax::Markdown => crate::domain::markdown_link::local_destination_path(raw)?,
        LinkSyntax::MarkdownPath => raw.to_string(),
    };
    if target.is_empty()
        || target.contains('\0')
        || target.contains("://")
        || target.starts_with("data:")
        || target.starts_with("mailto:")
        || target.starts_with("//")
        || target.contains('\\')
    {
        return None;
    }
    Some(target.nfc().collect())
}

fn normalize_path(raw: &str) -> Option<String> {
    if raw.starts_with('/') || raw.contains('\0') || raw.contains('\\') {
        return None;
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/").nfc().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_link_to_a_moved_note_is_retargeted() {
        let moves = NoteMoves::new(
            ["Cards/Foo.md", "Cards/Other.md", "Media/Foo.jpg"],
            &[("Cards/Foo.md".to_string(), "Cards/Bar.md".to_string())],
        );
        assert_eq!(moves.retarget("Foo"), Some("Bar".to_string()));
        assert_eq!(moves.retarget("Cards/Foo"), Some("Bar".to_string()));
        assert_eq!(moves.retarget("Foo.md"), Some("Bar.md".to_string()));
        assert_eq!(moves.retarget("Other"), None);
        assert_eq!(moves.retarget("Foo.jpg"), None);
        assert!(moves.may_be_linked_from("see [[Foo]]"));
        assert!(!moves.may_be_linked_from("see [[Other]]"));
    }

    /// В1.3: a Markdown destination is a path from its note's folder. It is
    /// rewritten when the note moves to another folder or the file it names
    /// moves, keeping its root form and its missing `.md`.
    #[test]
    fn a_markdown_destination_follows_its_note_and_its_target() {
        let moves = NoteMoves::new(
            ["Foo.md", "Other.md", "Media/a.jpg", "Deep/Linker.md"],
            &[("Foo.md".to_string(), "Archive/Foo.md".to_string())],
        );
        // The moved note's own links, from its new folder.
        assert_eq!(moves.retarget_markdown("Foo.md", "Archive/Foo.md", "Media/a.jpg").as_deref(), Some("../Media/a.jpg"));
        assert_eq!(moves.retarget_markdown("Foo.md", "Archive/Foo.md", "Other.md#Part").as_deref(), Some("../Other.md"));
        assert_eq!(moves.retarget_markdown("Foo.md", "Archive/Foo.md", "/Media/a.jpg").as_deref(), Some("/Media/a.jpg"));
        assert_eq!(moves.retarget_markdown("Foo.md", "Archive/Foo.md", "Foo.md").as_deref(), Some("Foo.md"));
        // Links to the moved note, from notes that stay.
        assert_eq!(moves.retarget_markdown("Other.md", "Other.md", "Foo.md").as_deref(), Some("Archive/Foo.md"));
        assert_eq!(moves.retarget_markdown("Other.md", "Other.md", "Foo").as_deref(), Some("Archive/Foo"));
        assert_eq!(moves.retarget_markdown("Deep/Linker.md", "Deep/Linker.md", "../Foo.md").as_deref(), Some("../Archive/Foo.md"));
        // Links that still name what they named.
        assert_eq!(moves.retarget_markdown("Other.md", "Other.md", "Media/a.jpg"), None);
        assert_eq!(moves.retarget_markdown("Other.md", "Other.md", "Missing.md"), None);
    }

    #[test]
    fn a_markdown_link_to_a_note_may_omit_its_extension_or_be_encoded() {
        let index = LinkIndex::new(["Cards/Foo Bar.md", "Cards/Foo.v1.md", "Media/Foo.jpg"]);
        assert_eq!(
            index.resolve("Cards/x.md", "Foo%20Bar", LinkSyntax::Markdown),
            LinkResolution::Resolved("Cards/Foo Bar.md".into())
        );
        assert_eq!(
            index.resolve("Cards/x.md", "Foo.v1", LinkSyntax::Markdown),
            LinkResolution::Resolved("Cards/Foo.v1.md".into())
        );
        assert_eq!(
            index.resolve("Cards/x.md", "../Media/Foo\\(1\\).jpg", LinkSyntax::Markdown),
            LinkResolution::Missing
        );
        let moves = NoteMoves::new(["Cards/Foo Bar.md"], &[("Cards/Foo Bar.md".into(), "Cards/Baz.md".into())]);
        assert!(moves.may_be_linked_from("[f](Foo%20Bar.md)"));
        assert!(!moves.may_be_linked_from("[f](Other%20Note.md)"));
        assert_eq!(relative_markdown_path("Cards/Foo.md", "Media/a.jpg"), "../Media/a.jpg");
        assert_eq!(relative_markdown_path("Foo.md", "Media/a.jpg"), "Media/a.jpg");
        assert_eq!(relative_markdown_path("A/B/Foo.md", "A/C/x.md"), "../C/x.md");
    }

    #[test]
    fn a_new_name_shared_with_another_note_keeps_its_folder() {
        let moves = NoteMoves::new(
            ["Cards/Foo.md", "Archive/Bar.md"],
            &[("Cards/Foo.md".to_string(), "Cards/Bar.md".to_string())],
        );
        assert_eq!(moves.retarget("Foo"), Some("Cards/Bar".to_string()));
    }

    #[test]
    fn an_ambiguous_link_is_left_alone() {
        let moves = NoteMoves::new(
            ["Cards/Foo.md", "Archive/Foo.md"],
            &[("Cards/Foo.md".to_string(), "Cards/Bar.md".to_string())],
        );
        assert_eq!(moves.retarget("Foo"), None);
        assert_eq!(moves.retarget("Cards/Foo"), Some("Bar".to_string()));
    }

    #[test]
    fn merged_notes_all_point_to_the_merged_note() {
        let moves = NoteMoves::new(
            ["Cards/A.md", "Cards/B.md", "Cards/C.md"],
            &[
                ("Cards/A.md".to_string(), "Cards/A — merged.md".to_string()),
                ("Cards/B.md".to_string(), "Cards/A — merged.md".to_string()),
            ],
        );
        assert_eq!(moves.retarget("A"), Some("A — merged".to_string()));
        assert_eq!(moves.retarget("B"), Some("A — merged".to_string()));
        assert_eq!(moves.retarget("C"), None);
    }

    #[test]
    fn a_hash_inside_a_file_name_is_part_of_the_name() {
        let index = LinkIndex::new([
            "Media/Force-directed #touchdesigner graph (video 1).mp4",
            "Cards/Заметка.md",
        ]);
        assert_eq!(
            index.resolve(
                "Cards/Force-directed #touchdesigner graph.md",
                "Force-directed #touchdesigner graph (video 1).mp4",
                LinkSyntax::Obsidian
            ),
            LinkResolution::Resolved("Media/Force-directed #touchdesigner graph (video 1).mp4".into())
        );
        // A heading after a note name stays a fragment.
        assert_eq!(split_link_fragment("Заметка#Раздел 1.2"), ("Заметка", Some("Раздел 1.2")));
        assert_eq!(split_link_fragment("Заметка#Раздел"), ("Заметка", Some("Раздел")));
        assert_eq!(split_link_fragment("clip #tag.mp4"), ("clip #tag.mp4", None));
        assert_eq!(link_file_part("photo.jpg"), "photo.jpg");
    }

    #[test]
    fn unique_name_survives_move_and_shortest_path_disambiguates() {
        let index = LinkIndex::new(["A/photo.jpg", "B/photo.jpg", "Moved/Заметка.md"]);
        assert_eq!(
            index.resolve("Cards/card.md", "Заметка", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Moved/Заметка.md".into())
        );
        assert_eq!(
            index.resolve(
                "Cards/card.md",
                "Old/Заметка#Раздел|Текст",
                LinkSyntax::Obsidian
            ),
            LinkResolution::Resolved("Moved/Заметка.md".into())
        );
        assert_eq!(
            index.resolve("Cards/card.md", "photo.jpg", LinkSyntax::Obsidian),
            LinkResolution::Ambiguous(vec!["A/photo.jpg".into(), "B/photo.jpg".into()])
        );
        assert_eq!(
            index.shortest_link("A/photo.jpg", false).as_deref(),
            Some("A/photo.jpg")
        );
        assert_eq!(
            index.shortest_link("Moved/Заметка.md", true).as_deref(),
            Some("Заметка")
        );
    }

    #[test]
    fn markdown_is_relative_and_decodes_percent_encoding() {
        let index = LinkIndex::new([
            "Notes/photo.jpg",
            "Media/photo.jpg",
            "Media/hello world.jpg",
        ]);
        assert_eq!(
            index.resolve("Notes/card.md", "photo.jpg", LinkSyntax::Markdown),
            LinkResolution::Resolved("Notes/photo.jpg".into())
        );
        assert_eq!(
            index.resolve(
                "Notes/card.md",
                "../Media/hello%20world.jpg",
                LinkSyntax::Markdown
            ),
            LinkResolution::Resolved("Media/hello world.jpg".into())
        );
        assert_eq!(
            index.resolve("Notes/card.md", "../Media/no.jpg", LinkSyntax::Markdown),
            LinkResolution::Missing
        );
    }

    /// Г1.2: a destination is decoded once, whether the resolver reads it as
    /// written or receives the path read from it: `%23` stays in the name and
    /// `%2520` names `a%20b.jpg`, never the decoy `a b.jpg`.
    #[test]
    fn a_destination_and_its_read_path_resolve_alike_and_once() {
        let index = LinkIndex::new(["Media/photo#tag.jpg", "Media/a%20b.jpg", "Media/a b.jpg", "Media/q.jpg"]);
        let cases = [
            ("../Media/photo%23tag.jpg", "../Media/photo#tag.jpg", "Media/photo#tag.jpg"),
            ("../Media/a%2520b.jpg", "../Media/a%20b.jpg", "Media/a%20b.jpg"),
            ("../Media/a%20b.jpg", "../Media/a b.jpg", "Media/a b.jpg"),
            ("../Media/q.jpg#crop", "../Media/q.jpg", "Media/q.jpg"),
            ("../Media/q.jpg?v=2", "../Media/q.jpg", "Media/q.jpg"),
        ];
        for (written, path, file) in cases {
            assert_eq!(
                crate::domain::markdown_link::local_destination_path(written).as_deref(),
                Some(path)
            );
            let expected = LinkResolution::Resolved(file.into());
            assert_eq!(index.resolve("Cards/x.md", written, LinkSyntax::Markdown), expected, "{written}");
            assert_eq!(index.resolve("Cards/x.md", path, LinkSyntax::MarkdownPath), expected, "{path}");
        }
    }

    #[test]
    fn explicit_path_wins_and_suffix_ambiguity_is_reported() {
        let index = LinkIndex::new(["A/Media/p.jpg", "B/Media/p.jpg", "Media/p.jpg"]);
        assert_eq!(
            index.resolve("x.md", "Media/p.jpg", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Media/p.jpg".into())
        );
        let index = LinkIndex::new(["A/Media/p.jpg", "B/Media/p.jpg"]);
        assert!(matches!(
            index.resolve("x.md", "Media/p.jpg", LinkSyntax::Obsidian),
            LinkResolution::Ambiguous(_)
        ));
    }

    #[test]
    fn bare_name_prefers_exact_root_copy() {
        let index = LinkIndex::new(["photo.jpg", "Media/photo.jpg"]);
        assert_eq!(
            index.resolve("card.md", "photo.jpg", LinkSyntax::Obsidian),
            LinkResolution::Resolved("photo.jpg".into())
        );
        assert_eq!(
            index.shortest_link("photo.jpg", false).as_deref(),
            Some("photo.jpg")
        );
        assert!(matches!(
            index.resolve_basename("photo.jpg"),
            LinkResolution::Ambiguous(_)
        ));
        assert_eq!(
            index.resolve("Nested/Other.md", "/photo.jpg", LinkSyntax::Obsidian),
            LinkResolution::Resolved("photo.jpg".into())
        );
    }

    #[test]
    fn root_note_and_nested_duplicate_have_distinct_links() {
        let index = LinkIndex::new(["Design.md", "Nested/Design.md"]);
        assert_eq!(
            index.shortest_link("Design.md", true).as_deref(),
            Some("Design")
        );
        assert_eq!(
            index.shortest_link("Nested/Design.md", true).as_deref(),
            Some("Nested/Design")
        );
        assert_eq!(
            index.resolve("Nested/Other.md", "Design", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Design.md".into())
        );
        assert_eq!(
            index.resolve("Other.md", "/Design", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Design.md".into())
        );
    }

    #[test]
    fn strict_resolution_excludes_stale_basename_fallback() {
        let index = LinkIndex::new(["Design.md", "Nested/Design.md", "Moved/Note.v1.md"]);
        assert_eq!(
            index.resolve_strict("Cards/Source.md", "Design", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Design.md".into())
        );
        assert_eq!(
            index.resolve_strict("Cards/Source.md", "Note.v1", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Moved/Note.v1.md".into())
        );
        assert_eq!(
            index.resolve_strict("Cards/Source.md", "Old/Note.v1", LinkSyntax::Obsidian),
            LinkResolution::Missing
        );
        assert_eq!(
            index.resolve("Cards/Source.md", "Old/Note.v1", LinkSyntax::Obsidian),
            LinkResolution::Resolved("Moved/Note.v1.md".into())
        );
    }

    #[test]
    fn unicode_normalization_keeps_physical_path() {
        let actual = "Media/cafe\u{301}.jpg";
        let index = LinkIndex::new([actual]);
        assert_eq!(
            index.resolve("card.md", "café.jpg", LinkSyntax::Obsidian),
            LinkResolution::Resolved(actual.into())
        );
    }

    #[test]
    fn canonically_equal_physical_names_remain_ambiguous() {
        let index = LinkIndex::new(["Media/café.jpg", "Media/cafe\u{301}.jpg"]);
        assert!(matches!(
            index.resolve("card.md", "Media/café.jpg", LinkSyntax::Obsidian),
            LinkResolution::Ambiguous(_)
        ));
        assert_eq!(index.shortest_link("Media/café.jpg", false), None);
    }
}
