export const SIDEBAR_ROW_HOVER_SEAM_ENABLED = false;

/// Article audio (spoken article text) is switched off.
///
/// The implementation stays in the tree on both sides. On the backend the IPC
/// commands and the Swift synthesis helper are behind the `article-audio` Cargo
/// feature, which is not in `default`, so nothing is compiled or bundled; this
/// flag is the matching frontend switch that keeps the controls unmounted.
/// See SPEC_ARTICLE_AUDIO.md for how to turn the feature back on.
export const ARTICLE_AUDIO_ENABLED = false;
