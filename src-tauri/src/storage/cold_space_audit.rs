//! Disposable cold-space acceptance against a source vault and isolated derived stores.
//!
//! Contract: SPEC_STORAGE.md#storagecold_space_audit--disposable-acceptance-contract

use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use crate::domain::vault::{detect_icloud_conflict, VaultLayout};
use crate::storage::derived_preview::PreviewReconcileReport;
use crate::storage::reconcile::ReconcileReport;
use crate::storage::{db, derived_preview, files, index, projection, reconcile};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UnsupportedSource {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectionRow {
    pub slug: String,
    pub block_type: String,
    pub card_kind: String,
    pub preview_state: String,
    pub preview_error_kind: Option<String>,
    pub preview_manifest: Option<String>,
    pub fallback_label: String,
    pub url: Option<String>,
    pub media_file: Option<String>,
    pub body_nonempty: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ColdSpaceSnapshot {
    pub source_markdown: usize,
    pub content_sources: usize,
    pub collection_sources: usize,
    pub unsupported_sources: Vec<UnsupportedSource>,
    pub content_rows: usize,
    pub collection_rows: usize,
    pub grid_order: Vec<String>,
    pub visible_preview_manifests: usize,
    pub preview_states: BTreeMap<String, usize>,
    pub metadata_only_links: Vec<String>,
    pub rows: Vec<ProjectionRow>,
    pub grid_snapshot: projection::GridSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColdSpaceCycleReport {
    pub cycle: usize,
    pub derived_root: String,
    pub reconcile: ReconcileReport,
    pub first: ColdSpaceSnapshot,
    pub previews: PreviewReconcileReport,
    pub preview_elapsed_ms: u64,
    pub settled: ColdSpaceSnapshot,
    pub reopened: ColdSpaceSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColdSpaceAuditReport {
    pub source_root: String,
    pub derived_base: String,
    pub cycles: Vec<ColdSpaceCycleReport>,
    pub stable_after_reopen: bool,
    pub stable_after_cache_reset: bool,
    pub source_unchanged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColdSpaceAuditSummary {
    pub source_root: String,
    pub cycles: usize,
    pub source_markdown: usize,
    pub content_sources: usize,
    pub collection_sources: usize,
    pub unsupported_sources: usize,
    pub metadata_only_links: usize,
    pub first_preview_states: BTreeMap<String, usize>,
    pub settled_preview_states: BTreeMap<String, usize>,
    pub settled_preview_errors: BTreeMap<String, usize>,
    pub preview_elapsed_ms: Vec<u64>,
    pub stable_after_reopen: bool,
    pub stable_after_cache_reset: bool,
    pub source_unchanged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColdSpaceBrowserPayload {
    pub source_root: String,
    pub thumbs_root_path: String,
    pub first: projection::GridSnapshot,
    pub settled: projection::GridSnapshot,
}

impl ColdSpaceAuditReport {
    #[must_use]
    pub fn summary(&self) -> ColdSpaceAuditSummary {
        let first_cycle = self
            .cycles
            .first()
            .expect("cold-space audit always has at least one cycle");
        let mut settled_preview_errors = BTreeMap::new();
        for row in &first_cycle.settled.rows {
            if let Some(kind) = &row.preview_error_kind {
                *settled_preview_errors.entry(kind.clone()).or_insert(0) += 1;
            }
        }
        ColdSpaceAuditSummary {
            source_root: self.source_root.clone(),
            cycles: self.cycles.len(),
            source_markdown: first_cycle.first.source_markdown,
            content_sources: first_cycle.first.content_sources,
            collection_sources: first_cycle.first.collection_sources,
            unsupported_sources: first_cycle.first.unsupported_sources.len(),
            metadata_only_links: first_cycle.first.metadata_only_links.len(),
            first_preview_states: first_cycle.first.preview_states.clone(),
            settled_preview_states: first_cycle.settled.preview_states.clone(),
            settled_preview_errors,
            preview_elapsed_ms: self
                .cycles
                .iter()
                .map(|cycle| cycle.preview_elapsed_ms)
                .collect(),
            stable_after_reopen: self.stable_after_reopen,
            stable_after_cache_reset: self.stable_after_cache_reset,
            source_unchanged: self.source_unchanged,
        }
    }

    #[must_use]
    pub fn browser_payload(&self) -> ColdSpaceBrowserPayload {
        let first_cycle = self
            .cycles
            .first()
            .expect("cold-space audit always has at least one cycle");
        ColdSpaceBrowserPayload {
            source_root: self.source_root.clone(),
            thumbs_root_path: Path::new(&first_cycle.derived_root)
                .join("cache")
                .join("thumbs")
                .to_string_lossy()
                .into_owned(),
            first: first_cycle.first.grid_snapshot.clone(),
            settled: first_cycle.settled.grid_snapshot.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceFileFingerprint {
    relative_path: String,
    size: u64,
    modified_ns: u128,
}

/// Run two or more fully cold source-to-projection cycles.
///
/// The caller owns `derived_base`. It must already exist and be empty. Audit
/// artifacts are intentionally retained under `cycle-N` for inspection.
pub fn run_cold_space_audit(
    source_root: &Path,
    derived_base: &Path,
    cycles: usize,
) -> Result<ColdSpaceAuditReport> {
    if cycles < 2 {
        bail!("cold-space acceptance requires at least two independent cycles");
    }
    let (source_root, derived_base) = validate_roots(source_root, derived_base)?;
    let source_before = source_fingerprint(&source_root)?;
    let mut cycle_reports = Vec::with_capacity(cycles);

    for cycle in 1..=cycles {
        let cycle_root = derived_base.join(format!("cycle-{cycle}"));
        if cycle_root.exists() {
            bail!(
                "cold-space cycle derived root already exists: {}",
                cycle_root.display()
            );
        }
        let vault = VaultLayout::with_derived_root(source_root.clone(), cycle_root.clone());
        let conn = db::open_or_create(&vault.index_db_path())?;
        let reconcile_report = reconcile::reconcile_vault(&conn, &vault)
            .map_err(anyhow::Error::new)
            .context("cold-space source reconciliation failed")?;
        let first = capture_snapshot(&conn, &vault, &reconcile_report)?;
        let preview_started = Instant::now();
        let preview_report = derived_preview::reconcile_all_previews(&conn, &vault)
            .context("cold-space preview reconciliation failed")?;
        let preview_elapsed_ms = preview_started
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        let settled = capture_snapshot(&conn, &vault, &reconcile_report)?;
        drop(conn);

        let reopened_conn = db::open_read_only(&vault.index_db_path())?;
        let reopened = capture_snapshot(&reopened_conn, &vault, &reconcile_report)?;
        if settled != reopened {
            bail!("cycle {cycle} changed after reopening its derived index");
        }
        if source_fingerprint(&source_root)? != source_before {
            bail!("source vault changed during cold-space cycle {cycle}");
        }

        cycle_reports.push(ColdSpaceCycleReport {
            cycle,
            derived_root: cycle_root.to_string_lossy().into_owned(),
            reconcile: reconcile_report,
            first,
            previews: preview_report,
            preview_elapsed_ms,
            settled,
            reopened,
        });
    }

    let baseline = cycle_reports.first().expect("cycles is checked above");
    let stable_after_cache_reset = cycle_reports
        .iter()
        .skip(1)
        .all(|cycle| cycle.first == baseline.first && cycle.settled == baseline.settled);
    if !stable_after_cache_reset {
        bail!("independent cold-derived cycles produced different projections");
    }

    Ok(ColdSpaceAuditReport {
        source_root: source_root.to_string_lossy().into_owned(),
        derived_base: derived_base.to_string_lossy().into_owned(),
        cycles: cycle_reports,
        stable_after_reopen: true,
        stable_after_cache_reset,
        source_unchanged: true,
    })
}

/// Create a deterministic private-data-free source vault for the browser gate.
/// The destination must already exist and be empty; production audit code then
/// treats it exactly like any other source vault.
pub fn write_sanitized_fixture(source_root: &Path, block_count: usize) -> Result<()> {
    if block_count < 12 {
        bail!("cold-space browser fixture requires at least 12 blocks");
    }
    if !source_root.is_dir() {
        bail!(
            "cold-space fixture root must be an existing directory: {}",
            source_root.display()
        );
    }
    if fs::read_dir(source_root)?.next().is_some() {
        bail!(
            "cold-space fixture root must be empty: {}",
            source_root.display()
        );
    }

    write_fixture_file(
        &source_root.join("Cold Collection.md"),
        "---\ntype: channel\nposition: 1\nsaved_at: 2026-07-11T00:00:00Z\n---\n",
    )?;
    image::RgbImage::from_pixel(48, 32, image::Rgb([40, 80, 120]))
        .save(source_root.join("cold-shared-image.png"))
        .context("write sanitized cold-space image")?;
    fs::write(
        source_root.join("cold-browser-preview.webp"),
        b"browser-owned-decode",
    )?;

    for index in 0..block_count {
        let suffix = format!("{index:03}");
        let (relative, body) = match index % 6 {
            0 => (
                format!("00-cold-link-{suffix}.md"),
                format!(
                    "---\ntype: {}\ntitle: Cold metadata link {}\nurl: https://example.test/cold/{index}\nsaved_at: 2026-07-11T00:00:00Z\n---\n",
                    if index % 12 == 0 { "video" } else { "link" },
                    index + 1
                ),
            ),
            1 => (
                format!("cold-article-{suffix}.md"),
                format!(
                    "---\ntype: article\ntitle: Cold article {}\nsaved_at: 2026-07-11T00:00:00Z\n---\nA cold article paints a deterministic text fallback before preview completion.",
                    index + 1
                ),
            ),
            2 => (
                format!("cold-image-{suffix}.md"),
                format!(
                    "---\ntype: image\nfile: cold-shared-image.png\ntitle: Cold image {}\nsaved_at: 2026-07-11T00:00:00Z\n---\n",
                    index + 1
                ),
            ),
            3 => (
                format!("cold-missing-{suffix}.md"),
                format!(
                    "---\ntype: image\nfile: cold-missing-{suffix}.png\ntitle: Missing media {}\nsaved_at: 2026-07-11T00:00:00Z\n---\n",
                    index + 1
                ),
            ),
            4 => (
                format!("cold-browser-{suffix}.md"),
                format!(
                    "---\ntype: image\nfile: cold-browser-preview.webp\ntitle: Browser decode pending {}\nsaved_at: 2026-07-11T00:00:00Z\n---\n",
                    index + 1
                ),
            ),
            _ => (
                format!("Library/cold-note-{suffix}.md"),
                format!(
                    "# Nested note {}\n\nA normal Obsidian note remains readable while the derived store is cold.",
                    index + 1
                ),
            ),
        };
        write_fixture_file(&source_root.join(relative), &body)?;
    }
    Ok(())
}

fn write_fixture_file(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content).with_context(|| format!("write fixture file {}", path.display()))
}

fn validate_roots(source_root: &Path, derived_base: &Path) -> Result<(PathBuf, PathBuf)> {
    let source_root = source_root
        .canonicalize()
        .with_context(|| format!("source vault does not exist: {}", source_root.display()))?;
    if !source_root.is_dir() {
        bail!("source vault is not a directory: {}", source_root.display());
    }
    let derived_base = derived_base.canonicalize().with_context(|| {
        format!(
            "derived base must already exist as an empty directory: {}",
            derived_base.display()
        )
    })?;
    if !derived_base.is_dir() {
        bail!(
            "derived base is not a directory: {}",
            derived_base.display()
        );
    }
    if derived_base.starts_with(&source_root) || source_root.starts_with(&derived_base) {
        bail!(
            "derived base must be disjoint from source vault: source={}, derived={}",
            source_root.display(),
            derived_base.display()
        );
    }
    if std::fs::read_dir(&derived_base)?.next().is_some() {
        bail!("derived base must be empty: {}", derived_base.display());
    }
    Ok((source_root, derived_base))
}

fn capture_snapshot(
    conn: &Connection,
    vault: &VaultLayout,
    reconcile_report: &ReconcileReport,
) -> Result<ColdSpaceSnapshot> {
    let paths = files::scan_md_files(vault)?;
    let source_kinds = load_source_kinds(conn)?;
    let rows = load_projection_rows(conn)?;
    let content_slugs = rows
        .iter()
        .map(|row| row.slug.clone())
        .collect::<BTreeSet<_>>();
    let collection_slugs = load_collection_slugs(conn)?;
    let expected_content = source_kinds
        .iter()
        .filter_map(|(slug, kind)| (kind == "block").then_some(slug.clone()))
        .collect::<BTreeSet<_>>();
    let expected_collections = source_kinds
        .iter()
        .filter_map(|(slug, kind)| (kind == "channel").then_some(slug.clone()))
        .collect::<BTreeSet<_>>();
    if content_slugs != expected_content {
        bail!(
            "content source/projection mismatch: source_only={:?}, projection_only={:?}",
            expected_content
                .difference(&content_slugs)
                .collect::<Vec<_>>(),
            content_slugs
                .difference(&expected_content)
                .collect::<Vec<_>>()
        );
    }
    if collection_slugs != expected_collections {
        bail!(
            "collection source/projection mismatch: source_only={:?}, projection_only={:?}",
            expected_collections
                .difference(&collection_slugs)
                .collect::<Vec<_>>(),
            collection_slugs
                .difference(&expected_collections)
                .collect::<Vec<_>>()
        );
    }

    let error_by_path = reconcile_report
        .errors
        .iter()
        .map(|error| (PathBuf::from(&error.path), format!("{:?}", error.kind)))
        .collect::<BTreeMap<_, _>>();
    let mut unsupported_sources = Vec::new();
    let mut classified = 0usize;
    for path in &paths {
        let relative = path
            .strip_prefix(vault.root())
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        let file_stem = path.file_stem().and_then(|value| value.to_str());
        if let Some(conflict) = file_stem.and_then(detect_icloud_conflict) {
            unsupported_sources.push(UnsupportedSource {
                path: relative,
                reason: format!("icloud_conflict:{conflict}"),
            });
            continue;
        }
        let slug = match vault.slug_for_path(path) {
            Ok(slug) => slug,
            Err(error) => {
                unsupported_sources.push(UnsupportedSource {
                    path: relative,
                    reason: format!("invalid_slug:{error}"),
                });
                continue;
            }
        };
        if source_kinds.contains_key(&slug) {
            classified += 1;
            continue;
        }
        let Some(reason) = error_by_path.get(path) else {
            bail!(
                "Markdown source has no typed classification: {}",
                path.display()
            );
        };
        unsupported_sources.push(UnsupportedSource {
            path: relative,
            reason: reason.clone(),
        });
    }
    if classified + unsupported_sources.len() != paths.len() {
        bail!("Markdown classification is not one-to-one");
    }

    let grid_count = index::count_grid_blocks(conn)?;
    let grid_snapshot = projection::read_grid_snapshot(conn, None, 0, grid_count.max(1), None)?;
    if grid_snapshot.has_more || grid_snapshot.blocks.len() != grid_count {
        bail!(
            "Grid projection is incomplete: rows={}, count={}, has_more={has_more}",
            grid_snapshot.blocks.len(),
            grid_count,
            has_more = grid_snapshot.has_more,
        );
    }
    let empty_fallbacks = grid_snapshot
        .blocks
        .iter()
        .filter(|block| block.fallback_label.trim().is_empty())
        .map(|block| block.slug.clone())
        .collect::<Vec<_>>();
    if !empty_fallbacks.is_empty() {
        bail!("Grid rows have empty fallback labels: {empty_fallbacks:?}");
    }

    let semantic_violations = rows
        .iter()
        .filter(|row| {
            !row.body_nonempty
                && row.url.is_some()
                && row.media_file.is_none()
                && row.card_kind != "link"
        })
        .map(|row| row.slug.clone())
        .collect::<Vec<_>>();
    if !semantic_violations.is_empty() {
        bail!("metadata-only links have non-link runtime semantics: {semantic_violations:?}");
    }
    let ready_without_manifest = rows
        .iter()
        .filter(|row| row.preview_state == "ready" && row.preview_manifest.is_none())
        .map(|row| row.slug.clone())
        .collect::<Vec<_>>();
    if !ready_without_manifest.is_empty() {
        bail!("ready rows have no preview manifest: {ready_without_manifest:?}");
    }
    let invalid_preview_contracts = rows
        .iter()
        .filter(|row| {
            row.preview_error_kind
                .as_deref()
                .is_some_and(|kind| !matches!(kind, "missing_source" | "browser_decode_required"))
        })
        .map(|row| {
            format!(
                "{}:{}",
                row.slug,
                row.preview_error_kind.as_deref().unwrap_or("unknown")
            )
        })
        .collect::<Vec<_>>();
    if !invalid_preview_contracts.is_empty() {
        bail!("invalid preview contract outcomes: {invalid_preview_contracts:?}");
    }

    let mut preview_states = BTreeMap::new();
    for row in &rows {
        *preview_states.entry(row.preview_state.clone()).or_insert(0) += 1;
    }
    let metadata_only_links = rows
        .iter()
        .filter(|row| {
            !row.body_nonempty
                && row.card_kind == "link"
                && row.url.is_some()
                && row.media_file.is_none()
        })
        .map(|row| row.slug.clone())
        .collect();

    Ok(ColdSpaceSnapshot {
        source_markdown: paths.len(),
        content_sources: expected_content.len(),
        collection_sources: expected_collections.len(),
        unsupported_sources,
        content_rows: content_slugs.len(),
        collection_rows: collection_slugs.len(),
        grid_order: grid_snapshot
            .blocks
            .iter()
            .map(|block| block.slug.clone())
            .collect(),
        visible_preview_manifests: grid_snapshot
            .blocks
            .iter()
            .filter(|block| block.preview_manifest.is_some())
            .count(),
        preview_states,
        metadata_only_links,
        rows,
        grid_snapshot,
    })
}

fn load_source_kinds(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut stmt =
        conn.prepare("SELECT slug, source_kind FROM source_index_state ORDER BY slug")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect::<std::result::Result<BTreeMap<_, _>, _>>()
        .context("load cold-space source classifications")
}

fn load_collection_slugs(conn: &Connection) -> Result<BTreeSet<String>> {
    let mut stmt = conn.prepare("SELECT tag FROM channels ORDER BY tag")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<std::result::Result<BTreeSet<_>, _>>()
        .context("load cold-space collection projections")
}

fn load_projection_rows(conn: &Connection) -> Result<Vec<ProjectionRow>> {
    let mut stmt = conn.prepare(
        "SELECT slug, block_type, card_kind, preview_state, preview_error_kind,
                preview_manifest, COALESCE(fallback_label, slug), url, media_file,
                CASE WHEN trim(COALESCE(body, '')) = '' THEN 0 ELSE 1 END
         FROM blocks
         ORDER BY slug",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectionRow {
            slug: row.get(0)?,
            block_type: row.get(1)?,
            card_kind: row.get(2)?,
            preview_state: row.get(3)?,
            preview_error_kind: row.get(4)?,
            preview_manifest: row.get(5)?,
            fallback_label: row.get(6)?,
            url: row.get(7)?,
            media_file: row.get(8)?,
            body_nonempty: row.get::<_, i64>(9)? != 0,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("load cold-space content projections")
}

fn source_fingerprint(root: &Path) -> Result<Vec<SourceFileFingerprint>> {
    fn visit(root: &Path, dir: &Path, result: &mut Vec<SourceFileFingerprint>) -> Result<()> {
        for entry in std::fs::read_dir(dir)
            .with_context(|| format!("read source directory: {}", dir.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                visit(root, &path, result)?;
            } else if file_type.is_file() {
                let metadata = entry.metadata()?;
                let modified_ns = metadata
                    .modified()
                    .unwrap_or(UNIX_EPOCH)
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                result.push(SourceFileFingerprint {
                    relative_path: path
                        .strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .into_owned(),
                    size: metadata.len(),
                    modified_ns,
                });
            }
        }
        Ok(())
    }

    let mut result = Vec::new();
    visit(root, root, &mut result)?;
    result.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn sanitized_fixture() -> (TempDir, TempDir) {
        let source = tempfile::tempdir().unwrap();
        let derived = tempfile::tempdir().unwrap();
        write(
            &source.path().join("ai-2027-3.md"),
            "---\ntype: link\ntitle: AI 2027\nurl: https://ai-2027.com\nsaved_at: 2026-03-12T00:00:00Z\n---\n",
        );
        write(
            &source.path().join("article.md"),
            "---\ntype: article\nsaved_at: 2026-03-11T00:00:00Z\n---\n# Article\n\nReadable text.",
        );
        write(
            &source.path().join("Library/nested-note.md"),
            "# Nested note\n\nA normal Obsidian note.",
        );
        write(
            &source.path().join("Design.md"),
            "---\ntype: channel\nposition: 1\nsaved_at: 2026-03-10T00:00:00Z\n---\n",
        );
        write(
            &source.path().join("image-card.md"),
            "---\ntype: image\nfile: image-card.png\nsaved_at: 2026-03-09T00:00:00Z\n---\n",
        );
        image::RgbImage::from_pixel(24, 16, image::Rgb([40, 80, 120]))
            .save(source.path().join("image-card.png"))
            .unwrap();
        write(
            &source.path().join("missing-media.md"),
            "---\ntype: image\nfile: missing-media.png\nsaved_at: 2026-03-08T00:00:00Z\n---\n",
        );
        write(
            &source.path().join("browser-preview.md"),
            "---\ntype: image\nfile: browser-preview.webp\nsaved_at: 2026-03-07T00:00:00Z\n---\n",
        );
        fs::write(
            source.path().join("browser-preview.webp"),
            b"browser-owned-decode",
        )
        .unwrap();
        write(
            &source.path().join("metadata-video.md"),
            "---\ntype: video\ntitle: Remote video\nurl: https://example.com/watch\nsaved_at: 2026-03-06T00:00:00Z\n---\n",
        );
        write(&source.path().join("empty-note.md"), "");
        (source, derived)
    }

    #[test]
    fn cold_cycles_classify_every_source_and_are_stable() {
        let (source, derived) = sanitized_fixture();
        let report = run_cold_space_audit(source.path(), derived.path(), 2).unwrap();
        let summary = report.summary();

        assert_eq!(summary.source_markdown, 9);
        assert_eq!(summary.content_sources, 8);
        assert_eq!(summary.collection_sources, 1);
        assert_eq!(summary.unsupported_sources, 0);
        assert_eq!(summary.metadata_only_links, 2);
        assert!(summary.stable_after_reopen);
        assert!(summary.stable_after_cache_reset);
        assert!(summary.source_unchanged);
        assert_eq!(
            report.cycles[0].first.grid_order,
            report.cycles[1].first.grid_order
        );

        let link = report.cycles[0]
            .settled
            .rows
            .iter()
            .find(|row| row.slug == "ai-2027-3")
            .unwrap();
        assert_eq!(link.block_type, "link");
        assert_eq!(link.card_kind, "link");
        assert_eq!(link.preview_state, "ready");
        assert!(link.media_file.is_none());

        let metadata_video = report.cycles[0]
            .settled
            .rows
            .iter()
            .find(|row| row.slug == "metadata-video")
            .unwrap();
        assert_eq!(metadata_video.block_type, "video");
        assert_eq!(metadata_video.card_kind, "link");
        assert_eq!(metadata_video.preview_state, "ready");

        let browser_preview = report.cycles[0]
            .settled
            .rows
            .iter()
            .find(|row| row.slug == "browser-preview")
            .unwrap();
        assert_eq!(browser_preview.preview_state, "failed");
        assert_eq!(
            browser_preview.preview_error_kind.as_deref(),
            Some("browser_decode_required")
        );
    }

    #[test]
    fn rejects_a_derived_store_inside_the_source_vault() {
        let (source, _derived) = sanitized_fixture();
        let unsafe_derived = source.path().join("derived");
        fs::create_dir(&unsafe_derived).unwrap();

        let error = run_cold_space_audit(source.path(), &unsafe_derived, 2).unwrap_err();

        assert!(error.to_string().contains("must be disjoint"));
        assert!(!unsafe_derived.join("cycle-1").exists());
    }

    #[test]
    fn rejects_nonempty_derived_base_without_deleting_it() {
        let (source, derived) = sanitized_fixture();
        fs::write(derived.path().join("keep.txt"), b"keep").unwrap();

        let error = run_cold_space_audit(source.path(), derived.path(), 2).unwrap_err();

        assert!(error.to_string().contains("must be empty"));
        assert_eq!(fs::read(derived.path().join("keep.txt")).unwrap(), b"keep");
    }
}
