//! Generated TypeScript contract for Rust-owned IPC DTOs.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use specta::TypeCollection;
use specta_typescript::{BigIntExportBehavior, Typescript};

use crate::commands::blocks::{
    CreateBlockParams, CreateMediaAssetCardParams, DeleteBlockMedia, DeleteBlockPlan,
    DeleteMediaAssetKind, DeleteMediaAssetPlan, DeleteTextSelectionParams,
    ExtractInlineMediaParams, ExtractTextSelectionParams, InlineMediaExtractError,
    MediaAssetActionError, MediaAssetMutationResult, MediaAssetReferenceBlock,
    MediaAssetReferenceKind, MergeBlocksError, MergeBlocksResult, RemoveMediaAssetFromCardParams,
    RenameBlockError, RenameBlockResult, RenameMediaAssetParams, TextSelectionExtractError,
};
use crate::commands::channels::{
    ChannelDto, ChannelPreviewsSnapshot, PreviewItem, TaxonomySnapshot,
};
use crate::commands::clipper_recovery::{
    ClipperRecoveryItem, ClipperRecoveryKind, RecoveredClipperBlock,
};
use crate::commands::import::{ArenaChannelInfo, ImportChannelRequest};
use crate::commands::native_shell_smoke::NativeShellSmokeReport;
use crate::commands::settings::{
    DeleteOrphanResult, OrphanMedia, OrphanMediaBatchRequest, PromoteOrphanResult, SpaceStats,
};
use crate::commands::state::CommandError;
use crate::commands::vault::{UnavailableVault, VaultOpenResult, VaultWriteLayoutDto};
use crate::import::importer::{ImportChannelResult, ImportProgress};
use crate::storage::article_audio::{ArticleAudioState, ArticleAudioStatus};
use crate::storage::graph::{
    GraphLink, GraphLinkKind, GraphNode, GraphNodeKind, GraphOptions, GraphScope, GraphScopeKind,
    GraphSnapshot, GraphTruncationReason,
};
use crate::storage::index::{
    FeedPlaybackContainer, FeedPlaybackDescriptor, FeedPlaybackKind, FeedPlaybackProfile,
    FeedPreviewKind, FeedPreviewManifest, FeedPreviewTile, IndexedBlock, LightBlock, SearchMatch,
    SearchMatchField, SearchMatchKind, SearchTextRange, TagCount, ThumbFormat,
};
use crate::storage::projection::{GridSnapshot, ProjectionRevision};
use crate::storage::search_projection::{SearchPageToken, SearchRevision, SearchSnapshot};
use crate::storage::vault_stats::VaultStats;
use crate::watcher::handler::ScanResult;

pub fn export_types(check_only: bool) -> Result<()> {
    let mut types = TypeCollection::default();
    types
        .register::<IndexedBlock>()
        .register::<LightBlock>()
        .register::<FeedPreviewKind>()
        .register::<FeedPreviewTile>()
        .register::<FeedPreviewManifest>()
        .register::<FeedPlaybackContainer>()
        .register::<FeedPlaybackKind>()
        .register::<FeedPlaybackProfile>()
        .register::<FeedPlaybackDescriptor>()
        .register::<ArticleAudioStatus>()
        .register::<ArticleAudioState>()
        .register::<SearchMatchField>()
        .register::<SearchMatchKind>()
        .register::<SearchTextRange>()
        .register::<SearchMatch>()
        .register::<TagCount>()
        .register::<ThumbFormat>()
        .register::<GridSnapshot>()
        .register::<ProjectionRevision>()
        .register::<SearchPageToken>()
        .register::<SearchRevision>()
        .register::<SearchSnapshot>()
        .register::<GraphNodeKind>()
        .register::<GraphLinkKind>()
        .register::<GraphScopeKind>()
        .register::<GraphScope>()
        .register::<GraphOptions>()
        .register::<GraphTruncationReason>()
        .register::<GraphNode>()
        .register::<GraphLink>()
        .register::<GraphSnapshot>()
        .register::<ChannelDto>()
        .register::<TaxonomySnapshot>()
        .register::<PreviewItem>()
        .register::<ChannelPreviewsSnapshot>()
        .register::<RenameBlockResult>()
        .register::<CreateBlockParams>()
        .register::<ExtractInlineMediaParams>()
        .register::<CreateMediaAssetCardParams>()
        .register::<RenameMediaAssetParams>()
        .register::<MediaAssetReferenceKind>()
        .register::<RemoveMediaAssetFromCardParams>()
        .register::<ExtractTextSelectionParams>()
        .register::<DeleteTextSelectionParams>()
        .register::<DeleteMediaAssetKind>()
        .register::<DeleteBlockMedia>()
        .register::<DeleteBlockPlan>()
        .register::<MergeBlocksResult>()
        .register::<MediaAssetMutationResult>()
        .register::<MediaAssetReferenceBlock>()
        .register::<DeleteMediaAssetPlan>()
        .register::<RenameBlockError>()
        .register::<InlineMediaExtractError>()
        .register::<MediaAssetActionError>()
        .register::<TextSelectionExtractError>()
        .register::<MergeBlocksError>()
        .register::<VaultStats>()
        .register::<ScanResult>()
        .register::<VaultOpenResult>()
        .register::<VaultWriteLayoutDto>()
        .register::<UnavailableVault>()
        .register::<ClipperRecoveryKind>()
        .register::<ClipperRecoveryItem>()
        .register::<RecoveredClipperBlock>()
        .register::<ArenaChannelInfo>()
        .register::<ImportChannelRequest>()
        .register::<ImportChannelResult>()
        .register::<ImportProgress>()
        .register::<NativeShellSmokeReport>()
        .register::<CommandError>()
        .register::<SpaceStats>()
        .register::<OrphanMedia>()
        .register::<OrphanMediaBatchRequest>()
        .register::<PromoteOrphanResult>()
        .register::<DeleteOrphanResult>();

    let output = Typescript::default()
        .bigint(BigIntExportBehavior::Number)
        .export(&types)
        .context("failed to render TypeScript IPC bindings")?;
    let output = output
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let output = format!("{}\n", output.trim_end());
    let output_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/types/generated.ts");

    if check_only {
        let current = std::fs::read_to_string(&output_path)
            .with_context(|| format!("failed to read {}", output_path.display()))?;
        if current != output {
            bail!(
                "generated IPC bindings are stale; run `cargo run -p mine --bin export-bindings`"
            );
        }
        return Ok(());
    }

    std::fs::write(&output_path, output)
        .with_context(|| format!("failed to write {}", output_path.display()))?;
    Ok(())
}
