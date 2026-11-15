//! How long each step of one card merge took (SPEC_CARD_MERGE.md, «Замер
//! слияния»). A measurement only: it changes neither the order of the steps
//! nor what they do. The command hands it back with its result, and the page
//! writes one line of it to `Mine.log`, with its own steps up to the feed
//! drawn again. Numbers and step names only: no path, no title, no text.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::storage::source_mutation::CommitPhase;

/// One step of a merge, in the order the command runs them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MergeStep {
    /// Every edit session of the space writes its edits first (SPEC_EDITING.md, Л4.7).
    FlushEdits,
    /// The space's index and layout, held by any other work of the space.
    SpaceLock,
    /// The folders new files go to.
    Layout,
    /// The index brought up to the files of the whole space (Н5).
    IndexUpToFiles,
    /// The merged cards' notes read and parsed.
    ReadSources,
    /// A free name for the merged card.
    MergedName,
    /// Every file path of the space, for the links that move.
    ScanSpaceFiles,
    /// The merged card's text.
    Compose,
    /// The notes that link a merged card, read and rewritten in memory.
    ReferenceWrites,
    /// The watcher told to pass over the paths the merge writes.
    SuppressPaths,
    /// The writes staged next to their files.
    Stage,
    /// The merged card's note written and the linking notes rewritten.
    CommitWrites,
    /// The merged cards' notes moved to the Trash.
    CommitTrash,
    /// The index rows written and their transaction committed.
    CommitIndex,
    /// The copies kept for a rollback cleaned up.
    CommitFinalize,
    /// The merged card's pictures made.
    MergedPreview,
    /// The pictures of the notes whose links were rewritten made again.
    ReferencePreviews,
    /// The merged cards' pictures and article audio removed.
    SourcePictures,
    /// The merged card read back from the index.
    ReadMerged,
    /// The tabs of the space told of the change.
    Announce,
}

impl MergeStep {
    /// Every step, in the order the command runs them.
    pub const ALL: [MergeStep; 20] = [
        MergeStep::FlushEdits,
        MergeStep::SpaceLock,
        MergeStep::Layout,
        MergeStep::IndexUpToFiles,
        MergeStep::ReadSources,
        MergeStep::MergedName,
        MergeStep::ScanSpaceFiles,
        MergeStep::Compose,
        MergeStep::ReferenceWrites,
        MergeStep::SuppressPaths,
        MergeStep::Stage,
        MergeStep::CommitWrites,
        MergeStep::CommitTrash,
        MergeStep::CommitIndex,
        MergeStep::CommitFinalize,
        MergeStep::MergedPreview,
        MergeStep::ReferencePreviews,
        MergeStep::SourcePictures,
        MergeStep::ReadMerged,
        MergeStep::Announce,
    ];
}

/// How long one step took, in milliseconds to a tenth.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, specta::Type)]
pub struct MergeStepTime {
    pub step: MergeStep,
    pub ms: f64,
}

/// The steps one merge took, with the size of the merge.
#[derive(Debug, Clone, Default, PartialEq, Serialize, specta::Type)]
pub struct MergeTiming {
    /// The cards merged.
    pub cards: u32,
    /// The pictures the merged cards name: their `file` and `thumbnail`
    /// when those are images, and every image their bodies embed or link.
    pub pictures: u32,
    /// The steps run, in order; a step run twice adds up.
    pub steps: Vec<MergeStepTime>,
}

impl MergeTiming {
    /// Run `work` as `step` and add its time.
    pub fn time<T>(&mut self, step: MergeStep, work: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let outcome = work();
        self.add(step, started.elapsed());
        outcome
    }

    /// Add `took` to `step`.
    pub fn add(&mut self, step: MergeStep, took: Duration) {
        let ms = took.as_secs_f64() * 1000.0;
        match self.steps.iter_mut().find(|entry| entry.step == step) {
            Some(entry) => entry.ms = round_tenth(entry.ms + ms),
            None => self.steps.push(MergeStepTime { step, ms: round_tenth(ms) }),
        }
    }
}

impl From<CommitPhase> for MergeStep {
    fn from(phase: CommitPhase) -> Self {
        match phase {
            CommitPhase::Write => MergeStep::CommitWrites,
            CommitPhase::Trash => MergeStep::CommitTrash,
            CommitPhase::Index => MergeStep::CommitIndex,
            CommitPhase::Finalize => MergeStep::CommitFinalize,
        }
    }
}

fn round_tenth(ms: f64) -> f64 {
    (ms * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_is_timed_once_in_order_and_a_second_run_adds_up() {
        let mut timing = MergeTiming::default();
        let answer = timing.time(MergeStep::SpaceLock, || 7);
        assert_eq!(answer, 7);
        timing.add(MergeStep::CommitTrash, Duration::from_micros(1_250));
        timing.add(MergeStep::Announce, Duration::from_micros(400));
        timing.add(MergeStep::Announce, Duration::from_micros(400));
        let steps: Vec<_> = timing.steps.iter().map(|entry| entry.step).collect();
        assert_eq!(steps, vec![MergeStep::SpaceLock, MergeStep::CommitTrash, MergeStep::Announce]);
        assert_eq!(timing.steps[1].ms, 1.3);
        assert_eq!(timing.steps[2].ms, 0.8);
    }

    #[test]
    fn steps_cross_to_the_page_by_their_names() {
        let names: Vec<String> = MergeStep::ALL
            .iter()
            .map(|step| serde_json::to_string(step).unwrap().trim_matches('"').to_string())
            .collect();
        assert_eq!(names.first().map(String::as_str), Some("flush_edits"));
        assert_eq!(names.last().map(String::as_str), Some("announce"));
        assert!(names.contains(&"index_up_to_files".to_string()));
    }
}
