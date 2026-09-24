//! Source-first, filesystem-independent resolution of Obsidian and Markdown links.

use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

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

fn result_for(paths: &[String]) -> LinkResolution {
    match paths {
        [] => LinkResolution::Missing,
        [only] => LinkResolution::Resolved(only.clone()),
        many => LinkResolution::Ambiguous(many.to_vec()),
    }
}

fn parse_target(raw: &str, syntax: LinkSyntax) -> Option<String> {
    let target = match syntax {
        LinkSyntax::Obsidian => raw.split(['|', '#']).next()?.trim().to_string(),
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
