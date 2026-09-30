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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkSyntax {
    Obsidian,
    Markdown,
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
            LinkSyntax::Markdown => {
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
                self.exact(&path)
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
    /// it.
    pub fn may_be_linked_from(&self, text: &str) -> bool {
        self.names.iter().any(|name| text.contains(name.as_str()))
    }
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
        LinkSyntax::Obsidian => link_file_part(raw.split('|').next()?).trim().to_string(),
        LinkSyntax::Markdown => percent_encoding::percent_decode_str(raw.trim().split('#').next()?)
            .decode_utf8()
            .ok()?
            .into_owned(),
    };
    if target.is_empty()
        || target.contains('\0')
        || target.contains('?')
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
